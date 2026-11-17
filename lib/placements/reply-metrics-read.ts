import type { SupabaseClient } from "@supabase/supabase-js";
import { mapReplyMetrics, type ReplyMetrics } from "./reply-metrics";

/**
 * Reading the stored reply numbers (`placement_metrics`): the inbox, the
 * tools. Kept apart from the job that writes them (x-metrics.ts) so a page
 * that reads the inbox's types never pulls the X client in. Through the
 * caller's client: RLS (or the owner-scoped client) is the access control,
 * `business_id` the scope.
 */

export const PLACEMENT_METRICS_TABLE = "placement_metrics";

/** How far back the newest snapshot is looked for: the reading window and a week. */
const LATEST_LOOKBACK_DAYS = 21;

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

const METRIC_COLUMNS = "target_id, day, impressions, likes, replies, reposts, quotes, bookmarks, fetched_at";

/**
 * The newest snapshot of each of a site's replies, by target id; null when
 * the table cannot be read (the migration not applied yet): unknown, and
 * the inbox shows no line rather than a wrong one.
 */
export async function loadReplyMetrics(
  supabase: SupabaseClient,
  businessId: string,
  targetIds?: readonly string[]
): Promise<Map<string, ReplyMetrics> | null> {
  const history = await loadReplyMetricsHistory(supabase, businessId, { targetIds, days: LATEST_LOOKBACK_DAYS });
  if (!history) return null;
  const latest = new Map<string, ReplyMetrics>();
  for (const [id, list] of history) if (list[0]) latest.set(id, list[0]);
  return latest;
}

/** Every snapshot of the last `days` days, newest first, by target id; null when unreadable. */
export async function loadReplyMetricsHistory(
  supabase: SupabaseClient,
  businessId: string,
  options: { targetIds?: readonly string[]; days?: number; now?: Date; limit?: number } = {}
): Promise<Map<string, ReplyMetrics[]> | null> {
  if (options.targetIds && options.targetIds.length === 0) return new Map();
  const now = options.now ?? new Date();
  const since = utcDay(new Date(now.getTime() - (options.days ?? LATEST_LOOKBACK_DAYS) * 86_400_000));
  let query = supabase
    .from(PLACEMENT_METRICS_TABLE)
    .select(METRIC_COLUMNS)
    .eq("business_id", businessId)
    .gte("day", since)
    .order("day", { ascending: false })
    .limit(options.limit ?? 2000);
  if (options.targetIds) query = query.in("target_id", [...options.targetIds]);
  try {
    const { data, error } = await query;
    if (error) return null;
    const out = new Map<string, ReplyMetrics[]>();
    for (const row of (data ?? []) as Record<string, unknown>[]) {
      const id = row.target_id as string;
      const list = out.get(id) ?? [];
      list.push(mapReplyMetrics(row));
      out.set(id, list);
    }
    return out;
  } catch {
    return null;
  }
}
