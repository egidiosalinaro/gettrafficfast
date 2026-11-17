import type { SupabaseClient } from "@supabase/supabase-js";
import {
  compareProviders,
  ComparisonCall,
  ComparisonJob,
  ComparisonMetric,
  ComparisonOutcome,
  ComparisonPublication,
  ComparisonRun,
  ProviderComparison,
} from "@/lib/content/provider-comparison";
import { SEARCH_CONSOLE } from "@/lib/analytics/search-console";
import { isSubscriptionInactive } from "@/lib/jobs/types";
import { armOf, isIntentSkip, PRODUCE_ARTICLE } from "@/lib/jobs/workflows/produce-article";
import { articleRotation, chooseArticleArm } from "@/lib/providers/llm/registry";

/**
 * The read behind `GET /api/articles/provider-comparison` and the
 * `compare_article_providers` tool: one site's production jobs of the last
 * `days`, each with the arm its `arm` step stored, the agent runs it made
 * and how it ended, plus Search Console's numbers for what was published.
 * The arithmetic is lib/content/provider-comparison.ts.
 *
 * `client` is the caller's (a session under RLS, or an API key's
 * owner-scoped service role): it reads the tables that carry `user_id`, and
 * that is where ownership is decided. `job_steps` has no owner column and
 * `agent_runs` is not on the owner-scoped list, so those two are read with
 * `admin`, only ever by the ids of jobs `client` returned for this site.
 *
 * Asks no model and no provider: free.
 */

export const DEFAULT_COMPARISON_DAYS = 90;
export const MAX_COMPARISON_DAYS = 365;
/** The most production jobs one answer reads; `truncated` says when the window held more. */
export const MAX_COMPARISON_JOBS = 1000;

/** Ids per `in (...)` filter: short enough for a URL, and for a page to hold every run of the chunk. */
const CHUNK = 40;
const PAGE = 1000;

export interface ProviderComparisonView extends ProviderComparison {
  window: {
    days: number;
    since: string;
    /** Production jobs read, with or without an arm. */
    jobsRead: number;
    /** Those that ran under a rotation. */
    jobsWithArm: number;
    truncated: boolean;
  };
  rotation: {
    /** `LLM_ARTICLE_ROTATION` as configured now; null when unset (or unreadable). */
    configured: string[] | null;
    /** The arm a job starting now would get. */
    today: string | null;
  };
}

/** The comparison a customer reads: every agent's `avgCostUsd` left out. */
export type CustomerProviderComparison = Omit<ProviderComparisonView, "arms"> & {
  arms: Array<Omit<ProviderComparisonView["arms"][number], "agents"> & {
    agents: Array<Omit<ProviderComparisonView["arms"][number]["agents"][number], "avgCostUsd">>;
  }>;
};

/**
 * The comparison without what the runs cost the platform. A subscriber pays
 * a fixed price (owner's decision, 2026-11-14), so `compare_article_providers`
 * and the route answer this to everyone but a platform owner (lib/owner.ts),
 * who keeps `avgCostUsd` on the route.
 */
export function withoutCosts(view: ProviderComparisonView): CustomerProviderComparison {
  return {
    ...view,
    arms: view.arms.map((arm) => ({
      ...arm,
      agents: arm.agents.map((agent) => {
        const kept: Partial<typeof agent> = { ...agent };
        delete kept.avgCostUsd;
        return kept as Omit<typeof agent, "avgCostUsd">;
      }),
    })),
  };
}

type Row = Record<string, unknown>;

function chunks<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Every row of a query that pages with `range`, a page at a time. */
async function readAll(page: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>): Promise<Row[]> {
  const rows: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error(error instanceof Error ? error.message : String((error as { message?: unknown }).message ?? error));
    const batch = (Array.isArray(data) ? data : []) as Row[];
    rows.push(...batch);
    if (batch.length < PAGE) return rows;
  }
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function callsOf(value: unknown): ComparisonCall[] | null {
  if (!Array.isArray(value)) return null;
  return value.map((call: Row) => ({
    provider: typeof call?.provider === "string" && call.provider ? call.provider : null,
    model: typeof call?.model === "string" ? call.model : null,
    fallback: call?.fallback === true,
  }));
}

/**
 * How a production job ended, from its row and its checkpoints.
 * `validated` is whether the `validate` step completed: a job that failed
 * after it left a usable article behind (`onFailure` settles it).
 */
export function jobOutcome(job: { status: string; lastError: string | null }, validated: boolean): ComparisonOutcome {
  if (job.status === "completed") return "settled";
  if (job.status !== "failed") return "unfinished";
  if (isSubscriptionInactive(job.lastError)) return "unfinished";
  if (isIntentSkip(job.lastError)) return "skipped";
  return validated ? "settled" : "failed";
}

/** What the `settle` step checkpointed, as the comparison reads it. Missing fields are null, never guessed. */
function settledFields(settle: Row | null): Pick<ComparisonJob, "settledAs" | "gateIssuesBeforeRevision" | "revisionNeeded" | "wordCount" | "auditScore"> {
  const status = settle?.status;
  const problems = numberOrNull(settle?.problems);
  return {
    settledAs: status === "generated" || status === "needs_review" ? status : null,
    gateIssuesBeforeRevision: numberOrNull(settle?.gateIssues),
    revisionNeeded: problems === null ? null : problems > 0,
    wordCount: numberOrNull(settle?.wordCount),
    auditScore: numberOrNull(settle?.auditScore),
  };
}

function rotationNow(now: Date): ProviderComparisonView["rotation"] {
  try {
    return { configured: articleRotation(), today: chooseArticleArm(now).arm };
  } catch {
    // A name the registry cannot build: production says so loudly; a read does not fail over it.
    return { configured: null, today: null };
  }
}

export async function loadProviderComparison(params: {
  client: SupabaseClient;
  admin: SupabaseClient;
  businessId: string;
  days?: number;
  now?: Date;
}): Promise<ProviderComparisonView> {
  const { client, admin, businessId } = params;
  const now = params.now ?? new Date();
  const days = Math.min(MAX_COMPARISON_DAYS, Math.max(1, Math.floor(params.days ?? DEFAULT_COMPARISON_DAYS)));
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();

  const { data: jobData, error: jobError } = await client
    .from("jobs")
    .select("id, article_id, status, last_error, created_at")
    .eq("business_id", businessId)
    .eq("type", PRODUCE_ARTICLE)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(MAX_COMPARISON_JOBS + 1);
  if (jobError) throw new Error(`jobs: ${jobError.message}`);

  const allJobs = (jobData ?? []) as Row[];
  const truncated = allJobs.length > MAX_COMPARISON_JOBS;
  const jobRows = allJobs.slice(0, MAX_COMPARISON_JOBS);
  const jobIds = jobRows.map((row) => String(row.id));

  // The arm and how the job settled: two small checkpoints per job.
  const arms = new Map<string, string | null>();
  const settles = new Map<string, Row>();
  for (const ids of chunks(jobIds)) {
    const steps = await readAll((from, to) =>
      admin
        .from("job_steps")
        .select("job_id, step, output")
        .in("job_id", ids)
        .in("step", ["arm", "settle"])
        .eq("status", "completed")
        .range(from, to)
    );
    for (const step of steps) {
      const jobId = String(step.job_id);
      if (step.step === "arm") arms.set(jobId, armOf({ arm: step.output }));
      else if (step.output && typeof step.output === "object") settles.set(jobId, step.output as Row);
    }
  }

  // Whether a failed job had a validated draft: only failed jobs are asked.
  const validated = new Set<string>();
  const failedIds = jobRows.filter((row) => row.status === "failed").map((row) => String(row.id));
  for (const ids of chunks(failedIds)) {
    const steps = await readAll((from, to) =>
      admin.from("job_steps").select("job_id").in("job_id", ids).eq("step", "validate").eq("status", "completed").range(from, to)
    );
    for (const step of steps) validated.add(String(step.job_id));
  }

  const jobs: ComparisonJob[] = jobRows.map((row) => {
    const jobId = String(row.id);
    return {
      jobId,
      articleId: (row.article_id as string | null) ?? null,
      arm: arms.get(jobId) ?? null,
      createdAt: String(row.created_at),
      outcome: jobOutcome(
        { status: String(row.status), lastError: (row.last_error as string | null) ?? null },
        validated.has(jobId)
      ),
      ...settledFields(settles.get(jobId) ?? null),
    };
  });

  // Runs only of jobs that had an arm: the others are not part of any comparison.
  const armed = jobs.filter((job) => job.arm).map((job) => job.jobId);
  const runs: ComparisonRun[] = [];
  for (const ids of chunks(armed)) {
    const rows = await readAll((from, to) =>
      admin
        .from("agent_runs")
        .select("job_id, agent, status, cost_usd, latency_ms, llm_calls")
        .in("job_id", ids)
        .order("created_at", { ascending: true })
        .range(from, to)
    );
    for (const row of rows) {
      runs.push({
        jobId: String(row.job_id),
        agent: String(row.agent),
        status: row.status === "failed" ? "failed" : "completed",
        costUsd: numberOrNull(row.cost_usd),
        latencyMs: numberOrNull(row.latency_ms),
        calls: callsOf(row.llm_calls),
      });
    }
  }

  // Downstream: the first successful delivery of each article an armed job wrote.
  const articleIds = [...new Set(jobs.flatMap((job) => (job.arm && job.articleId ? [job.articleId] : [])))];
  const publications: ComparisonPublication[] = [];
  const metrics: ComparisonMetric[] = [];
  let syncedThrough: string | null = null;

  if (articleIds.length > 0) {
    const { data: connection } = await client
      .from("analytics_connections")
      .select("status, last_synced_on")
      .eq("business_id", businessId)
      .eq("provider", SEARCH_CONSOLE)
      .maybeSingle();
    syncedThrough =
      connection && connection.status !== "disconnected" ? ((connection.last_synced_on as string | null) ?? null) : null;

    const firstDelivery = new Map<string, string>();
    const refreshed = new Map<string, string | null>();
    for (const ids of chunks(articleIds)) {
      const attempts = await readAll((from, to) =>
        client
          .from("publish_attempts")
          .select("article_id, ok, created_at")
          .eq("business_id", businessId)
          .eq("ok", true)
          .in("article_id", ids)
          .order("created_at", { ascending: true })
          .range(from, to)
      );
      for (const attempt of attempts) {
        const articleId = String(attempt.article_id);
        const at = String(attempt.created_at);
        const known = firstDelivery.get(articleId);
        if (!known || at < known) firstDelivery.set(articleId, at);
      }

      const articles = await readAll((from, to) =>
        client.from("articles").select("id, last_refreshed_at").eq("business_id", businessId).in("id", ids).range(from, to)
      );
      for (const article of articles) refreshed.set(String(article.id), (article.last_refreshed_at as string | null) ?? null);
    }

    for (const [articleId, at] of firstDelivery) {
      publications.push({ articleId, publishedOn: at.slice(0, 10), refreshedOn: refreshed.get(articleId)?.slice(0, 10) ?? null });
    }

    if (syncedThrough) {
      for (const ids of chunks([...firstDelivery.keys()])) {
        const rows = await readAll((from, to) =>
          client
            .from("content_metrics")
            .select("article_id, captured_on, position, impressions, clicks")
            .eq("business_id", businessId)
            .eq("source", SEARCH_CONSOLE)
            .in("article_id", ids)
            .order("captured_on", { ascending: true })
            .range(from, to)
        );
        for (const row of rows) {
          metrics.push({
            articleId: String(row.article_id),
            capturedOn: String(row.captured_on),
            impressions: Number(row.impressions ?? 0),
            clicks: Number(row.clicks ?? 0),
            position: numberOrNull(row.position),
          });
        }
      }
    }
  }

  return {
    ...compareProviders({ jobs, runs, publications, metrics, syncedThrough }),
    window: { days, since, jobsRead: jobs.length, jobsWithArm: armed.length, truncated },
    rotation: rotationNow(now),
  };
}

/** What a caller with no site gets: the same shape, nothing in it. */
export function emptyProviderComparison(days = DEFAULT_COMPARISON_DAYS, now = new Date()): ProviderComparisonView {
  return {
    ...compareProviders({ jobs: [], runs: [], publications: [], metrics: [], syncedThrough: null }),
    window: {
      days,
      since: new Date(now.getTime() - days * 86_400_000).toISOString(),
      jobsRead: 0,
      jobsWithArm: 0,
      truncated: false,
    },
    rotation: rotationNow(now),
  };
}
