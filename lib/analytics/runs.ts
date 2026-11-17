import type { SupabaseClient } from "@supabase/supabase-js";
import { enqueueJob, hasActiveBusinessJob } from "@/lib/jobs/queue";
import { runJobNow, type JobOutcome } from "@/lib/jobs/worker";
import { SEARCH_CONSOLE_INGEST } from "@/lib/jobs/workflows/search-console-ingest";
import { loadConnection, searchConsoleNeedsPull } from "@/lib/analytics/search-console";

/**
 * Starting a Search Console ingest. The daily sweep and the first-connect
 * path both go through here, so a property picked at 15:00 is pulled now
 * rather than at 07:00.
 *
 * A pull runs when there is no watermark, or when the watermark is behind
 * the newest day Google has settled. A visit that is already through that
 * day does not ask again: the date on the chart is the data, and redrawing
 * it spends quota on the same window.
 */

export async function hasActiveSearchConsoleIngest(
  supabase: SupabaseClient,
  businessId: string
): Promise<boolean> {
  return hasActiveBusinessJob(supabase, businessId, SEARCH_CONSOLE_INGEST);
}

export async function startSearchConsoleIngest(params: {
  supabase: SupabaseClient;
  userId: string;
  businessId: string;
}): Promise<{ jobId: string | null; alreadyRunning: boolean }> {
  if (await hasActiveSearchConsoleIngest(params.supabase, params.businessId)) {
    return { jobId: null, alreadyRunning: true };
  }
  const jobId = await enqueueJob({
    supabase: params.supabase,
    userId: params.userId,
    businessId: params.businessId,
    type: SEARCH_CONSOLE_INGEST,
    input: { businessId: params.businessId },
    priority: 10,
    maxAttempts: 3,
  });
  return { jobId, alreadyRunning: false };
}

export async function kickFirstSearchConsoleSync(params: {
  supabase: SupabaseClient;
  userId: string;
  businessId: string;
  /** When set, run the job inline so the caller can wait. */
  waitMs?: number;
}): Promise<{
  jobId: string | null;
  alreadyRunning: boolean;
  skipped?: "already_synced" | "no_property" | "no_connection";
  outcome?: JobOutcome | "not_found";
  lastSyncedOn: string | null;
  syncing: boolean;
}> {
  const connection = await loadConnection({
    supabase: params.supabase,
    businessId: params.businessId,
  });
  if (!connection) {
    return {
      jobId: null,
      alreadyRunning: false,
      skipped: "no_connection",
      lastSyncedOn: null,
      syncing: false,
    };
  }
  if (!connection.siteUrl) {
    return {
      jobId: null,
      alreadyRunning: false,
      skipped: "no_property",
      lastSyncedOn: null,
      syncing: false,
    };
  }
  if (!searchConsoleNeedsPull(connection.lastSyncedOn)) {
    return {
      jobId: null,
      alreadyRunning: false,
      skipped: "already_synced",
      lastSyncedOn: connection.lastSyncedOn,
      syncing: false,
    };
  }

  const started = await startSearchConsoleIngest({
    supabase: params.supabase,
    userId: params.userId,
    businessId: params.businessId,
  });

  let outcome: JobOutcome | "not_found" | undefined;
  if (started.jobId && params.waitMs && params.waitMs > 0) {
    outcome = await runJobNow(params.supabase, started.jobId, params.waitMs);
  }

  const after = await loadConnection({
    supabase: params.supabase,
    businessId: params.businessId,
  });
  const syncing =
    !after?.lastSyncedOn &&
    (await hasActiveSearchConsoleIngest(params.supabase, params.businessId));
  return {
    jobId: started.jobId,
    alreadyRunning: started.alreadyRunning,
    outcome,
    lastSyncedOn: after?.lastSyncedOn ?? null,
    syncing,
  };
}
