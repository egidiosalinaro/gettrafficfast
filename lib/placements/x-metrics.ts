import type { SupabaseClient } from "@supabase/supabase-js";
import { lookupWorstCaseUsd, type XApiClient } from "@/lib/providers/x/api";
import { xStatusIdOf } from "./published-url";
import { PLACEMENT_METRICS_TABLE } from "./reply-metrics-read";
import { X_METRICS_MAX_IDS_PER_RUN, X_METRICS_WINDOW_DAYS, meteredXCall, type MeteredRefusal } from "./x-budget";

/**
 * The numbers of the replies a person posted on X, read once a day through
 * the official API (`GET /2/tweets?ids=`, one batched call of up to 100
 * ids), stored as a dated snapshot per reply in `placement_metrics`.
 *
 * Which replies: posted on X (`published_manually`), with the link to the
 * reply saved (`published_url`, a status id), posted in the last 14 days,
 * on a site whose owner turned "Find posts on X" on. A reply already read
 * today is not read again, so a second run the same day costs nothing.
 *
 * Honest numbers: what X returned is stored as it came; a number it did not
 * return is null; a reply X did not hand back at all (deleted, protected)
 * gets a row of nulls, because "asked, and nothing came back" is the
 * measurement and a missing row would read as "never asked". These are
 * X's public counters on one day, a snapshot, not a total of anything.
 */

export { loadReplyMetrics, loadReplyMetricsHistory } from "./reply-metrics-read";

export interface MetricsRefreshOutcome {
  /** Posted replies in the window with a readable status link. */
  considered: number;
  /** Of those, read already today: not asked again. */
  alreadyToday: number;
  /** Ids sent to X. */
  asked: number;
  /** Posts X returned. */
  returned: number;
  /** Ids X did not return: stored as a row of nulls. */
  missing: number;
  stored: number;
  costUsd: number;
  stopped: MeteredRefusal | null;
  note: string | null;
}

interface PostedRow {
  id: string;
  user_id: string;
  business_id: string | null;
  published_url: string | null;
  published_at: string | null;
}

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** The replies to read today, newest first, at most `limit`, each with its status id. */
export function pickRepliesToRead(
  rows: PostedRow[],
  readToday: ReadonlySet<string>,
  limit: number = X_METRICS_MAX_IDS_PER_RUN
): { picked: Array<PostedRow & { statusId: string }>; considered: number; alreadyToday: number } {
  const withIds = rows
    .map((row) => ({ ...row, statusId: row.published_url ? xStatusIdOf(row.published_url) : null }))
    .filter((row): row is PostedRow & { statusId: string } => row.statusId !== null);
  const fresh = withIds.filter((row) => !readToday.has(row.id));
  // One reply per status id: the same link saved twice is one read.
  const seen = new Set<string>();
  const picked: Array<PostedRow & { statusId: string }> = [];
  for (const row of fresh) {
    if (seen.has(row.statusId) || picked.length >= limit) continue;
    seen.add(row.statusId);
    picked.push(row);
  }
  return { picked, considered: withIds.length, alreadyToday: withIds.length - fresh.length };
}

/**
 * Reads today's numbers for the posted replies of `businessIds` (the sites
 * that opted in, owners who pay: the caller decides). `admin` is the service
 * role. Never throws for anything X did; the outcome says it.
 */
export async function refreshXReplyMetrics(params: {
  admin: SupabaseClient;
  client: XApiClient | null;
  businessIds: string[];
  now?: Date;
  signal?: AbortSignal;
}): Promise<MetricsRefreshOutcome> {
  const now = params.now ?? new Date();
  const day = utcDay(now);
  const outcome: MetricsRefreshOutcome = {
    considered: 0,
    alreadyToday: 0,
    asked: 0,
    returned: 0,
    missing: 0,
    stored: 0,
    costUsd: 0,
    stopped: null,
    note: null,
  };
  if (params.businessIds.length === 0) return outcome;

  const since = new Date(now.getTime() - X_METRICS_WINDOW_DAYS * 86_400_000).toISOString();
  const { data, error } = await params.admin
    .from("placement_targets")
    .select("id, user_id, business_id, published_url, published_at")
    .in("business_id", params.businessIds)
    .eq("surface", "x")
    .eq("status", "published_manually")
    .not("published_url", "is", null)
    .gte("published_at", since)
    .order("published_at", { ascending: false })
    .limit(X_METRICS_MAX_IDS_PER_RUN * 3);
  if (error) throw new Error(`posted replies: ${error.message}`);
  const rows = (data ?? []) as PostedRow[];
  if (rows.length === 0) return outcome;

  const { data: todayRows, error: todayError } = await params.admin
    .from(PLACEMENT_METRICS_TABLE)
    .select("target_id")
    .eq("day", day)
    .in("target_id", rows.map((r) => r.id));
  if (todayError) throw new Error(`reply metrics: ${todayError.message}`);
  const readToday = new Set(((todayRows ?? []) as Array<{ target_id: string }>).map((r) => r.target_id));

  const { picked, considered, alreadyToday } = pickRepliesToRead(rows, readToday);
  outcome.considered = considered;
  outcome.alreadyToday = alreadyToday;
  if (picked.length === 0) return outcome;

  const ids = [...new Set(picked.map((r) => r.statusId))];
  const called = await meteredXCall({
    supabase: params.admin,
    client: params.client,
    worstCaseUsd: lookupWorstCaseUsd(ids.length),
    now,
    run: (client) => client.lookup(ids, params.signal),
  });
  if (!called.ok) {
    outcome.stopped = called.reason;
    outcome.note = called.message;
    return outcome;
  }

  outcome.asked = ids.length;
  outcome.returned = called.result.billedPosts;
  outcome.costUsd = called.result.costUsd;
  const byId = new Map(called.result.posts.map((post) => [post.id, post]));
  const fetchedAt = now.toISOString();
  const snapshots = picked.map((row) => {
    const post = byId.get(row.statusId);
    if (!post) outcome.missing += 1;
    const m = post?.metrics;
    return {
      target_id: row.id,
      user_id: row.user_id,
      business_id: row.business_id,
      day,
      impressions: m?.impressions ?? null,
      likes: m?.likes ?? null,
      replies: m?.replies ?? null,
      reposts: m?.reposts ?? null,
      quotes: m?.quotes ?? null,
      bookmarks: m?.bookmarks ?? null,
      fetched_at: fetchedAt,
    };
  });
  const { data: stored, error: storeError } = await params.admin
    .from(PLACEMENT_METRICS_TABLE)
    .upsert(snapshots, { onConflict: "target_id,day" })
    .select("target_id");
  if (storeError) throw new Error(`reply metrics upsert failed: ${storeError.message}`);
  outcome.stored = stored?.length ?? 0;
  return outcome;
}
