import { z } from "zod";
import { UI_LOCALE, formatCount } from "@/lib/format";
import { xStatusIdOf } from "./published-url";
import { ReplyMetrics, metricsMissing } from "./reply-metrics";

/**
 * The week of the person's replies on X, summed (Results → Replies on X,
 * `get_reply_stats`, docs/PLACEMENTS.md "The week on X"). Pure: the route,
 * the tool and the tests read the same numbers from the same rows.
 *
 * What "the week's views" means, honestly. X's numbers on a reply are
 * running public counters (impressions, likes, replies, reposts), read once
 * a day into `placement_metrics` for the 14 days after posting. Summing them
 * over the replies posted in the last 7 days gives the views *so far* of
 * those replies, not the views that happened during the week: a reply posted
 * yesterday has had one day to collect them. So the 7 days before are read
 * the same way, as of their own last day (the snapshot day of this week's
 * numbers, minus 7), and the change compares like with like: each week's
 * replies, counted as of the end of that week.
 *
 * Honest numbers: a reply is measured when its link is saved and X returned
 * numbers for it in a snapshot by that day. A sum is over the measured
 * replies whose number X returned; with none, it is null ("not measured"),
 * never 0. Coverage is said ("3 of 5 replies measured"). A reply marked as
 * removed is not counted, as on the Overview.
 *
 * Followers: the site's own account, read once a day into
 * `x_account_metrics` (lib/placements/x-account.ts). The change over 7 days
 * needs both ends read, from the same account. Profile visits are not in
 * X's public numbers and are not shown.
 */

const DAY_MS = 86_400_000;

/** The window a week covers, and the one before it. */
export const REPLY_WEEK_DAYS = 7;

/** At most this many replies in the top list. */
export const TOP_REPLIES = 3;

/** How long a reply's text is kept for the top list. */
export const TOP_TEXT_MAX = 280;

/** A follower count this many days older (and up to two more, a missed run) is the change's other end. */
export const FOLLOWERS_CHANGE_DAYS = 7;
const FOLLOWERS_CHANGE_SLACK_DAYS = 2;

/** The one line under the numbers: what they are, for a period of `days`. */
export function replyStatsNote(days: number = REPLY_WEEK_DAYS): string {
  return `Counts so far on the replies posted in the last ${days} days, as X shows them, read once a day. The ${days} days before are compared as of their own last day.`;
}

/** The note for the week, as Results and `get_reply_stats` have always said it. */
export const REPLY_STATS_NOTE = replyStatsNote(REPLY_WEEK_DAYS);

const METRIC_KEYS = ["views", "likes", "replies", "reposts"] as const;
type MetricKey = (typeof METRIC_KEYS)[number];

const COLUMN: Record<MetricKey, "impressions" | "likes" | "replies" | "reposts"> = {
  views: "impressions",
  likes: "likes",
  replies: "replies",
  reposts: "reposts",
};

// ── The shapes (the route's answer and the tool's output) ────────────────────

const Count = z.number().nullable();

export const ReplyWeek = z.object({
  from: z.string().describe("Start of the window, inclusive (ISO)."),
  to: z.string().describe("End of the window, exclusive (ISO)."),
  asOfDay: z.string().describe("The UTC day the numbers are read as of: the newest snapshot for this week, that day minus 7 for the week before."),
  posted: z.number().describe("Replies marked as posted on X in the window, removed ones left out."),
  measured: z.number().describe("Of those, the ones with their link saved and numbers from X by asOfDay."),
  withoutLink: z.number().describe("Of those, the ones with no link to the reply saved: they cannot be measured."),
  views: Count.describe("Sum of X's impression counts over the measured replies; null when none is measured, never 0 for that."),
  likes: Count,
  replies: Count.describe("Replies the person's replies received."),
  reposts: Count,
});
export type ReplyWeek = z.infer<typeof ReplyWeek>;

export const TopReply = z.object({
  targetId: z.string(),
  text: z.string().nullable().describe("The reply as posted (read back from X), else the draft marked as posted; null when none is on record."),
  publishedUrl: z.string().describe("The reply on X."),
  publishedAt: z.string(),
  threadUrl: z.string().describe("The post that was answered."),
  threadAuthor: z.string().nullable().describe("Who was answered, without @; null when not on record."),
  day: z.string().describe("The UTC day of the snapshot the numbers come from."),
  views: Count,
  likes: Count,
  replies: Count,
  reposts: Count,
});
export type TopReply = z.infer<typeof TopReply>;

export const AccountFollowers = z.object({
  handle: z.string().nullable().describe("The site's own X account: the one the person gave (update_voice_settings xHandle), else the one its saved reply links name; null when neither."),
  day: z.string().nullable().describe("The UTC day of the newest snapshot; null when never read."),
  followers: Count.describe("Followers on that day; null when never read or X returned nothing."),
  following: Count,
  posts: Count,
  listed: Count,
  change: Count.describe("Followers on `day` minus followers on `changeSince`; null unless both were read, from the same account."),
  changeSince: z.string().nullable(),
});
export type AccountFollowers = z.infer<typeof AccountFollowers>;

export const ReplyStats = z.object({
  days: z
    .number()
    .describe("The length of the period, in days: 7 (the default) or 28. `week` is these days and `previousWeek` the same length before."),
  status: z
    .enum(["on", "off_platform"])
    .describe("on: the numbers are read daily (every site, since 2026-11-24); off_platform: the X API is not set up on GetTrafficFast."),
  measured: z.boolean().describe("False when the stored reply numbers could not be read at all: unknown, not zero."),
  note: z.string(),
  week: ReplyWeek,
  previousWeek: ReplyWeek,
  change: z
    .object({ views: Count, likes: Count, replies: Count, reposts: Count })
    .describe("This week minus the week before, per number; null unless both sums are measured."),
  top: z.array(TopReply).describe("This week's measured replies with the most views, at most 3."),
  followers: AccountFollowers,
});
export type ReplyStats = z.infer<typeof ReplyStats>;

// ── The input (what the reader hands over) ──────────────────────────────────

/** A reply marked as posted on X, with its snapshots newest first. */
export interface PostedXReply {
  id: string;
  publishedAt: string;
  publishedUrl: string | null;
  threadUrl: string;
  threadAuthor: string | null;
  text: string | null;
  removed: boolean;
  snapshots: readonly ReplyMetrics[];
}

/** One day of the site's own account, as stored. */
export interface XAccountSnapshot {
  day: string;
  handle: string;
  followers: number | null;
  following: number | null;
  posts: number | null;
  listed: number | null;
  fetchedAt: string;
}

export interface ReplyStatsInput {
  now: Date;
  /** The period, in days: 7 (default) or 28. */
  days?: number;
  platformEnabled: boolean;
  replies: readonly PostedXReply[];
  /** False when the reply numbers could not be read. */
  metricsReadable: boolean;
  /** The handle the saved links name, when the account was never read. */
  handle: string | null;
  /** Newest first; null when the table could not be read. */
  account: readonly XAccountSnapshot[] | null;
}

// ── The arithmetic ──────────────────────────────────────────────────────────

function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function shiftDay(day: string, days: number): string {
  return utcDay(new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS));
}

/** The newest snapshot on or before `day` (snapshots newest first). */
function snapshotAsOf(snapshots: readonly ReplyMetrics[], day: string): ReplyMetrics | null {
  for (const s of snapshots) if (s.day <= day) return s;
  return null;
}

function hasLink(reply: PostedXReply): boolean {
  return Boolean(reply.publishedUrl && xStatusIdOf(reply.publishedUrl));
}

function inWindow(reply: PostedXReply, from: number, to: number): boolean {
  const at = Date.parse(reply.publishedAt);
  return Number.isFinite(at) && at >= from && at < to;
}

/** Measured: a link saved, and X's numbers for it in a snapshot by `asOfDay`. */
function measuredSnapshot(reply: PostedXReply, asOfDay: string): ReplyMetrics | null {
  if (!hasLink(reply)) return null;
  const snap = snapshotAsOf(reply.snapshots, asOfDay);
  return snap && !metricsMissing(snap) ? snap : null;
}

export function summarizeWeek(
  replies: readonly PostedXReply[],
  window: { from: number; to: number; asOfDay: string },
  metricsReadable = true
): ReplyWeek {
  const week = replies.filter((r) => !r.removed && inWindow(r, window.from, window.to));
  const sums: Record<MetricKey, number | null> = { views: null, likes: null, replies: null, reposts: null };
  let measured = 0;
  for (const reply of week) {
    const snap = metricsReadable ? measuredSnapshot(reply, window.asOfDay) : null;
    if (!snap) continue;
    measured += 1;
    for (const key of METRIC_KEYS) {
      const value = snap[COLUMN[key]];
      if (value !== null) sums[key] = (sums[key] ?? 0) + value;
    }
  }
  return {
    from: new Date(window.from).toISOString(),
    to: new Date(window.to).toISOString(),
    asOfDay: window.asOfDay,
    posted: week.length,
    measured,
    withoutLink: week.filter((r) => !hasLink(r)).length,
    ...sums,
  };
}

/** A reply's words for the list: whitespace folded, at most TOP_TEXT_MAX characters. */
export function snippet(text: string | null | undefined): string | null {
  const folded = (text ?? "").replace(/\s+/g, " ").trim();
  if (!folded) return null;
  return folded.length > TOP_TEXT_MAX ? `${folded.slice(0, TOP_TEXT_MAX - 1).trimEnd()}…` : folded;
}

/** This week's measured replies with the most views: views, then likes, then the newest. */
export function topReplies(replies: readonly PostedXReply[], window: { from: number; to: number; asOfDay: string }): TopReply[] {
  const rows: TopReply[] = [];
  for (const reply of replies) {
    if (reply.removed || !inWindow(reply, window.from, window.to)) continue;
    const snap = measuredSnapshot(reply, window.asOfDay);
    if (!snap || snap.impressions === null) continue;
    rows.push({
      targetId: reply.id,
      text: snippet(reply.text),
      publishedUrl: reply.publishedUrl as string,
      publishedAt: reply.publishedAt,
      threadUrl: reply.threadUrl,
      threadAuthor: reply.threadAuthor,
      day: snap.day,
      views: snap.impressions,
      likes: snap.likes,
      replies: snap.replies,
      reposts: snap.reposts,
    });
  }
  return rows
    .sort(
      (a, b) =>
        (b.views ?? 0) - (a.views ?? 0) || (b.likes ?? -1) - (a.likes ?? -1) || b.publishedAt.localeCompare(a.publishedAt)
    )
    .slice(0, TOP_REPLIES);
}

/**
 * The followers now and over the period (7 days unless `days` says 28). The
 * other end is the newest snapshot `days` to `days` + 2 days older than the
 * newest (a missed daily run is not a gap), of the same account: a renamed
 * or changed handle compares two accounts.
 */
export function summarizeFollowers(
  snapshots: readonly XAccountSnapshot[] | null,
  handle: string | null,
  days: number = FOLLOWERS_CHANGE_DAYS
): AccountFollowers {
  const latest = snapshots?.[0] ?? null;
  const out: AccountFollowers = {
    handle: latest?.handle ?? handle,
    day: latest?.day ?? null,
    followers: latest?.followers ?? null,
    following: latest?.following ?? null,
    posts: latest?.posts ?? null,
    listed: latest?.listed ?? null,
    change: null,
    changeSince: null,
  };
  if (!latest || latest.followers === null || !snapshots) return out;
  const newest = shiftDay(latest.day, -days);
  const oldest = shiftDay(latest.day, -(days + FOLLOWERS_CHANGE_SLACK_DAYS));
  const base = snapshots.find((s) => s.day <= newest && s.day >= oldest);
  if (!base || base.followers === null || base.handle.toLowerCase() !== latest.handle.toLowerCase()) return out;
  return { ...out, change: latest.followers - base.followers, changeSince: base.day };
}

function difference(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : a - b;
}

export function summarizeReplyStats(input: ReplyStatsInput): ReplyStats {
  const days = input.days ?? REPLY_WEEK_DAYS;
  const now = input.now.getTime();
  const today = utcDay(input.now);
  // This week is read as of the newest snapshot there is (today once the
  // daily run has been), the week before as of 7 days earlier: each week
  // counted at the same distance from its own end.
  let asOfDay = "";
  for (const reply of input.replies) {
    for (const s of reply.snapshots) if (s.day <= today && s.day > asOfDay) asOfDay = s.day;
  }
  if (!asOfDay) asOfDay = today;
  const week = { from: now - days * DAY_MS, to: now, asOfDay };
  const before = { from: now - 2 * days * DAY_MS, to: week.from, asOfDay: shiftDay(asOfDay, -days) };

  const thisWeek = summarizeWeek(input.replies, week, input.metricsReadable);
  const previousWeek = summarizeWeek(input.replies, before, input.metricsReadable);
  return {
    days,
    status: !input.platformEnabled ? "off_platform" : "on",
    measured: input.metricsReadable,
    note: replyStatsNote(days),
    week: thisWeek,
    previousWeek,
    change: {
      views: difference(thisWeek.views, previousWeek.views),
      likes: difference(thisWeek.likes, previousWeek.likes),
      replies: difference(thisWeek.replies, previousWeek.replies),
      reposts: difference(thisWeek.reposts, previousWeek.reposts),
    },
    top: input.metricsReadable ? topReplies(input.replies, week) : [],
    followers: summarizeFollowers(input.account, input.handle, days),
  };
}

// ── What a person reads ─────────────────────────────────────────────────────

const COMPACT = new Intl.NumberFormat(UI_LOCALE, { notation: "compact", maximumFractionDigits: 1 });

/** "950", "9,870", "12.4K", "3.4M": in full under 10,000, short above. */
export function statNumber(n: number): string {
  return Math.abs(n) < 10_000 ? formatCount(n) : COMPACT.format(n);
}

/** "+1,240", "−4", "same": a change as it reads beside a number. */
export function signedChange(n: number): string {
  if (n === 0) return "same";
  return `${n > 0 ? "+" : "−"}${statNumber(Math.abs(n))}`;
}

/** "3 of 5 replies measured · 2 without a link", or "5 replies, all measured". */
export function coverageLine(week: Pick<ReplyWeek, "posted" | "measured" | "withoutLink">, days: number = REPLY_WEEK_DAYS): string {
  if (week.posted === 0) return `No replies posted on X in the last ${days} days.`;
  const replies = week.posted === 1 ? "reply" : "replies";
  if (week.measured === week.posted) return week.posted === 1 ? "1 reply, measured" : `${week.posted} replies, all measured`;
  const link = week.withoutLink > 0 ? ` · ${week.withoutLink} without a link` : "";
  return `${week.measured} of ${week.posted} ${replies} measured${link}`;
}

/** The sentence when there is nothing to sum, or null when there is. */
export function offLine(status: ReplyStats["status"]): string | null {
  if (status === "off_platform") return "Numbers from X are not available yet: reading X is not set up on GetTrafficFast.";
  return null;
}
