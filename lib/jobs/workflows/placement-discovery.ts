import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import { createBudget } from "@/lib/agents/contract";
import { runAgent, supabaseRecorder } from "@/lib/agents/runner";
import { placementQualifyAgent } from "@/lib/agents/placement-qualify";
import { getDiscoveryProviders } from "@/lib/providers/discovery/registry";
import { DiscoveryProviderError, type DiscoveryProvider } from "@/lib/providers/discovery/types";
import { domainOf } from "@/lib/providers/serp/types";
import { topicsFor } from "@/lib/placements/expertise";
import {
  buildQueries,
  prefilter,
  recanonicalizeLegacyTargets,
  storeTargets,
} from "@/lib/placements/discovery";
import {
  angleIsPitch,
  applyExpiry,
  applyRuleRejections,
  applyVerdicts,
  loadRedditArchivedBelow,
  pickFairShare,
  toThreads,
  type TargetRow,
} from "@/lib/placements/qualification";
import { dateUndatedTargets, withUrlDate } from "@/lib/placements/post-dates";
import { PostDateLookup } from "@/lib/providers/post-dates";
import { parseAeoSettings } from "@/lib/visibility/settings";
import { parseVoiceSettings } from "@/lib/voice/settings";
import { StepIncomplete, type StepContext, type Workflow } from "@/lib/jobs/types";
import { runBounded, type Admission } from "@/lib/jobs/bounded";

/**
 * Off-site discovery and qualification for one business, as a durable job.
 *
 *   queries              — what to search for, from the site's own keywords,
 *                          entities and niche. Free.
 *   discover:<provider>  — one step per surface, so a provider that is slow
 *                          or rate-limited is checkpointed on its own and a
 *                          resumed job never re-pays a finished one. A
 *                          provider that is not configured is skipped, and
 *                          the others carry on: Reddit's API being absent
 *                          leaves Reddit to the web search.
 *   recanonicalize       — stored `web` pages whose host the canonicaliser
 *                          has since learned move to their real identity.
 *   dates                — rows stored without a date get one by the free
 *                          methods: the URL (an X or LinkedIn id), then the
 *                          platform's keyless API, capped per source; then
 *                          a backfill of open undated rows, oldest first.
 *   rules                — deterministic rejections, no model; and the
 *                          time-only rules again over the rows a person
 *                          could still act on, so a Reddit thread that
 *                          archived since it was qualified leaves the inbox
 *                          with the rule named.
 *   qualify              — the agent, on what survived, in budgeted batches
 *                          run QUALIFY_CONCURRENCY at a time and written in
 *                          order, so the rows end as a sequential run leaves
 *                          them;
 *                          the run's cap is shared out per surface, so a
 *                          platform whose API knows dates never starves the
 *                          ones a web search found without one. Rows already
 *                          qualified with an angle that is a product pitch
 *                          are judged again, behind the new finds, so the
 *                          inbox is not left holding briefs for adverts.
 *
 * Nothing here posts anything. The output is rows a person will read.
 */

export const PLACEMENT_DISCOVERY = "placement-discovery";

/** The surfaces a step exists for. A new provider is a new entry here. */
export const DISCOVERY_STEP_PROVIDERS = ["reddit", "github", "web-search"] as const;

/** Search queries per business per run. */
const MAX_QUERIES = 8;

/**
 * Per-provider ceiling on those queries. GitHub makes two requests per query
 * and allows eight a minute without a token, so it takes the four most
 * specific queries and never trips its own limit; the others take them all.
 */
const QUERY_CAP: Record<(typeof DISCOVERY_STEP_PROVIDERS)[number], number> = {
  reddit: MAX_QUERIES,
  github: 4,
  "web-search": MAX_QUERIES,
};

/** Results per query per provider. */
const PER_QUERY = 15;

/** Anything older is not read, or answered, again. Per-kind windows tighten this later. */
const MAX_AGE_DAYS = 365;

/** Wall clock per provider call. */
const SEARCH_TIMEOUT_MS = 25_000;

/**
 * The dates step's wall clock: free requests of 4 s at most, four at a
 * time, stop starting after this long. What is left waits for the next run.
 */
const DATES_BUDGET_MS = 40_000;
/** Time the dates step leaves before the invocation's deadline, for its writes. */
const DATES_RESERVE_MS = 15_000;

/**
 * Discovered rows the rules look at per run, newest first. Rules are pure and
 * free, so this only bounds the update round-trips; a full sweep can store a
 * few hundred rows (eight queries, five web scopes, two GitHub searches).
 */
const MAX_RULES_ROWS = 400;

/**
 * Discovered rows the qualify step draws from, most recently seen first, so
 * every surface a sweep found is in the pool the fair share picks from.
 */
const MAX_QUALIFY_POOL = 300;

/**
 * Survivors the agent judges per run, and how many per call. Sized to what a
 * weekly sweep leaves after the rules, across every surface: a cap far below
 * that only grows a "found, not judged" backlog nobody ever sees. The dollar
 * budget below still holds whatever this number says.
 */
const MAX_TARGETS_PER_RUN = 120;
const BATCH_SIZE = 10;

/** Dollars per business per run. The budget throws rather than overspending. */
const BUDGET_USD = 0.5;

/** Time a qualification batch is assumed to need before the deadline. */
const BATCH_TIME_MS = 25_000;

/**
 * Qualification batches in flight at once. 2026-11-12: a batch of ten took
 * about 30 s on the fast tier and a run judged twelve, one after the other.
 * Six at a time is two rounds for a full cap; the model provider takes far
 * more than six requests at once, and a refusal (a rate limit, the billing
 * pause) stops new starts at once.
 */
export const QUALIFY_CONCURRENCY = 6;

/**
 * What one batch is assumed to cost while it is in flight, so the batches
 * started together cannot overrun the budget: measured $0.003-0.004 a batch
 * on 2026-11-12, assumed $0.01.
 */
export const BATCH_COST_ESTIMATE_USD = 0.01;

/**
 * Whether the next qualification batch may start. Out of time: nothing more
 * starts. Otherwise a batch starts while the budget left covers it beside
 * the ones already in flight; with none in flight it starts as the
 * sequential loop did (the runner refuses it when the budget is gone).
 */
export function qualifyAdmission(params: { msLeft: number; remainingUsd: number; inFlight: number }): Admission {
  if (params.msLeft < BATCH_TIME_MS) return "stop";
  if (params.inFlight === 0) return "start";
  return params.remainingUsd - params.inFlight * BATCH_COST_ESTIMATE_USD >= BATCH_COST_ESTIMATE_USD ? "start" : "wait";
}

/**
 * The qualify step's progress on the job row, for the inbox's "Judging 23 of
 * 60…" (lib/placements/discovery-progress.ts). The worker replaces `result`
 * with the step outputs when the job completes. A failed write costs the
 * line on screen, never the run.
 */
async function writeQualifyProgress(ctx: StepContext, judged: number, total: number): Promise<void> {
  try {
    await ctx.supabase
      .from("jobs")
      .update({ result: { progress: { step: "qualify", judged, total } } })
      .eq("id", ctx.job.id);
  } catch {
    // The line is a courtesy.
  }
}

interface Input {
  businessId: string;
  /** False to skip the search and only judge the backlog. */
  discover: boolean;
}

function readInput(input: Record<string, unknown>): Input {
  const businessId = typeof input.businessId === "string" ? input.businessId : "";
  if (!businessId) throw new Error("placement-discovery needs businessId");
  return { businessId, discover: input.discover !== false };
}

export interface BusinessRow {
  id: string;
  user_id: string;
  name: string | null;
  niche: string | null;
  website_url: string | null;
  content_language: string | null;
  aeo_settings?: unknown;
  voice_settings?: unknown;
}

export async function loadBusiness(supabase: SupabaseClient, id: string): Promise<BusinessRow | null> {
  const { data } = await supabase
    .from("businesses")
    .select("id, user_id, name, niche, website_url, content_language, aeo_settings, voice_settings")
    .eq("id", id)
    .maybeSingle();
  return (data as BusinessRow | null) ?? null;
}

/** Every name the business goes by, so an angle that pitches it by name is caught. */
export function businessBrandNames(business: { name: string | null; aeo_settings?: unknown }): string[] {
  return [business.name ?? "", ...parseAeoSettings(business.aeo_settings).brandNames].filter(Boolean);
}

export const TARGET_COLUMNS =
  "id, surface, kind, external_id, url, title, excerpt, community, posted_at, score, comment_count, found_for, last_seen_at";

/**
 * Open rows the time-only rules look at again per run, oldest date first
 * (unknown dates after known ones): the rows most likely to have expired.
 */
const MAX_EXPIRY_ROWS = 400;

/**
 * Rows a person could still act on whose angle is a brief to present the
 * product. They were qualified before the qualifier learned what an angle
 * is; left alone, every draft written for them is an advert. They are judged
 * again with the current definition, behind the new finds.
 */
async function loadPitchAngled(supabase: SupabaseClient, businessId: string, brandNames: string[]): Promise<TargetRow[]> {
  const { data } = await supabase
    .from("placement_targets")
    .select(`${TARGET_COLUMNS}, qualify_angle`)
    .eq("business_id", businessId)
    .in("status", ["qualified", "drafted", "needs_review"])
    .order("qualified_at", { ascending: true, nullsFirst: false })
    .limit(MAX_QUALIFY_POOL);
  return ((data ?? []) as Array<TargetRow & { qualify_angle: string | null }>)
    .filter((row) => angleIsPitch(row.qualify_angle, brandNames))
    .map((row) => ({ ...row, kind: row.kind || "thread" }));
}

export async function loadExpertise(supabase: SupabaseClient, businessId: string, limit: number) {
  const [{ data: keywords }, { data: entities }] = await Promise.all([
    supabase
      .from("keywords")
      .select("keyword")
      .eq("business_id", businessId)
      .order("created_at", { ascending: false })
      .limit(limit),
    supabase.from("entities").select("name").eq("business_id", businessId).limit(limit),
  ]);
  return {
    keywords: (keywords ?? []).map((k) => k.keyword as string),
    entities: (entities ?? []).map((e) => e.name as string),
  };
}

/**
 * What this job's qualifier already did in earlier invocations. The step
 * yields between batches and re-selects when it resumes, so without this a
 * resumed run would restart both the dollar budget and the target cap from
 * zero and judge a whole new cap per tick.
 */
export async function qualifyProgress(
  supabase: SupabaseClient,
  jobId: string
): Promise<{ spentUsd: number; judged: number }> {
  const { data } = await supabase.from("agent_runs").select("agent, cost_usd").eq("job_id", jobId);
  let spentUsd = 0;
  let batches = 0;
  for (const row of data ?? []) {
    spentUsd += Number(row.cost_usd ?? 0);
    if (row.agent === placementQualifyAgent.name) batches += 1;
  }
  return { spentUsd, judged: batches * BATCH_SIZE };
}

function withTimeout(ms: number, parent?: AbortSignal): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`search timed out after ${ms} ms`)), ms);
  parent?.addEventListener("abort", () => controller.abort(parent.reason), { once: true });
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

/**
 * Queries of one provider in flight at once. Web search already sends its
 * five scopes together; two queries at a time halves the step (32 s on
 * 2026-11-12) and stays far below the vendor's rate. GitHub allows eight
 * search requests a minute without a token and Reddit's API is strict: one.
 */
export const QUERY_CONCURRENCY: Record<(typeof DISCOVERY_STEP_PROVIDERS)[number], number> = {
  reddit: 1,
  github: 1,
  "web-search": 2,
};

/**
 * One provider over every query. Stops the provider for this run on a rate
 * limit — a 429 answered with more requests is how an address gets banned —
 * and records every other failure as a note beside the results it did get.
 * With `concurrency` above one, that many queries run at once; a rate limit
 * stops new ones, and the notes keep the queries' order.
 */
export async function discoverWith(params: {
  supabase: SupabaseClient;
  provider: DiscoveryProvider;
  business: BusinessRow;
  queries: string[];
  signal?: AbortSignal;
  now?: Date;
  concurrency?: number;
}): Promise<{ scanned: number; stored: number; notes: string[]; rateLimited: boolean }> {
  const { provider, business } = params;
  let rateLimited = false;

  const outcome = await runBounded(
    params.queries,
    params.concurrency ?? 1,
    async (query) => {
      const timeout = withTimeout(SEARCH_TIMEOUT_MS, params.signal);
      try {
        const discussions = await provider.search({
          query,
          language: business.content_language ?? "en",
          maxAgeDays: MAX_AGE_DAYS,
          limit: PER_QUERY,
          signal: timeout.signal,
        });
        const stored = await storeTargets({
          supabase: params.supabase,
          userId: business.user_id,
          businessId: business.id,
          // The URL's own date first (an X or LinkedIn id is a timestamp):
          // exact, free, and better than the engine's printed bound.
          targets: prefilter(discussions).map((d) => ({
            ...withUrlDate(d, params.now),
            foundFor: query,
            foundVia: provider.name,
          })),
          now: params.now,
        });
        return { scanned: discussions.length, stored, note: null as string | null };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof DiscoveryProviderError && err.rateLimited) rateLimited = true;
        return { scanned: 0, stored: 0, note: `${provider.name} / "${query}": ${message}` };
      } finally {
        timeout.clear();
      }
    },
    { admit: () => (rateLimited ? "stop" : "start") }
  );

  let scanned = 0;
  let stored = 0;
  const notes: string[] = [];
  for (const result of outcome.results) {
    if (!result) continue;
    scanned += result.scanned;
    stored += result.stored;
    if (result.note) notes.push(result.note);
  }
  return { scanned, stored, notes, rateLimited };
}

function discoveryStep(providerName: (typeof DISCOVERY_STEP_PROVIDERS)[number]) {
  return {
    name: `discover:${providerName}`,
    async run(ctx: StepContext) {
      const { businessId, discover } = readInput(ctx.input);
      if (!discover) return { skipped: "discovery not requested" };

      const provider = getDiscoveryProviders().find((p) => p.name === providerName);
      if (!provider) return { skipped: "provider not configured" };

      const queries = (ctx.outputs.queries as { queries?: string[] } | undefined)?.queries ?? [];
      if (queries.length === 0) return { skipped: "nothing to search for" };

      const business = await loadBusiness(ctx.supabase, businessId);
      if (!business) return { skipped: "business not found" };

      const result = await discoverWith({
        supabase: ctx.supabase,
        provider,
        business,
        queries: queries.slice(0, QUERY_CAP[providerName]),
        signal: ctx.signal,
        concurrency: QUERY_CONCURRENCY[providerName],
      });
      return { ...result, notes: result.notes.slice(0, 10) };
    },
  };
}

export const placementDiscoveryWorkflow: Workflow = {
  type: PLACEMENT_DISCOVERY,
  steps: [
    {
      name: "queries",
      async run(ctx) {
        const { businessId } = readInput(ctx.input);
        const business = await loadBusiness(ctx.supabase, businessId);
        if (!business) return { queries: [] };
        const { keywords, entities } = await loadExpertise(ctx.supabase, businessId, 10);
        // Nothing to search for means the customer has not told us what they
        // do yet. Searching the empty string would return the whole internet.
        return { queries: buildQueries({ keywords, entities, niche: business.niche }, MAX_QUERIES) };
      },
    },
    ...DISCOVERY_STEP_PROVIDERS.map(discoveryStep),
    {
      // Rows stored before their host had a canonical identity. Runs whether
      // or not this run searched: it is a compatibility pass, not discovery.
      name: "recanonicalize",
      async run(ctx) {
        const { businessId } = readInput(ctx.input);
        return recanonicalizeLegacyTargets({ supabase: ctx.supabase, businessId });
      },
    },
    {
      // Before the rules, so the stale rule and the "To reply" windows read
      // the post's real date, and a post from five weeks ago is turned down
      // for free instead of judged as new. Runs whether or not this run
      // searched: the backfill is part of it.
      name: "dates",
      async run(ctx) {
        const { businessId } = readInput(ctx.input);
        const deadline = (ctx.deadline ?? Date.now() + 120_000) - DATES_RESERVE_MS;
        const lookup = new PostDateLookup({
          githubToken: process.env.GITHUB_TOKEN || null,
          deadline: Math.min(deadline, Date.now() + DATES_BUDGET_MS),
          signal: ctx.signal,
        });
        return dateUndatedTargets({ supabase: ctx.supabase, businessId, lookup });
      },
    },
    {
      name: "rules",
      async run(ctx) {
        const { businessId } = readInput(ctx.input);
        const business = await loadBusiness(ctx.supabase, businessId);
        if (!business) return { skipped: "business not found" };

        const now = new Date();
        const { data: rows } = await ctx.supabase
          .from("placement_targets")
          .select(TARGET_COLUMNS)
          .eq("business_id", businessId)
          .eq("status", "discovered")
          .order("created_at", { ascending: false })
          .limit(MAX_RULES_ROWS);

        const { keywords, entities } = await loadExpertise(ctx.supabase, businessId, 20);
        const own = business.website_url ? domainOf(business.website_url) : "";
        const ruleCtx = {
          now,
          ownDomains: own ? [own] : [],
          expertise: [...keywords, ...entities],
          redditArchivedBelow: await loadRedditArchivedBelow(ctx.supabase, now),
        };
        const applied = await applyRuleRejections({
          supabase: ctx.supabase,
          rows: ((rows ?? []) as TargetRow[]).map((r) => ({ ...r, kind: r.kind || "thread" })),
          ctx: ruleCtx,
        });

        // Rows already judged, a person could still act on, that time has
        // since closed: an archived Reddit thread offered as "qualified"
        // sends the person to a page that refuses their comment.
        const { data: open } = await ctx.supabase
          .from("placement_targets")
          .select(TARGET_COLUMNS)
          .eq("business_id", businessId)
          .in("status", ["qualified", "drafted", "needs_review", "approved"])
          .order("posted_at", { ascending: true, nullsFirst: false })
          .limit(MAX_EXPIRY_ROWS);
        const expired = await applyExpiry({
          supabase: ctx.supabase,
          rows: ((open ?? []) as TargetRow[]).map((r) => ({ ...r, kind: r.kind || "thread" })),
          ctx: ruleCtx,
        });

        return {
          considered: rows?.length ?? 0,
          rejected: applied.rejected,
          byRule: applied.byRule,
          expired: { considered: open?.length ?? 0, rejected: expired.rejected, byRule: expired.byRule },
        };
      },
    },
    {
      name: "qualify",
      async run(ctx) {
        const { businessId } = readInput(ctx.input);
        const business = await loadBusiness(ctx.supabase, businessId);
        if (!business) return { skipped: "business not found" };

        // The pool is what discovery saw most recently, across every surface.
        // Ordering it by thread date would put every dated API result ahead
        // of every undated web search result and starve whole platforms; the
        // fair share below deals the run's cap out per surface instead.
        const { data: targets } = await ctx.supabase
          .from("placement_targets")
          .select(TARGET_COLUMNS)
          .eq("business_id", businessId)
          .eq("status", "discovered")
          .order("last_seen_at", { ascending: false, nullsFirst: false })
          .limit(MAX_QUALIFY_POOL);

        const brandNames = businessBrandNames(business);
        const discovered = ((targets ?? []) as TargetRow[]).map((r) => ({ ...r, kind: r.kind || "thread" }));
        const rejudge = await loadPitchAngled(ctx.supabase, businessId, brandNames);
        const pool = [...discovered, ...rejudge].slice(0, MAX_QUALIFY_POOL);
        if (pool.length === 0) return { judged: 0, qualified: 0, rejected: 0, undecided: 0, rejudged: 0 };

        const { keywords, entities } = await loadExpertise(ctx.supabase, businessId, 20);
        const expertise = topicsFor(keywords, entities, brandNames);

        // The rules step ran on the newest rows; the pool may reach further
        // back. Nothing goes to the model without passing the rules, and the
        // rules are free.
        const own = business.website_url ? domainOf(business.website_url) : "";
        const ruleNow = new Date();
        const { survivors } = await applyRuleRejections({
          supabase: ctx.supabase,
          rows: pool,
          ctx: {
            now: ruleNow,
            ownDomains: own ? [own] : [],
            expertise: [...keywords, ...entities],
            redditArchivedBelow: await loadRedditArchivedBelow(ctx.supabase, ruleNow),
          },
        });

        // New finds take the cap first; the re-judged rows get what is left.
        const progress = await qualifyProgress(ctx.supabase, ctx.job.id);
        const rejudgeIds = new Set(rejudge.map((r) => r.id));
        const cap = MAX_TARGETS_PER_RUN - progress.judged;
        const fresh = pickFairShare(survivors.filter((r) => !rejudgeIds.has(r.id)), cap);
        const again = pickFairShare(survivors.filter((r) => rejudgeIds.has(r.id)), cap - fresh.length);
        const rows = [...fresh, ...again];
        if (rows.length === 0) {
          return { judged: 0, qualified: 0, rejected: 0, undecided: 0, rejudged: 0, capped: progress.judged > 0 };
        }

        const agentCtx = {
          userId: business.user_id,
          businessId,
          jobId: ctx.job.id,
          language: business.content_language ?? "en",
          runId: randomUUID(),
          budget: createBudget(Math.max(0, BUDGET_USD - progress.spentUsd)),
          signal: ctx.signal,
        };
        const recorder = supabaseRecorder(ctx.supabase);
        const now = new Date();
        const deadline = ctx.deadline ?? Date.now() + 120_000;
        const batches: TargetRow[][] = [];
        for (let i = 0; i < rows.length; i += BATCH_SIZE) batches.push(rows.slice(i, i + BATCH_SIZE));

        // "Judging 23 of 60…" in the inbox while this runs (discovery-progress.ts).
        const total = progress.judged + rows.length;
        let done = progress.judged;
        await writeQualifyProgress(ctx, done, total);

        // The batches run QUALIFY_CONCURRENCY at a time (2026-11-12: one at a
        // time, about 30 s each, the step took six minutes). Same prompt,
        // same model, same batches, same budget: a batch starts only while the
        // budget can still cover it beside the ones in flight, and only while
        // the deadline leaves it time. The verdicts are written after, batch
        // by batch in order, so the rows end as a sequential run leaves them.
        const outcome = await runBounded(
          batches,
          QUALIFY_CONCURRENCY,
          (batch) =>
            runAgent(
              placementQualifyAgent,
              {
                business: {
                  name: business.name ?? "the business",
                  niche: business.niche,
                  domain: business.website_url,
                },
                // The weekly batch judges; the manual draft asks for angles only.
                mode: "judge",
                refusedAngles: [],
                expertise,
                aboutWriter: parseVoiceSettings(business.voice_settings).aboutYou,
                tier: "fast",
                language: agentCtx.language,
                threads: toThreads(batch, now),
              },
              agentCtx,
              recorder
            ),
          {
            admit: (inFlight) =>
              qualifyAdmission({ msLeft: deadline - Date.now(), remainingUsd: agentCtx.budget.remainingUsd(), inFlight }),
            onSettled: async (index) => {
              done += batches[index].length;
              await writeQualifyProgress(ctx, done, total);
            },
          }
        );

        const totals = { judged: 0, qualified: 0, rejected: 0, undecided: 0, rejudged: 0 };
        for (let i = 0; i < batches.length; i += 1) {
          const output = outcome.results[i];
          if (!output) continue;
          const batch = batches[i];
          const applied = await applyVerdicts({ supabase: ctx.supabase, rows: batch, verdicts: output.verdicts, now, brandNames });
          totals.judged += batch.length;
          totals.qualified += applied.qualified;
          totals.rejected += applied.rejected;
          totals.undecided += applied.undecided;
          totals.rejudged += batch.filter((r) => rejudgeIds.has(r.id)).length;
        }

        // A refusal (the billing pause among them) is the worker's to handle,
        // after what finished beside it is written.
        if (outcome.errorIndex >= 0) throw outcome.error;
        if (outcome.started < batches.length) {
          // Judged rows changed status; what is left is still `discovered`
          // and the next call picks it up without asking twice.
          const left = batches.slice(outcome.started).reduce((n, b) => n + b.length, 0);
          throw new StepIncomplete(`${left} targets still to judge`);
        }

        return totals;
      },
    },
  ],
};
