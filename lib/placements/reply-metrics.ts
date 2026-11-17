import { z } from "zod";

/**
 * The public numbers of a posted reply, as X reported them on one day
 * (`placement_metrics`, read by lib/placements/x-metrics.ts). Pure, so the
 * inbox, the tools and the tests read the same shape and the same line.
 *
 * A number X did not return is null, never 0: "0 likes" is a measurement,
 * a missing number is not. A snapshot whose numbers are all null means X was
 * asked and gave nothing back (a deleted or protected reply).
 */

export const ReplyMetrics = z.object({
  day: z.string().describe("The UTC day of the snapshot, YYYY-MM-DD."),
  impressions: z.number().nullable(),
  likes: z.number().nullable(),
  replies: z.number().nullable(),
  reposts: z.number().nullable(),
  quotes: z.number().nullable(),
  bookmarks: z.number().nullable(),
  fetchedAt: z.string(),
});

export type ReplyMetrics = z.infer<typeof ReplyMetrics>;

type Row = Record<string, unknown>;

function count(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function mapReplyMetrics(row: Row): ReplyMetrics {
  return {
    day: String(row.day ?? "").slice(0, 10),
    impressions: count(row.impressions),
    likes: count(row.likes),
    replies: count(row.replies),
    reposts: count(row.reposts),
    quotes: count(row.quotes),
    bookmarks: count(row.bookmarks),
    fetchedAt: String(row.fetched_at ?? ""),
  };
}

/** True when X returned no number at all for the reply that day. */
export function metricsMissing(m: ReplyMetrics): boolean {
  return [m.impressions, m.likes, m.replies, m.reposts, m.quotes, m.bookmarks].every((v) => v === null);
}

/** 950, 1.2k, 12k, 3.4M: how a count reads in one quiet line. */
export function compactCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(Math.floor(n / 100) / 10).toString()}k`;
  if (n < 1_000_000) return `${Math.floor(n / 1000)}k`;
  return `${(Math.floor(n / 100_000) / 10).toString()}M`;
}

function plural(n: number, one: string, many: string): string {
  return `${compactCount(n)} ${n === 1 ? one : many}`;
}

/** "as of today", "as of yesterday", "as of Nov 9": the snapshot's day against today (UTC). */
export function asOf(day: string, now: Date): string {
  const today = now.toISOString().slice(0, 10);
  if (day === today) return "as of today";
  const yesterday = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
  if (day === yesterday) return "as of yesterday";
  const at = new Date(`${day}T00:00:00Z`);
  if (!Number.isFinite(at.getTime())) return "";
  return `as of ${at.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}`;
}

/**
 * One quiet line for a posted reply: "1.2k views · 8 likes · 2 replies ·
 * as of today". Only the numbers X returned are named; reposts, quotes and
 * bookmarks only when there are some, so the line stays short. Null with
 * no snapshot.
 */
export function metricsLine(metrics: ReplyMetrics | null | undefined, now: Date = new Date()): string | null {
  if (!metrics) return null;
  const when = asOf(metrics.day, now);
  if (metricsMissing(metrics)) return `X returned no numbers for this reply${when ? ` · ${when}` : ""}`;
  const parts: string[] = [];
  if (metrics.impressions !== null) parts.push(plural(metrics.impressions, "view", "views"));
  if (metrics.likes !== null) parts.push(plural(metrics.likes, "like", "likes"));
  if (metrics.replies !== null) parts.push(plural(metrics.replies, "reply", "replies"));
  if (metrics.reposts) parts.push(plural(metrics.reposts, "repost", "reposts"));
  if (metrics.quotes) parts.push(plural(metrics.quotes, "quote", "quotes"));
  if (metrics.bookmarks) parts.push(plural(metrics.bookmarks, "bookmark", "bookmarks"));
  if (when) parts.push(when);
  return parts.join(" · ");
}
