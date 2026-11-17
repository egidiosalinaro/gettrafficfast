/**
 * "N today": the replies the person marked as posted today.
 *
 * The routine is a handful of replies a day, and the inbox had no end: a
 * count gives it one. It is a count of what was recorded ("I posted it"),
 * never of what is on the other site, and a reply marked as removed is left
 * out, the way the Overview leaves it out of "posted in the last 7 days".
 *
 * "Today" needs a time zone. The app stores none, so the page sends the
 * browser's (`tz`, an IANA name); a missing or unknown one falls back to
 * UTC, and the payload says which zone was used so the page can say so.
 * The goal is the person's own number (Settings → Voice, `dailyReplyGoal`),
 * null until they set one: no default is invented.
 */

import type { ReplyMetrics } from "./reply-metrics";
import { linkFinding, linkSourceOf, type LinkSearchRecord, type LinkSource } from "./reply-link";

/**
 * One reply of today's list (the popup behind "N of G today", 2026-11-12):
 * the few fields a row shows, no more. The same rule as the count picks
 * them (`postedTodayRows`), so the list and the number never disagree.
 */
export interface TodayReply {
  id: string;
  surface: string;
  /** Who was answered, as stored; null when the source gave no author. */
  author: string | null;
  /** On X, "@name": the handle when `author` was not stored. */
  community: string | null;
  /** The post that was answered. */
  url: string;
  /** The first line of the reply as posted (read back, else the posted draft); null when no text is on record. */
  text: string | null;
  publishedAt: string;
  /** The link to the reply itself; null until the person saves it. */
  publishedUrl: string | null;
  /** X's newest public numbers for the reply; null when none were read. */
  metrics: ReplyMetrics | null;
  /**
   * Who gave the saved link (`found_on_x`: GTF found it on X; `person`);
   * null with no link. Absent when the searches could not be read.
   */
  linkSource?: LinkSource | null;
  /**
   * GTF's search on X for the reply's link (lib/placements/reply-link.ts);
   * null when never searched. Absent when the searches could not be read:
   * unknown, so Today never says GTF is looking.
   */
  linkSearch?: LinkSearchRecord | null;
}

export interface TodayCount {
  /** Replies marked as posted today, removed ones aside. */
  posted: number;
  /** The person's daily goal, or null when none is stored. */
  goal: number | null;
  /** The zone "today" was read in: the browser's, or "UTC". */
  timeZone: string;
  /**
   * The replies counted in `posted`, newest first. Absent on an older
   * payload, or when their text could not be read: unknown, not "none".
   */
  replies?: TodayReply[];
}

/** The zone as given when the runtime knows it, else "UTC". */
export function safeTimeZone(value: string | null | undefined): string {
  const zone = (value ?? "").trim();
  if (!zone) return "UTC";
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: zone });
    return zone;
  } catch {
    return "UTC";
  }
}

/** The browser's IANA time zone, which the page sends as `tz`; null when it cannot be read. */
export function browserTimeZone(): string | null {
  try {
    return new Intl.DateTimeFormat("en-US").resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/** The calendar day ("2026-11-10") an instant falls on in a zone; null for no date. */
export function dayIn(iso: string | null | undefined, timeZone: string): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

type DayRow = { status?: unknown; published_at?: unknown; removed_at?: unknown };

/** The rows "N today" counts: marked as posted, not marked as removed, posted on today's date in the zone. */
export function postedTodayRows<R extends DayRow>(rows: readonly R[], now: Date, timeZone: string): R[] {
  const today = dayIn(now.toISOString(), timeZone);
  return rows.filter(
    (row) =>
      row.status === "published_manually" &&
      !row.removed_at &&
      typeof row.published_at === "string" &&
      dayIn(row.published_at, timeZone) === today
  );
}

export function postedToday(rows: readonly DayRow[], now: Date, timeZone: string): number {
  return postedTodayRows(rows, now, timeZone).length;
}

/**
 * The earliest instant "today" can have started in any zone: a local day is
 * under 24 hours old (26 on the day a zone moves its clock), so 27 hours
 * back covers every zone. What a caller without the site's rows in hand
 * narrows its read to before applying `postedTodayRows`.
 */
export function todayWindowStart(now: Date): string {
  return new Date(now.getTime() - 27 * 3_600_000).toISOString();
}

/** What is read of one of today's rows to show it. */
export interface TodayReplyDetail {
  surface: string;
  author: string | null;
  community: string | null;
  url: string;
  publishedAt: string;
  publishedUrl: string | null;
  publishedText: string | null;
  selectedPlacementId: string | null;
}

/**
 * Today's list from the rows the count picked and what was read of them:
 * the reply's first line (read back from X, else the draft marked as
 * posted, else the first draft, as the posted item shows it) and its newest
 * numbers. Newest first. A row whose details were not read is left out
 * rather than shown with invented fields.
 */
export function todayReplies(
  picked: readonly { id?: unknown }[],
  details: ReadonlyMap<string, TodayReplyDetail>,
  drafts: ReadonlyMap<string, readonly { id: string; body: string }[]>,
  metrics: ReadonlyMap<string, ReplyMetrics> | null,
  /** The link searches of these replies, by id; null when they could not be read, absent when not asked. */
  searches?: ReadonlyMap<string, LinkSearchRecord> | null
): TodayReply[] {
  const out: TodayReply[] = [];
  for (const row of picked) {
    const id = String(row.id ?? "");
    const d = details.get(id);
    if (!d) continue;
    const list = drafts.get(id) ?? [];
    const read = d.publishedText?.trim();
    const posted = read || ((list.find((x) => x.id === d.selectedPlacementId) ?? list[0])?.body.trim() ?? "");
    const first = posted.split("\n").find((line) => line.trim())?.trim() ?? "";
    out.push({
      id,
      surface: d.surface,
      author: d.author,
      community: d.community,
      url: d.url,
      text: first || null,
      publishedAt: d.publishedAt,
      publishedUrl: d.publishedUrl,
      metrics: metrics?.get(id) ?? null,
      ...(searches
        ? { linkSearch: searches.get(id) ?? null, linkSource: linkSourceOf(d.publishedUrl, searches.get(id) ?? null) }
        : {}),
    });
  }
  return out.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}

/**
 * Where the links of today's replies stand: the line under "3 of 5 replies"
 * on Today (2026-11-14). How many have their link (and how many of those GTF
 * found on X by itself), how many GTF is still looking for on X, how many
 * the person has to paste. Read with `linkFinding`, the rule the posted
 * reply and its row use, so the three never disagree. Null with no reply
 * today, or when the list could not be read.
 */
export interface TodayLinks {
  total: number;
  linked: number;
  foundOnX: number;
  looking: number;
  toPaste: number;
  /** "Links of all 3 found on X", "GTF is looking for 2 on X · 1 link to paste", … */
  line: string;
  /** done: every reply has its link; waiting: only GTF's search is left; todo: a link to paste. */
  tone: "done" | "waiting" | "todo";
}

export function todayLinks(replies: readonly TodayReply[] | undefined, ctx: { finderOn: boolean; now: number }): TodayLinks | null {
  if (!replies || replies.length === 0) return null;
  let linked = 0;
  let foundOnX = 0;
  let looking = 0;
  for (const reply of replies) {
    if ((reply.publishedUrl ?? "").trim()) {
      linked += 1;
      if (reply.linkSource === "found_on_x") foundOnX += 1;
      continue;
    }
    const finding = linkFinding(
      {
        surface: reply.surface,
        status: "published_manually",
        url: reply.url,
        publishedUrl: reply.publishedUrl,
        publishedAt: reply.publishedAt,
        removedAt: null,
        // Absent stays absent: searches not read, so not "looking".
        ...("linkSearch" in reply ? { linkSearch: reply.linkSearch } : {}),
      },
      ctx
    );
    if (finding?.state === "looking") looking += 1;
  }
  const total = replies.length;
  const toPaste = total - linked - looking;
  const counts = { total, linked, foundOnX, looking, toPaste };
  return { ...counts, line: todayLinksLine(counts), tone: toPaste > 0 ? "todo" : looking > 0 ? "waiting" : "done" };
}

/** The line itself, from the counts. */
export function todayLinksLine(c: Pick<TodayLinks, "total" | "linked" | "foundOnX" | "looking" | "toPaste">): string {
  if (c.linked === c.total) {
    if (c.foundOnX === c.total) return c.total === 1 ? "Link found on X" : `Links of all ${c.total} found on X`;
    return c.total === 1 ? "Link saved" : `Links of all ${c.total} saved`;
  }
  const parts: string[] = [];
  if (c.looking > 0) parts.push(`GTF is looking for ${c.looking} on X`);
  if (c.toPaste > 0) parts.push(`${c.toPaste} ${c.toPaste === 1 ? "link" : "links"} to paste`);
  return parts.join(" · ");
}

/** "4 of 5 replies posted" with a goal, "1 reply posted" without: the popup's count line. */
export function todayCountLine(today: Pick<TodayCount, "posted" | "goal">): string {
  if (today.goal) return `${today.posted} of ${today.goal} ${today.goal === 1 ? "reply" : "replies"} posted`;
  return `${today.posted} ${today.posted === 1 ? "reply" : "replies"} posted`;
}

/** The goal one step up or down, held from 1 to `max`; a step from no goal starts at 1. */
export function stepGoal(goal: number | null, delta: 1 | -1, max: number): number {
  if (goal === null) return 1;
  return Math.min(max, Math.max(1, goal + delta));
}

/** Today's progress card: "3 of 5 replies" with a goal, "2 replies today" or "No replies yet today" without. */
export function todayProgressLine(today: Pick<TodayCount, "posted" | "goal">): string {
  if (today.goal) return `${today.posted} of ${today.goal} ${today.goal === 1 ? "reply" : "replies"}`;
  if (today.posted === 0) return "No replies yet today";
  return `${today.posted} ${today.posted === 1 ? "reply" : "replies"} today`;
}

/** How far along the goal is, from 0 to 1; null without a goal. */
export function todayProgress(today: Pick<TodayCount, "posted" | "goal">): number | null {
  if (!today.goal) return null;
  return Math.min(1, today.posted / today.goal);
}

/** "2 of 5 today" with a goal, "2 today" without. */
export function todayLabel(today: Pick<TodayCount, "posted" | "goal">): string {
  return today.goal ? `${today.posted} of ${today.goal} today` : `${today.posted} today`;
}

/** The dots beside the count: one per reply of the goal, filled as they are posted. None without a goal. */
export function todayDots(today: Pick<TodayCount, "posted" | "goal">): boolean[] {
  // Past ten a row of dots is a bar nobody counts: the number says it.
  if (!today.goal || today.goal > 10) return [];
  return Array.from({ length: today.goal }, (_, i) => i < today.posted);
}
