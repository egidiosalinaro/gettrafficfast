import type { SupabaseClient } from "@supabase/supabase-js";
import { enqueueJob } from "@/lib/jobs/queue";
import { PLACEMENT_DISCOVERY } from "@/lib/jobs/workflows/placement-discovery";
import { PLACEMENT_DRAFT } from "@/lib/jobs/workflows/placement-draft";
import { MANUAL_JOB_PRIORITY } from "@/lib/jobs/types";
import { getDiscoveryProviders } from "@/lib/providers/discovery/registry";
import { DISCOVERY_UNAVAILABLE } from "./sources";

/**
 * Starting placement work. Both the weekly cron and the inbox's buttons go
 * through here, so a discovery run or a draft looks the same whoever asked.
 * Producers enqueue; the worker executes.
 */

/** True while a discovery job for this business is queued or running. */
export async function hasActiveDiscovery(supabase: SupabaseClient, businessId: string): Promise<boolean> {
  const { count } = await supabase
    .from("jobs")
    .select("id", { count: "exact", head: true })
    .eq("business_id", businessId)
    .eq("type", PLACEMENT_DISCOVERY)
    .in("status", ["pending", "running"]);
  return (count ?? 0) > 0;
}

export async function startDiscovery(params: {
  supabase: SupabaseClient;
  userId: string;
  businessId: string;
  /** Manual requests jump the queue. */
  manual?: boolean;
}): Promise<{ jobId: string | null; alreadyRunning: boolean }> {
  if (await hasActiveDiscovery(params.supabase, params.businessId)) {
    return { jobId: null, alreadyRunning: true };
  }
  const jobId = await enqueueJob({
    supabase: params.supabase,
    userId: params.userId,
    businessId: params.businessId,
    type: PLACEMENT_DISCOVERY,
    input: { businessId: params.businessId, discover: true },
    priority: params.manual ? MANUAL_JOB_PRIORITY : 0,
    maxAttempts: 3,
  });
  return { jobId, alreadyRunning: false };
}

/**
 * How long a run asked for from the Replies page keeps going after the
 * response, step after step, before what is left goes back to the tick:
 * under the route's 300 s maxDuration, with room for the request itself.
 */
export const DISCOVERY_RUN_NOW_BUDGET_MS = 280_000;

export type DiscoveryRequest =
  | { ok: false; code: "no_provider"; error: string }
  | { ok: true; jobId: string | null; alreadyRunning: boolean; providers: string[] };

/**
 * "Run discovery" for one site, up to the moment the job runs: the inbox's
 * POST /api/placements/discover and the API's `run_reply_discovery` both
 * ask here. With no discovery provider configured nothing is enqueued; with
 * a run already queued or running, nothing new is.
 */
export async function requestDiscovery(params: {
  /** The service role: the job queue. */
  admin: SupabaseClient;
  userId: string;
  businessId: string;
}): Promise<DiscoveryRequest> {
  const providers = getDiscoveryProviders().map((p) => p.name);
  if (providers.length === 0) return { ok: false, code: "no_provider", error: DISCOVERY_UNAVAILABLE };
  const started = await startDiscovery({ supabase: params.admin, userId: params.userId, businessId: params.businessId, manual: true });
  return { ok: true, jobId: started.jobId, alreadyRunning: started.alreadyRunning || !started.jobId, providers };
}

/**
 * A lock younger than this still belongs to the request that took it. The
 * inline draft budget is 105s; past that the function is gone and the lock
 * is a leftover of a kill, which is claimable.
 */
export const DRAFT_LOCK_LIVE_MS = 110_000;

export interface ActiveDraft {
  id: string;
  status: string;
  lockedAt: string | null;
  lastError: string | null;
}

/** True while the worker that took the lock can still be inside its budget. */
export function draftLockIsLive(lockedAt: string | null, now = Date.now()): boolean {
  if (!lockedAt) return false;
  const at = Date.parse(lockedAt);
  return Number.isFinite(at) && now - at < DRAFT_LOCK_LIVE_MS;
}

/**
 * A pending draft is waiting for someone to run it. A running draft whose
 * lock has expired was abandoned by a killed function. Either one should be
 * run now, while the person is still looking at the card.
 */
export function shouldResumeDraft(job: { status: string; lockedAt: string | null }, now = Date.now()): boolean {
  if (job.status === "pending") return true;
  if (job.status === "running") return !draftLockIsLive(job.lockedAt, now);
  return false;
}

export interface LatestDraft extends ActiveDraft {
  result: unknown;
}

async function latestDraftJob(
  supabase: SupabaseClient,
  businessId: string,
  targetId: string,
  statuses?: string[]
): Promise<Record<string, unknown> | null> {
  let query = supabase
    .from("jobs")
    .select("id, status, locked_at, last_error, input, result, created_at")
    .eq("business_id", businessId)
    .eq("type", PLACEMENT_DRAFT)
    .order("created_at", { ascending: false })
    .limit(20);
  if (statuses) query = query.in("status", statuses);
  const { data } = await query;
  return (
    (data ?? []).find((job) => (job.input as { targetId?: string } | null)?.targetId === targetId) ?? null
  );
}

function toDraft(row: Record<string, unknown>): LatestDraft {
  return {
    id: row.id as string,
    status: row.status as string,
    lockedAt: (row.locked_at as string | null) ?? null,
    lastError: (row.last_error as string | null) ?? null,
    result: row.result ?? null,
  };
}

/** The queued or running draft job for this target, newest first. */
export async function findActiveDraft(
  supabase: SupabaseClient,
  businessId: string,
  targetId: string
): Promise<ActiveDraft | null> {
  const row = await latestDraftJob(supabase, businessId, targetId, ["pending", "running"]);
  return row ? toDraft(row) : null;
}

/** The newest draft job for this target, whatever state it ended in. */
export async function findLatestDraft(
  supabase: SupabaseClient,
  businessId: string,
  targetId: string
): Promise<LatestDraft | null> {
  const row = await latestDraftJob(supabase, businessId, targetId);
  return row ? toDraft(row) : null;
}

/** True while a draft job for this target is queued or running. */
export async function hasActiveDraft(supabase: SupabaseClient, targetId: string): Promise<boolean> {
  const { data } = await supabase
    .from("jobs")
    .select("id, input")
    .eq("type", PLACEMENT_DRAFT)
    .in("status", ["pending", "running"])
    .limit(50);
  return (data ?? []).some((row) => (row.input as { targetId?: string } | null)?.targetId === targetId);
}

export async function startDraft(params: {
  supabase: SupabaseClient;
  userId: string;
  businessId: string;
  targetId: string;
  /**
   * "Write it anyway": the person read a decline and asked for the draft.
   * The job does not ask the qualifier again and the drafter is told the
   * person decided (lib/jobs/workflows/placement-draft.ts).
   */
  anyway?: boolean;
  /**
   * Started by a scheduled run on the owner's behalf (the daily X search
   * drafting what it found), not by a person: queued at the crons'
   * priority, so the per-account caps on asked-for work do not count it.
   * The daily draft cap still does: it counts every draft job.
   */
  scheduled?: boolean;
}): Promise<{ jobId: string | null; alreadyRunning: boolean }> {
  if (await hasActiveDraft(params.supabase, params.targetId)) {
    return { jobId: null, alreadyRunning: true };
  }
  const jobId = await enqueueJob({
    supabase: params.supabase,
    userId: params.userId,
    businessId: params.businessId,
    type: PLACEMENT_DRAFT,
    input: {
      businessId: params.businessId,
      targetId: params.targetId,
      ...(params.anyway ? { anyway: true } : {}),
    },
    priority: params.scheduled ? 0 : MANUAL_JOB_PRIORITY,
    maxAttempts: 2,
  });
  return { jobId, alreadyRunning: false };
}
