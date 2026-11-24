import type { SupabaseClient } from "@supabase/supabase-js";
import { authorHandle } from "./avatar";
import { loadRemovals } from "./removed";
import { loadReplyMetricsHistory } from "./reply-metrics-read";
import { summarizeReplyStats, type PostedXReply, type ReplyStats, type XAccountSnapshot } from "./reply-stats";
import { ownXHandle } from "./x-handle";

/**
 * Reading the week of a site's replies on X (`summarizeReplyStats`, pure,
 * in ./reply-stats.ts): Results → Replies on X (GET
 * /api/placements/reply-stats) and `get_reply_stats` call this, so the two
 * cannot disagree. Stored rows only: no call to X. Through the caller's
 * client: RLS (or the owner-scoped service role) is the access control,
 * `business_id` the scope.
 */

export const X_ACCOUNT_METRICS_TABLE = "x_account_metrics";

/**
 * Two periods of replies, the snapshots behind them, and the followers'
 * change over the period with its slack: 14, 16 and 16 days for a week; 56,
 * 58 and 37 for 28 days.
 */
const replyDays = (days: number) => 2 * days;
const snapshotDays = (days: number) => 2 * days + 2;
const accountDays = (days: number) => Math.max(16, days + 9);
const MAX_REPLIES = 500;
/** Snapshot rows read at most: a reply is read daily for 14 days after it was posted. */
const MAX_SNAPSHOTS = 5000;

type Row = Record<string, unknown>;

const str = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

function count(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * The site's own account, one snapshot per day, newest first, over the last
 * `days` days; null when the table cannot be read (the migration not applied
 * yet, or a failed read): unknown, and the followers read "not measured".
 */
export async function loadXAccountHistory(
  supabase: SupabaseClient,
  businessId: string,
  options: { days?: number; now?: Date } = {}
): Promise<XAccountSnapshot[] | null> {
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - (options.days ?? accountDays(7)) * 86_400_000).toISOString().slice(0, 10);
  try {
    const { data, error } = await supabase
      .from(X_ACCOUNT_METRICS_TABLE)
      .select("day, handle, followers, following, posts, listed, fetched_at")
      .eq("business_id", businessId)
      .gte("day", since)
      .order("day", { ascending: false })
      .limit(60);
    if (error) return null;
    return ((data ?? []) as Row[]).map((row) => ({
      day: String(row.day ?? "").slice(0, 10),
      handle: String(row.handle ?? ""),
      followers: count(row.followers),
      following: count(row.following),
      posts: count(row.posts),
      listed: count(row.listed),
      fetchedAt: String(row.fetched_at ?? ""),
    }));
  } catch {
    return null;
  }
}

/**
 * The week on X for a site (or 28 days, `days: 28`, Growth's switch).
 * `xApiEnabled` is the platform's opt-in, passed by the caller so this
 * module reads no environment. Throws only when the posted replies
 * themselves cannot be read.
 */
export async function loadReplyStats(
  supabase: SupabaseClient,
  businessId: string,
  options: { xApiEnabled: boolean; now?: Date; days?: number }
): Promise<ReplyStats> {
  const now = options.now ?? new Date();
  const days = options.days ?? 7;
  const since = new Date(now.getTime() - replyDays(days) * 86_400_000).toISOString();
  const [{ data, error }, handle, account] = await Promise.all([
    supabase
      .from("placement_targets")
      .select("id, url, author, community, published_url, published_at, published_text, selected_placement_id")
      .eq("business_id", businessId)
      .eq("surface", "x")
      .eq("status", "published_manually")
      .gte("published_at", since)
      .order("published_at", { ascending: false })
      .limit(MAX_REPLIES),
    ownXHandle(supabase, businessId),
    loadXAccountHistory(supabase, businessId, { now, days: accountDays(days) }),
  ]);
  if (error) throw new Error(`posted replies: ${error.message}`);
  const rows = ((data ?? []) as Row[]).filter((row) => typeof row.published_at === "string");
  const ids = rows.map((row) => row.id as string);

  const [removals, history, drafts] = await Promise.all([
    loadRemovals(supabase, businessId, ids),
    loadReplyMetricsHistory(supabase, businessId, { targetIds: ids, days: snapshotDays(days), now, limit: MAX_SNAPSHOTS }),
    ids.length === 0
      ? Promise.resolve({ data: [] as Row[], error: null })
      : supabase.from("placements").select("id, target_id, body").in("target_id", ids).order("created_at", { ascending: true }),
  ]);

  const draftsByTarget = new Map<string, Array<{ id: string; body: string }>>();
  for (const row of (drafts.error ? [] : (drafts.data ?? [])) as Row[]) {
    const list = draftsByTarget.get(row.target_id as string) ?? [];
    list.push({ id: row.id as string, body: String(row.body ?? "") });
    draftsByTarget.set(row.target_id as string, list);
  }

  const replies: PostedXReply[] = rows.map((row) => {
    const id = row.id as string;
    const list = draftsByTarget.get(id) ?? [];
    const posted = str(row.published_text)?.trim() || (list.find((d) => d.id === row.selected_placement_id) ?? list[0])?.body.trim() || null;
    return {
      id,
      publishedAt: row.published_at as string,
      publishedUrl: str(row.published_url),
      threadUrl: String(row.url ?? ""),
      threadAuthor: authorHandle({ surface: "x", author: str(row.author), community: str(row.community) }),
      text: posted,
      // When the removals cannot be read, the reply is counted, as the
      // inbox shows it while the column cannot be read.
      removed: Boolean(removals?.get(id)),
      snapshots: history?.get(id) ?? [],
    };
  });

  return summarizeReplyStats({
    now,
    days,
    platformEnabled: options.xApiEnabled,
    replies,
    metricsReadable: history !== null,
    handle,
    account,
  });
}
