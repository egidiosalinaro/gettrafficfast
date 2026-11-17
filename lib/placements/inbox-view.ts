import type { AddOutcome } from "./manual";
import { missingPublishedLink } from "./published-url";
import { isEvergreenKind, replyWindowDays, UNDATED_GRACE_DAYS } from "./reply-window";
import { OPEN_STATUSES } from "./workflow";

export { REPLY_WINDOW_DAYS, UNDATED_GRACE_DAYS, replyWindowDays } from "./reply-window";

/**
 * The lists of the Replies page, and which rows belong to each.
 *
 * Since 2026-11-10 one control holds every way of narrowing the inbox: a
 * list ("To reply", "Posted, no link", "Snoozed", …), a platform and a
 * topic. A list is a status the server filters on (`status`, the query
 * parameter the route always took) plus a rule the page applies to the rows
 * it gets back, so no new status and no migration is needed: "Expired" and
 * "Snoozed" are open rows, "Posted, no link" and "Removed" are posted rows.
 * The same rule counts each list on the server (`viewCounts`), so the
 * number in the menu is the number of rows the list shows.
 *
 * Until that day a card the person acted on stayed where it was, marked as
 * moved, and a toast said where it went. Now it leaves at once: a reply
 * marked as posted is done, and the queue shows what is left.
 *
 * Since 2026-11-14 the screen (Today, `/today`) shows three of these lists
 * as tabs, `TODAY_VIEWS`: To do, Posted, Archive. The full list stays for
 * the route and the API, which keep every filter they had.
 */

export const INBOX_VIEWS = [
  { id: "to_reply", label: "To reply", status: "open" },
  { id: "posted_no_link", label: "Posted, no link", status: "published_manually" },
  { id: "posted", label: "Posted", status: "published_manually" },
  { id: "removed", label: "Removed", status: "published_manually" },
  { id: "snoozed", label: "Snoozed", status: "open" },
  { id: "expired", label: "Expired", status: "open" },
  { id: "ai_cited", label: "Cited by AI (sampled)", status: "open" },
  { id: "discovered", label: "Not sorted yet", status: "discovered" },
  { id: "rejected", label: "Filtered out", status: "rejected" },
  { id: "dismissed", label: "Skipped", status: "dismissed" },
  // Several statuses, each narrowed by its own rule: the route picks the rows by id (`ARCHIVE_STATUS`).
  { id: "archive", label: "Archive", status: "archive" },
  { id: "all", label: "All", status: "all" },
] as const;

/** The `status` value that asks the route for the Archive's rows. */
export const ARCHIVE_STATUS = "archive";

export type InboxViewId = (typeof INBOX_VIEWS)[number]["id"];

export const DEFAULT_VIEW: InboxViewId = "to_reply";

export function isInboxViewId(value: unknown): value is InboxViewId {
  return INBOX_VIEWS.some((view) => view.id === value);
}

/** The list's name, as the control, the loader and the toasts say it. */
export function viewLabel(id: InboxViewId): string {
  return INBOX_VIEWS.find((view) => view.id === id)?.label ?? id;
}

/** The `status` the server is asked for: "open", "all", or one status. */
export function viewStatus(id: InboxViewId): string {
  return INBOX_VIEWS.find((view) => view.id === id)?.status ?? "open";
}

/** What the rules read off a row. Every field is as the inbox record names it. */
export interface ViewRow {
  status: string;
  /** The platform and the kind of page, for the "To reply" window. Absent: only `freshUntil` counts. */
  surface?: string | null;
  kind?: string | null;
  /** When it was posted (the latest instant its precision allows), else null. */
  postedAt?: string | null;
  /**
   * When it was found: a floor on its age when the post has no date, but
   * never its age for the "To reply" window (2026-11-13, `undatedTooLong`).
   */
  createdAt?: string | null;
  foundVia?: string | null;
  qualifiedBy?: string | null;
  freshUntil?: string | null;
  snoozedUntil?: string | null;
  publishedUrl?: string | null;
  removedAt?: string | null;
  aiCitation?: unknown;
}

const isOpen = (status: string) => (OPEN_STATUSES as readonly string[]).includes(status);

/**
 * A post the person chose: pasted by hand (`found_via` manual), or judged by
 * them (`qualified_by` person, which a post found earlier takes when its
 * link is pasted). Everything else was found for them.
 */
export function isMine(row: Pick<ViewRow, "foundVia" | "qualifiedBy">): boolean {
  return row.foundVia === "manual" || row.qualifiedBy === "person";
}

export function isSnoozed(row: Pick<ViewRow, "status" | "snoozedUntil">, now: number): boolean {
  if (!isOpen(row.status) || !row.snoozedUntil) return false;
  const until = new Date(row.snoozedUntil).getTime();
  return Number.isFinite(until) && until > now;
}

const DAY_MS = 86_400_000;

/**
 * The least a row can be old, and what it is measured from: the post's date
 * (with a precision, the latest instant the source allows, so the age is a
 * floor) or, when the post has no date, when it was found, which is after
 * it was posted and so a floor too. Null when neither can be read.
 */
export function floorAge(
  row: Pick<ViewRow, "postedAt" | "createdAt">,
  now: number
): { ms: number; from: "posted" | "found" } | null {
  const read = (iso: string | null | undefined) => {
    const at = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(at) ? at : null;
  };
  const posted = read(row.postedAt);
  if (posted !== null) return { ms: Math.max(0, now - posted), from: "posted" };
  const found = read(row.createdAt);
  if (found !== null) return { ms: Math.max(0, now - found), from: "found" };
  return null;
}

/**
 * True when a found row is past its platform's "To reply" window, measured
 * from the post's date (a floor, see `floorAge`). Since 2026-11-13 a row with
 * no date is not aged from when it was found: that made an X post from
 * 5 October, found on 12 November, a day old. An undated row is
 * `undatedTooLong` instead.
 */
export function pastReplyWindow(row: ViewRow, now: number): boolean {
  const days = replyWindowDays(row.surface, row.kind);
  if (days === null) return false;
  const age = floorAge({ postedAt: row.postedAt, createdAt: null }, now);
  return age !== null && age.ms > days * DAY_MS;
}

/** Whether the row carries a post date that can be read. */
export function hasPostDate(row: Pick<ViewRow, "postedAt">): boolean {
  return Number.isFinite(row.postedAt ? Date.parse(row.postedAt) : NaN);
}

/**
 * A found row whose post date is still unknown, found more than
 * `UNDATED_GRACE_DAYS` ago (2026-11-13). Every free way to date it
 * (lib/placements/post-dates.ts) has had a week of discovery runs; what is
 * still undated is not presented as fresh. A list article and a repository
 * have no age and are left alone; a row whose found time is not given
 * cannot be measured at all and is left to its other rules.
 */
export function undatedTooLong(row: ViewRow, now: number): boolean {
  if (hasPostDate(row) || isEvergreenKind(row.kind)) return false;
  const found = row.createdAt ? Date.parse(row.createdAt) : NaN;
  return Number.isFinite(found) && now - found > UNDATED_GRACE_DAYS * DAY_MS;
}

/**
 * A found thread past its freshness window: its stored `fresh_until`, or its
 * platform's "To reply" window (`REPLY_WINDOW_DAYS`), whichever ends first;
 * with no date to measure, found more than a week ago (`undatedTooLong`).
 * A display rule only: the row keeps its status and nothing is written, it
 * just leaves "To reply" for "Expired", where it can still be answered. A
 * post the person chose never expires: they picked it knowing its age. A
 * snoozed row is under Snoozed.
 */
export function isExpired(row: ViewRow, now: number): boolean {
  if (!isOpen(row.status) || isMine(row) || isSnoozed(row, now)) return false;
  if (pastReplyWindow(row, now) || undatedTooLong(row, now)) return true;
  if (!row.freshUntil) return false;
  const until = new Date(row.freshUntil).getTime();
  return Number.isFinite(until) && until < now;
}

/**
 * Why a row is in the Archive, as the small label on its row; null when it
 * is not archived. Skipped by the person, filtered out by a rule or the
 * qualifier, past its window (still answerable from there), or a posted
 * reply the person marked as removed.
 */
export function archiveReason(row: ViewRow, now: number): "Skipped" | "Filtered out" | "Expired" | "Removed" | null {
  if (row.status === "dismissed") return "Skipped";
  if (row.status === "rejected") return "Filtered out";
  if (row.status === "published_manually") return row.removedAt ? "Removed" : null;
  return isExpired(row, now) ? "Expired" : null;
}

/** Whether a row belongs to a list. The one definition, for the page and the counts. */
export function inView(row: ViewRow, view: InboxViewId, now: number): boolean {
  switch (view) {
    case "archive":
      return archiveReason(row, now) !== null;
    case "to_reply":
      return isOpen(row.status) && !isSnoozed(row, now) && !isExpired(row, now);
    case "snoozed":
      return isSnoozed(row, now);
    case "expired":
      return isExpired(row, now);
    case "ai_cited":
      return isOpen(row.status) && Boolean(row.aiCitation);
    case "posted_no_link":
      return missingPublishedLink(row);
    case "posted":
      return row.status === "published_manually" && !row.removedAt;
    case "removed":
      return row.status === "published_manually" && Boolean(row.removedAt);
    case "all":
      return true;
    default:
      return row.status === view;
  }
}

/** How many rows each list holds. Zero is a count here: every row was read. */
export function viewCounts(rows: readonly ViewRow[], now: number): Record<InboxViewId, number> {
  const counts = Object.fromEntries(INBOX_VIEWS.map((view) => [view.id, 0])) as Record<InboxViewId, number>;
  for (const row of rows) {
    for (const view of INBOX_VIEWS) if (inView(row, view.id, now)) counts[view.id] += 1;
  }
  return counts;
}

/**
 * The three tabs of the Today screen (2026-11-14), in place of the eleven
 * lists of the filter menu. Each is one of `INBOX_VIEWS`, so its rows and
 * its count come from the same rule as the API's:
 *
 * - To do: what is open to reply now (`to_reply`): not snoozed (a snooze
 *   that ran out is back here), not past its window.
 * - Posted: replies marked as posted and still up (`posted`); a missing link
 *   is marked on the row.
 * - Archive: skipped, filtered out, expired, removed (`archive`), each row
 *   labelled with why (`archiveReason`).
 *
 * "Not sorted yet" is a step of the pipeline, not a list a person works
 * from, and is on no tab; a row still snoozed is on none until it is back.
 * "Cited by AI" is where a row came from, not a state: a tag on the row,
 * and `?source=ai_visibility` narrows To do to those rows (`ai_cited`).
 */
export const TODAY_VIEWS = [
  { id: "todo", label: "To do", view: "to_reply" },
  { id: "posted", label: "Posted", view: "posted" },
  { id: "archive", label: "Archive", view: "archive" },
] as const satisfies ReadonlyArray<{ id: string; label: string; view: InboxViewId }>;

export type TodayViewId = (typeof TODAY_VIEWS)[number]["id"];

export function isTodayViewId(value: unknown): value is TodayViewId {
  return TODAY_VIEWS.some((view) => view.id === value);
}

/** The list a tab shows. */
export function todayViewList(id: TodayViewId): InboxViewId {
  return TODAY_VIEWS.find((view) => view.id === id)?.view ?? "to_reply";
}

/** How many rows each tab holds, from the lists' own counts. */
export function todayViewCounts(counts: Partial<Record<InboxViewId, number>>): Record<TodayViewId, number> {
  return Object.fromEntries(TODAY_VIEWS.map((view) => [view.id, counts[view.view] ?? 0])) as Record<TodayViewId, number>;
}

export type InboxGroup = "yours" | "found";

export function groupOf(row: Pick<ViewRow, "foundVia" | "qualifiedBy">): InboxGroup {
  return isMine(row) ? "yours" : "found";
}

export const GROUP_LABEL: Record<InboxGroup, string> = { yours: "Yours", found: "Found for you" };

interface OrderRow extends ViewRow {
  createdAt?: string | null;
  qualifiedAt?: string | null;
  qualifyScore?: number | null;
  postedAt?: string | null;
  publishedAt?: string | null;
}

const time = (iso: string | null | undefined) => {
  const at = iso ? new Date(iso).getTime() : NaN;
  return Number.isFinite(at) ? at : 0;
};

/** The newest instant a row can have been posted: its date, else when it was found. */
function floorTime(row: OrderRow): number {
  return time(row.postedAt) || time(row.createdAt);
}

/**
 * The inbox's order, decided on the server so a reload keeps it. Posted
 * rows: the newest reply first. Everything else: the posts the person chose
 * first, newest first (by when they chose it), then what was found, newest
 * post first, best score first within the same instant; the rows nobody
 * could date after every dated one, by when they were found. Until
 * 2026-11-10 the score alone ordered the list, so a hand-picked post, which
 * has no score, fell to the bottom after a reload; until 2026-11-12 "Found
 * for you" was best score first, and a month-old thread with a high score
 * sat above the post from this morning; until 2026-11-13 an undated row
 * ranked by when it was found, as if found meant posted.
 */
export function orderInbox<T extends OrderRow>(rows: readonly T[]): T[] {
  const rank = (row: T) => (row.status === "published_manually" ? 2 : isMine(row) ? 0 : 1);
  return [...rows].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    if (rank(a) === 2) return time(b.publishedAt) - time(a.publishedAt);
    if (rank(a) === 0) return time(b.qualifiedAt ?? b.createdAt) - time(a.qualifiedAt ?? a.createdAt);
    // A row with a post date before one without (2026-11-13): when it was
    // found is not when it was posted, so an undated row is not ranked as
    // if it were new. Undated rows follow, newest find first.
    const byDated = Number(hasPostDate(b)) - Number(hasPostDate(a));
    if (byDated !== 0) return byDated;
    const byAge = floorTime(b) - floorTime(a);
    return byAge !== 0 ? byAge : (b.qualifyScore ?? -1) - (a.qualifyScore ?? -1);
  });
}

/**
 * The item that opens when the open one leaves the list (posted, skipped,
 * snoozed): the one after it, else the one before it, else nothing. `ids`
 * is the list as it was shown, with the leaving item still in it.
 */
export function nextOpenId(ids: readonly string[], leaving: string): string | null {
  const at = ids.indexOf(leaving);
  if (at < 0) return ids[0] ?? null;
  return ids[at + 1] ?? ids[at - 1] ?? null;
}

/** The neighbour J and K move to; the ends stay where they are. */
export function stepOpenId(ids: readonly string[], current: string | null, step: 1 | -1): string | null {
  if (ids.length === 0) return null;
  const at = current ? ids.indexOf(current) : -1;
  if (at < 0) return ids[0];
  return ids[Math.min(ids.length - 1, Math.max(0, at + step))];
}

/**
 * A short notice the page shows for a few seconds and then drops (a toast).
 * `action` is the one thing the person may want to do about it.
 */
export interface InboxToast {
  text: string;
  action?: { label: string };
}

/** What the page says when an item leaves the queue, with its way back. */
export function leftToast(action: "mark_published" | "dismiss" | "snooze" | "reopen" | "set_published_url"): InboxToast {
  switch (action) {
    case "mark_published":
      return { text: "Posted.", action: { label: "Undo" } };
    case "dismiss":
      return { text: "Skipped.", action: { label: "Undo" } };
    case "snooze":
      return { text: "Snoozed for a week." };
    case "reopen":
      return { text: "Back in To do." };
    case "set_published_url":
      return { text: "Link saved." };
  }
}

/**
 * What the page says, for a few seconds, once a pasted post is in the inbox.
 * The item shows the draft being written, so this is a receipt, not a status.
 */
export function addedToast(
  outcome: AddOutcome | undefined,
  textFrom: "x" | "pasted" | "stored" | undefined,
  drafting: boolean
): InboxToast {
  const draft = drafting ? " Writing the reply." : "";
  const pasted = textFrom === "pasted" ? " X did not hand the post over, so it uses the text you pasted." : "";
  switch (outcome) {
    case "published":
      return { text: "You already posted a reply to this one. It is left as it is." };
    case "reopened":
      return { text: `This post was here already. It is back as one you chose.${pasted}${draft}` };
    case "already_open":
      return { text: `This post is already in your inbox.${draft}` };
    default:
      return { text: `Post added.${pasted}${draft}` };
  }
}
