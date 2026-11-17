import type { SupabaseClient } from "@supabase/supabase-js";
import { TOOL_CALLS_TABLE } from "./usage";

/**
 * How long the audit log of the API and MCP (`tool_calls`) is kept: 90
 * days. The limits only ever read the last 24 hours and Settings the last
 * 7, so 90 days leaves room for support and for a person reading their
 * own history, and no more. docs/API.md "Limits and the audit log".
 *
 * The daily sweep (/api/cron/prune-tool-calls) deletes older rows through
 * the service role, oldest first, in batches: each batch reads the
 * `created_at` of the BATCH_SIZE-th oldest expired row and deletes every
 * expired row up to it, so one statement never deletes the whole backlog
 * and no list of ids travels in a URL. A run stops after MAX_BATCHES or
 * when its time is up; the next day's run takes the rest.
 */

export const TOOL_CALLS_RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface PruneOptions {
  batchSize?: number;
  maxBatches?: number;
  /** Stop starting batches after this many milliseconds. */
  timeBudgetMs?: number;
}

export interface PruneResult {
  cutoff: string;
  deleted: number;
  batches: number;
  /** True when nothing older than the cutoff is left. */
  done: boolean;
}

export async function pruneToolCalls(
  admin: SupabaseClient,
  now: Date = new Date(),
  options: PruneOptions = {}
): Promise<PruneResult> {
  const batchSize = options.batchSize ?? 5000;
  const maxBatches = options.maxBatches ?? 20;
  const deadline = Date.now() + (options.timeBudgetMs ?? 240_000);
  const cutoff = new Date(now.getTime() - TOOL_CALLS_RETENTION_DAYS * DAY_MS).toISOString();

  let deleted = 0;
  let batches = 0;
  while (batches < maxBatches && Date.now() < deadline) {
    const { data, error } = await admin
      .from(TOOL_CALLS_TABLE)
      .select("created_at")
      .lt("created_at", cutoff)
      .order("created_at", { ascending: true })
      .limit(batchSize);
    if (error) throw new Error(`Could not read expired tool calls: ${error.message}`);
    const rows = (data ?? []) as Array<{ created_at: string }>;
    if (rows.length === 0) return { cutoff, deleted, batches, done: true };

    const upTo = rows[rows.length - 1].created_at;
    const { count, error: deleteError } = await admin
      .from(TOOL_CALLS_TABLE)
      .delete({ count: "exact" })
      .lt("created_at", cutoff)
      .lte("created_at", upTo);
    if (deleteError) throw new Error(`Could not delete expired tool calls: ${deleteError.message}`);
    deleted += count ?? 0;
    batches += 1;
    if (rows.length < batchSize) return { cutoff, deleted, batches, done: true };
  }
  return { cutoff, deleted, batches, done: false };
}
