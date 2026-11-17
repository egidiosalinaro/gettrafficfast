import type { SupabaseClient } from "@supabase/supabase-js";
import type { CitationAnswer, CitationProvider } from "@/lib/providers/citations/types";
import { CitationProviderError } from "@/lib/providers/citations/types";
import { getCitationProviders } from "@/lib/providers/citations/registry";
import { StepIncomplete, type Workflow } from "@/lib/jobs/types";
import { businessIdentity, parseAeoSettings } from "@/lib/visibility/settings";
import { queryFingerprint } from "@/lib/visibility/queries";
import { judgeAnswer, PROBE_VERSION, type KnownCompetitor } from "@/lib/visibility/verdict";
import { mapProbe, PROBE_COLUMNS, AEO_RUN, runCostUsd } from "@/lib/visibility/store";
import { summarizeRun } from "@/lib/visibility/summary";
import { findPlacesFromRun } from "@/lib/visibility/places";

/**
 * One AI Visibility run, as a durable job.
 *
 *   plan   — freeze the set: which questions, which engines, one pending
 *            probe per pair. Nothing is asked yet.
 *   probe  — fulfil pending probes a few at a time until the tick's deadline,
 *            then yield; the next tick resumes at the same step and only ever
 *            sees what is still pending, so a probe is never paid for twice.
 *   finish — totals on the run row.
 *   places — unless the site turned it off (`placesFromSources`, on by
 *            default): the pages the answers cited where the site was not
 *            cited become candidates in the Replies inbox
 *            (lib/visibility/places.ts). No model and no new probe; a few
 *            free lookups, capped. The run is already completed when this
 *            step starts, so nothing here can change what was measured.
 *            Every run passes here, whoever started it: the schedule, Run
 *            now and `run_visibility_check` all go through `startRun`.
 *
 * Orchestration is code. There is no agent here: asking an engine is a
 * provider call and deciding "were we cited" is a pure function, and putting a
 * model between the two would make the measurement depend on a model's mood.
 */

/** Probes in flight at once. Engines rate-limit; three is polite and fast enough. */
const CONCURRENCY = 3;

/** Wall clock for one engine call. A grounded answer takes 5–30 s. */
const PROBE_TIMEOUT_MS = 45_000;

/** Below this much tick time left, do not start another probe. */
const MIN_TIME_FOR_PROBE_MS = 12_000;

/** A transient failure (429, 5xx, timeout) is asked again this many times. */
const MAX_PROBE_ATTEMPTS = 2;

/** Rows fetched per loop iteration. */
const PAGE = 12;

/**
 * Below this much tick time left, the places step waits for the next tick
 * instead of starting. Its lookups stop when time runs short, and a source
 * not read back is left out for good (the step does not run twice), so a
 * run whose probes used up the tick would otherwise lose the page behind
 * every redirect. A fresh tick has about 40 s.
 */
export const PLACES_MIN_TIME_MS = 15_000;

export { AEO_RUN };

interface RunInput {
  runId: string;
  businessId: string;
}

function readInput(input: Record<string, unknown>): RunInput {
  const runId = typeof input.runId === "string" ? input.runId : "";
  const businessId = typeof input.businessId === "string" ? input.businessId : "";
  if (!runId || !businessId) throw new Error("aeo-run needs runId and businessId");
  return { runId, businessId };
}

async function failRun(supabase: SupabaseClient, runId: string, error: string): Promise<void> {
  await supabase
    .from("aeo_runs")
    .update({ status: "failed", error: error.slice(0, 500), finished_at: new Date().toISOString() })
    .eq("id", runId);
}

/** Engines the business asked for, out of the ones the platform has keys for. */
export function selectEngines(
  configured: CitationProvider[],
  wanted: string[]
): CitationProvider[] {
  if (wanted.length === 0) return configured;
  return configured.filter((p) => wanted.includes(p.name));
}

function withTimeout(ms: number, parent?: AbortSignal): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`probe timed out after ${ms} ms`)), ms);
  parent?.addEventListener("abort", () => controller.abort(parent.reason), { once: true });
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

interface PendingProbe {
  id: string;
  query: string;
  engine: string;
  attempts: number | null;
}

export const aeoRunWorkflow: Workflow = {
  type: AEO_RUN,
  steps: [
    {
      name: "plan",
      async run(ctx) {
        const { runId, businessId } = readInput(ctx.input);
        const { supabase } = ctx;

        const { data: business } = await supabase
          .from("businesses")
          .select("id, user_id, name, website_url, content_language, aeo_settings")
          .eq("id", businessId)
          .maybeSingle();
        if (!business) {
          await failRun(supabase, runId, "Business not found");
          return { planned: 0, reason: "no_business" };
        }

        const settings = parseAeoSettings(business.aeo_settings);
        const engines = selectEngines(getCitationProviders(), settings.engines);
        if (engines.length === 0) {
          await failRun(
            supabase,
            runId,
            settings.engines.length > 0
              ? "None of the selected engines is configured on this platform."
              : "No answer engine is configured on this platform."
          );
          return { planned: 0, reason: "no_engine" };
        }

        const { data: queries } = await supabase
          .from("aeo_queries")
          .select("id, query, cluster")
          .eq("business_id", businessId)
          .eq("enabled", true)
          .order("created_at", { ascending: true })
          .limit(settings.maxQueriesPerRun);
        const set = (queries ?? []) as Array<{ id: string; query: string; cluster: string | null }>;
        if (set.length === 0) {
          await failRun(supabase, runId, "No enabled queries: add at least one in Configuration.");
          return { planned: 0, reason: "no_queries" };
        }

        // One pending row per (query, engine). Idempotent: re-running the plan
        // after a crash finds them already there and adds nothing.
        const rows = set.flatMap((q) =>
          engines.map((engine) => ({
            run_id: runId,
            user_id: business.user_id as string,
            business_id: businessId,
            query_id: q.id,
            query: q.query,
            cluster: q.cluster,
            engine: engine.name,
            status: "pending",
            cited: null,
            attempts: 0,
            probe_version: PROBE_VERSION,
          }))
        );
        const { error } = await supabase
          .from("aeo_probes")
          .upsert(rows, { onConflict: "run_id,query,engine", ignoreDuplicates: true });
        if (error) throw new Error(`aeo probe plan failed: ${error.message}`);

        await supabase
          .from("aeo_runs")
          .update({
            engines: engines.map((e) => e.name),
            query_count: set.length,
            query_fingerprint: queryFingerprint(set.map((q) => q.query)),
            planned_probes: rows.length,
            probe_version: PROBE_VERSION,
          })
          .eq("id", runId);

        return { planned: rows.length, queries: set.length, engines: engines.map((e) => e.name) };
      },
    },
    {
      name: "probe",
      async run(ctx) {
        const { runId, businessId } = readInput(ctx.input);
        const { supabase } = ctx;

        const { data: run } = await supabase
          .from("aeo_runs")
          .select("id, status")
          .eq("id", runId)
          .maybeSingle();
        if (!run || run.status !== "running") return { skipped: true };

        const [{ data: business }, { data: competitorRows }] = await Promise.all([
          supabase
            .from("businesses")
            .select("name, website_url, content_language, aeo_settings")
            .eq("id", businessId)
            .maybeSingle(),
          supabase
            .from("competitors")
            .select("domain, name")
            .eq("business_id", businessId)
            .order("last_seen_at", { ascending: false })
            .limit(50),
        ]);
        if (!business) {
          await failRun(supabase, runId, "Business not found");
          return { skipped: true };
        }

        const settings = parseAeoSettings(business.aeo_settings);
        const identity = businessIdentity(
          { name: business.name as string | null, website_url: business.website_url as string | null },
          settings
        );
        const known: KnownCompetitor[] = (competitorRows ?? []).map((c) => ({
          domain: c.domain as string,
          name: c.name as string,
        }));
        const language = (business.content_language as string) ?? "en";
        const providers = new Map(getCitationProviders().map((p) => [p.name, p]));

        let probed = 0;
        let cited = 0;
        let errors = 0;
        let pauseFor = 0;

        const deadline = ctx.deadline ?? Date.now() + 40_000;
        const timeLeft = () => deadline - Date.now();

        const settle = async (pending: PendingProbe) => {
          const provider = providers.get(pending.engine);
          const startedAt = Date.now();
          const priorAttempts = pending.attempts ?? 0;
          if (!provider) {
            await supabase
              .from("aeo_probes")
              .update({
                status: "error",
                cited: null,
                error: `Engine "${pending.engine}" is not configured`,
                attempts: priorAttempts + 1,
                checked_at: new Date().toISOString(),
              })
              .eq("id", pending.id);
            errors += 1;
            return;
          }

          let answer: CitationAnswer;
          const timeout = withTimeout(
            Math.min(PROBE_TIMEOUT_MS, Math.max(5_000, timeLeft() - 3_000)),
            ctx.signal
          );
          try {
            answer = await provider.probe({ query: pending.query, language, signal: timeout.signal });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const providerError = err instanceof CitationProviderError ? err : null;
            const timedOut = /timed out|abort/i.test(message);
            const transient = providerError?.transient || timedOut;
            const attempts = priorAttempts + 1;
            if (providerError?.retryAfterSeconds) {
              pauseFor = Math.max(pauseFor, Math.min(providerError.retryAfterSeconds, 300));
            }

            // Ask again later when it might succeed; record the failure when
            // it will not. Either way the row keeps what happened.
            const giveUp = !transient || attempts >= MAX_PROBE_ATTEMPTS;
            await supabase
              .from("aeo_probes")
              .update({
                status: giveUp ? "error" : "pending",
                cited: null,
                error: message.slice(0, 500),
                attempts,
                latency_ms: Date.now() - startedAt,
                ...(giveUp ? { checked_at: new Date().toISOString() } : {}),
              })
              .eq("id", pending.id);
            if (giveUp) errors += 1;
            return;
          } finally {
            timeout.clear();
          }

          const verdict = judgeAnswer(answer, identity, known);
          const { error } = await supabase
            .from("aeo_probes")
            .update({
              status: verdict.status,
              cited: verdict.cited,
              source_url: verdict.sourceUrl,
              position: verdict.position,
              mentioned: verdict.mentioned,
              answer_excerpt: verdict.excerpt,
              sources: verdict.sources,
              competitors: verdict.competitors,
              model: answer.model ?? null,
              cost_usd: answer.costUsd ?? null,
              latency_ms: Date.now() - startedAt,
              attempts: priorAttempts + 1,
              error: null,
              probe_version: PROBE_VERSION,
              checked_at: new Date().toISOString(),
            })
            .eq("id", pending.id);
          if (error) throw new Error(`aeo probe update failed: ${error.message}`);
          probed += 1;
          if (verdict.cited) cited += 1;
        };

        // Page through pending probes until the clock says stop. Each pass
        // re-reads the table, so a row another worker settled is not redone.
        for (;;) {
          if (pauseFor > 0) break;
          if (timeLeft() < MIN_TIME_FOR_PROBE_MS) break;

          const { data: rows, error } = await supabase
            .from("aeo_probes")
            .select("id, query, engine, attempts")
            .eq("run_id", runId)
            .eq("status", "pending")
            .order("created_at", { ascending: true })
            .limit(PAGE);
          if (error) throw new Error(`aeo probe read failed: ${error.message}`);
          const pending = (rows ?? []) as PendingProbe[];
          if (pending.length === 0) break;

          let cursor = 0;
          const worker = async () => {
            while (cursor < pending.length && timeLeft() >= MIN_TIME_FOR_PROBE_MS && pauseFor === 0) {
              const next = pending[cursor];
              cursor += 1;
              await settle(next);
            }
          };
          await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker));
          // A page settled in full and time remains: loop and read the next.
          if (cursor < pending.length) break;
        }

        const { count: remaining } = await supabase
          .from("aeo_probes")
          .select("id", { count: "exact", head: true })
          .eq("run_id", runId)
          .eq("status", "pending");

        if ((remaining ?? 0) > 0) {
          throw new StepIncomplete(
            `${remaining} probes still pending`,
            pauseFor > 0 ? pauseFor : 0
          );
        }

        return { probed, cited, errors };
      },
    },
    {
      name: "finish",
      async run(ctx) {
        const { runId } = readInput(ctx.input);
        const { supabase } = ctx;

        const { data: run } = await supabase
          .from("aeo_runs")
          .select("id, status")
          .eq("id", runId)
          .maybeSingle();
        if (!run || run.status !== "running") return { skipped: true };

        const { data: rows } = await supabase
          .from("aeo_probes")
          .select(`${PROBE_COLUMNS}, cost_usd`)
          .eq("run_id", runId);
        const probeRows = (rows ?? []) as Record<string, unknown>[];
        const summary = summarizeRun({ id: runId }, probeRows.map(mapProbe));

        // Completed, whatever the errors: the probes carry them one by one and
        // the dashboard shows coverage. A run only "fails" when it could not
        // start (no queries, no engine) or the job itself gave up.
        await supabase
          .from("aeo_runs")
          .update({
            status: "completed",
            cost_usd: runCostUsd(probeRows),
            finished_at: new Date().toISOString(),
            error:
              summary.errors > 0 && summary.valid === 0
                ? "Every probe failed. Check the engine configuration and try again."
                : null,
          })
          .eq("id", runId);

        // No cost here: a step's output is the job's result, which get_job
        // returns to the customer. The estimate stays on the run row.
        return {
          planned: summary.planned,
          valid: summary.valid,
          cited: summary.cited,
          invalid: summary.invalid,
          errors: summary.errors,
        };
      },
    },
    {
      name: "places",
      async run(ctx) {
        const { runId, businessId } = readInput(ctx.input);
        const { supabase } = ctx;

        const { data: business } = await supabase
          .from("businesses")
          .select("user_id, aeo_settings")
          .eq("id", businessId)
          .maybeSingle();
        if (!business) return { skipped: "no_business" };
        // On unless the owner turned it off. Free: a place is a row to read,
        // and the draft it may lead to waits for a person's tap.
        if (!parseAeoSettings(business.aeo_settings).placesFromSources) return { skipped: "off" };
        if (ctx.deadline !== undefined && ctx.deadline - Date.now() < PLACES_MIN_TIME_MS) {
          throw new StepIncomplete("not enough time left in this tick to read the sources back");
        }

        const result = await findPlacesFromRun({
          supabase,
          admin: supabase,
          userId: business.user_id as string,
          businessId,
          runId,
          deadline: ctx.deadline,
          signal: ctx.signal,
        });
        // A run that failed, or planned nothing, has no answers to read.
        if (!result.ok) return { skipped: result.code };
        return {
          candidates: result.candidates,
          created: result.created,
          linked: result.linked,
          deferred: result.deferred,
          dropped: result.dropped,
          rejected: result.rejected,
        };
      },
    },
  ],

  async onFailure({ job, supabase, error }) {
    const runId = typeof job.input.runId === "string" ? job.input.runId : null;
    if (!runId) return;
    await supabase
      .from("aeo_runs")
      .update({ status: "failed", error: error.slice(0, 500), finished_at: new Date().toISOString() })
      .eq("id", runId)
      .eq("status", "running");
  },
};
