import type { SupabaseClient } from "@supabase/supabase-js";
import type { CitationSource } from "@/lib/providers/citations/types";
import { enqueueJob } from "@/lib/jobs/queue";
import { MANUAL_JOB_PRIORITY } from "@/lib/jobs/types";
import type { CompetitorSighting } from "./verdict";
import type { ProbeRecord, ProbeState, RunRecord } from "./summary";

/**
 * Persistence for AI Visibility: the row shapes, and the one way a run is
 * started. Both the "Run now" route and the scheduled sweep call `startRun`,
 * so a run always looks the same whoever asked for it — a row in aeo_runs the
 * UI can show immediately, and a job the worker executes.
 */

export const AEO_RUN = "aeo-run";

type Row = Record<string, unknown>;

export function mapRun(row: Row): RunRecord {
  return {
    id: row.id as string,
    status: row.status as RunRecord["status"],
    trigger: (row.trigger as RunRecord["trigger"]) ?? "manual",
    engines: (row.engines as string[] | null) ?? [],
    queryCount: Number(row.query_count ?? 0),
    queryFingerprint: (row.query_fingerprint as string | null) ?? null,
    plannedProbes: Number(row.planned_probes ?? 0),
    startedAt: row.started_at as string,
    finishedAt: (row.finished_at as string | null) ?? null,
    error: (row.error as string | null) ?? null,
  };
}

export function mapProbe(row: Row): ProbeRecord {
  return {
    id: row.id as string,
    runId: row.run_id as string,
    queryId: (row.query_id as string | null) ?? null,
    query: row.query as string,
    cluster: (row.cluster as string | null) ?? null,
    engine: row.engine as string,
    model: (row.model as string | null) ?? null,
    status: row.status as ProbeState,
    cited: (row.cited as boolean | null) ?? null,
    sourceUrl: (row.source_url as string | null) ?? null,
    position: row.position === null || row.position === undefined ? null : Number(row.position),
    mentioned: (row.mentioned as boolean | null) ?? null,
    answerExcerpt: (row.answer_excerpt as string | null) ?? null,
    sources: Array.isArray(row.sources) ? (row.sources as CitationSource[]) : [],
    competitors: Array.isArray(row.competitors) ? (row.competitors as CompetitorSighting[]) : [],
    error: (row.error as string | null) ?? null,
    latencyMs: row.latency_ms === null || row.latency_ms === undefined ? null : Number(row.latency_ms),
    probeVersion: Number(row.probe_version ?? 1),
    checkedAt: (row.checked_at as string | null) ?? null,
  };
}

/*
 * What a run and a probe cost (`cost_usd`, an estimate from published prices)
 * is the platform's, not the customer's: a subscriber pays a fixed price
 * (owner's decision, 2026-11-14). It is written by the run and summed by its
 * finish step (`runCostUsd`), and never read into a record the screens, the
 * routes or the tools return, so neither column is in these lists.
 */

export const PROBE_COLUMNS =
  "id, run_id, query_id, query, cluster, engine, model, status, cited, source_url, position, mentioned, answer_excerpt, sources, competitors, error, latency_ms, probe_version, checked_at";

export const RUN_COLUMNS =
  "id, status, trigger, engines, query_count, query_fingerprint, planned_probes, started_at, finished_at, error";

/**
 * A run's estimated cost: the sum of its probes' `cost_usd`, null when none
 * recorded one (unknown, never $0). For the run row only (`aeo_runs.cost_usd`).
 */
export function runCostUsd(rows: Array<{ cost_usd?: unknown }>): number | null {
  let cost = 0;
  let measured = false;
  for (const row of rows) {
    if (row.cost_usd === null || row.cost_usd === undefined) continue;
    const usd = Number(row.cost_usd);
    if (!Number.isFinite(usd)) continue;
    cost += usd;
    measured = true;
  }
  return measured ? Number(cost.toFixed(6)) : null;
}

/** True while a run for this site is still being executed. */
export async function hasActiveRun(supabase: SupabaseClient, businessId: string): Promise<boolean> {
  const { count } = await supabase
    .from("aeo_runs")
    .select("id", { count: "exact", head: true })
    .eq("business_id", businessId)
    .eq("status", "running");
  return (count ?? 0) > 0;
}

/**
 * Starts a run: one row, one job. Service-role client, because runs are the
 * worker's to write; the caller has already established that `userId` owns
 * `businessId` (the route through the user's own session, the cron by reading
 * the business row).
 */
export async function startRun(params: {
  supabase: SupabaseClient;
  userId: string;
  businessId: string;
  trigger: "manual" | "schedule";
}): Promise<{ runId: string; jobId: string }> {
  const { data, error } = await params.supabase
    .from("aeo_runs")
    .insert({
      user_id: params.userId,
      business_id: params.businessId,
      trigger: params.trigger,
      status: "running",
    })
    .select("id")
    .single();
  if (error) throw new Error(`aeo run insert failed: ${error.message}`);
  const runId = data.id as string;

  const jobId = await enqueueJob({
    supabase: params.supabase,
    userId: params.userId,
    businessId: params.businessId,
    type: AEO_RUN,
    input: { runId, businessId: params.businessId },
    priority: params.trigger === "manual" ? MANUAL_JOB_PRIORITY : 0,
    maxAttempts: 3,
  });

  await params.supabase.from("aeo_runs").update({ job_id: jobId }).eq("id", runId);
  return { runId, jobId };
}
