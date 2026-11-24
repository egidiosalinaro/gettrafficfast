import type { SupabaseClient } from "@supabase/supabase-js";
import { X_SEARCH_USD_PER_POST, roundUsd, searchWorstCaseUsd } from "@/lib/providers/x/api";
import { CLOSE_MATCH, textSimilarity } from "./link-match";
import { replyWords } from "./published-text";
import { xStatusIdOf } from "./published-url";

/**
 * The link of the person's own reply on X, found by GTF (2026-11-13,
 * docs/PLACEMENTS.md, "The link of your reply, found on X").
 *
 * After "I posted it" the link to the reply was the one step left to the
 * person, and the most tedious of the day: open the reply on X, Share, Copy
 * link, come back, paste. Without it nothing is measured. Now GTF looks for
 * the reply itself, through the X API's recent search, a few times after the
 * tap, and saves the link only when there is no doubt it is the person's own
 * reply to that post. A wrong link is worse than no link: anything less than
 * sure leaves the row as it was, and the person pastes as before.
 *
 * This file is the part with no I/O but one loader, so the screens can use
 * it: the schedule, the search's query and window, the matcher, and the
 * state a posted reply is in. The sweep and the tool are in
 * reply-link-search.ts.
 */

// ── The schedule ────────────────────────────────────────────────────────────

/**
 * When GTF looks, in minutes after "I posted it": X's search needs a moment
 * to list a new post, a person may post a little after tapping, and a reply
 * posted from another device can come hours later. Then it stops.
 */
export const LINK_SEARCH_AFTER_MIN = [2, 15, 120, 720] as const;

/** The automatic attempts a posted reply gets, at most. */
export const LINK_SEARCH_ATTEMPTS = LINK_SEARCH_AFTER_MIN.length;

/** With `find_reply_link`, a person may ask twice more; never beyond this. */
export const LINK_SEARCH_MAX_ATTEMPTS = LINK_SEARCH_ATTEMPTS + 2;

/** The reply may have been posted up to an hour before "I posted it" was tapped… */
export const LINK_POSTED_BEFORE_MS = 60 * 60_000;

/** …or up to six hours after it. */
export const LINK_POSTED_AFTER_MS = 6 * 3_600_000;

/** X's recent search covers the last 7 days. */
export const X_RECENT_SEARCH_MS = 7 * 86_400_000;

/** Kept clear of the edges X refuses: the start of the 7 days, and "now" for an end time. */
const RECENT_EDGE_MS = 10 * 60_000;
const END_EDGE_MS = 30_000;

/** The sweep runs every 5 minutes: an attempt due at T is made by T + 5 minutes. */
export const LINK_SWEEP_EVERY_MS = 5 * 60_000;

/** Posts asked for per search: X's floor for `max_results`. One reply is what is expected. */
export const LINK_SEARCH_RESULTS = 10;

/** The worst one search costs, reserved before it is made: 10 posts, $0.05. */
export const LINK_SEARCH_CALL_WORST_USD = searchWorstCaseUsd(LINK_SEARCH_RESULTS);

/** Posted replies searched per sweep, whatever the number of sites: $0.50 at worst. */
export const LINK_SEARCH_ROWS_PER_RUN = 10;

const MINUTE_MS = 60_000;

/**
 * What finding the links costs in a month of `days`, from the constants. X
 * bills the posts a search returns: one that finds nothing costs nothing,
 * and any search that returned posts settles the reply (found, ambiguous, or
 * other replies only), so a reply is billed by one search on its own:
 * `typicalUsd` when that search returns the reply alone, `worstUsd` when it
 * returns X's floor of 10 posts. `find_reply_link` can add two searches to a
 * reply; the platform's monthly cap bounds all of it.
 */
export function linkSearchMonthUsd(params: { repliesPerDay: number; days?: number }): { typicalUsd: number; worstUsd: number } {
  const replies = Math.max(0, params.repliesPerDay) * (params.days ?? 30);
  return {
    typicalUsd: roundUsd(replies * X_SEARCH_USD_PER_POST),
    worstUsd: roundUsd(replies * LINK_SEARCH_CALL_WORST_USD),
  };
}

function instant(iso: string | null | undefined): number | null {
  const at = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(at) ? at : null;
}

/**
 * The window the search covers for a reply marked as posted at `publishedAt`:
 * from an hour before to six hours after, the end left open while it is
 * still ahead. Null when X can no longer search it (the start is older than
 * its 7 days) or when the instant cannot be read: such a reply is never
 * searched.
 */
export function searchWindow(publishedAt: string | null | undefined, now: Date): { start: Date; end: Date | null } | null {
  const marked = instant(publishedAt);
  if (marked === null) return null;
  const start = marked - LINK_POSTED_BEFORE_MS;
  if (start < now.getTime() - X_RECENT_SEARCH_MS + RECENT_EDGE_MS) return null;
  if (start > now.getTime() - END_EDGE_MS) return null;
  const end = marked + LINK_POSTED_AFTER_MS;
  return { start: new Date(start), end: end <= now.getTime() - END_EDGE_MS ? new Date(end) : null };
}

/**
 * The attempt due now for a reply marked as posted at `publishedAt` that has
 * had `attempts` already, or null when none is. Attempts are slots after the
 * tap (2 min, 15 min, 2 h, 12 h); a slot that passed while nobody looked is
 * not made up: the latest one due is taken, so a reply the sweep reaches late
 * is searched once, not four times in a row. The answer is the slot's index;
 * after it, the reply has had index + 1.
 */
export function dueAttempt(publishedAt: string | null | undefined, attempts: number, now: Date): number | null {
  const marked = instant(publishedAt);
  if (marked === null || attempts >= LINK_SEARCH_ATTEMPTS) return null;
  let due: number | null = null;
  for (let slot = Math.max(0, attempts); slot < LINK_SEARCH_ATTEMPTS; slot++) {
    if (marked + LINK_SEARCH_AFTER_MIN[slot] * MINUTE_MS <= now.getTime()) due = slot;
  }
  return due;
}

// ── The query ───────────────────────────────────────────────────────────────

const HANDLE = /^\w{1,15}$/;
const STATUS_ID = /^\d{1,20}$/;

/**
 * The search for the person's replies in one thread: posts of `handle` in the
 * conversation the post started, or answering the post itself (a post that
 * is a reply in someone else's thread has another conversation id). Null when
 * either part is not what X accepts: no query is built from anything else.
 */
export function replyLinkQuery(threadId: string, handle: string): string | null {
  if (!STATUS_ID.test(threadId) || !HANDLE.test(handle)) return null;
  return `(conversation_id:${threadId} OR in_reply_to_tweet_id:${threadId}) from:${handle}`;
}

// ── The matcher ─────────────────────────────────────────────────────────────

/** What the matcher reads of a post X returned (`XApiPost`). */
export interface ReplyCandidate {
  id: string;
  text: string;
  handle: string | null;
  createdAt: string | null;
  conversationId?: string | null;
  repliedToId?: string | null;
}

export type OwnReplyMatch =
  /** The person's own reply, without a doubt: its link can be saved. */
  | { kind: "found"; post: ReplyCandidate; url: string; why: "the_reply" | "closest_text" }
  /** More than one reply of theirs could be it: nothing is saved. */
  | { kind: "ambiguous"; candidateIds: string[] }
  /** None of what X returned is this reply. */
  | { kind: "none" };

const sameHandle = (a: string | null | undefined, b: string) => (a ?? "").replace(/^@/, "").toLowerCase() === b.replace(/^@/, "").toLowerCase();

/** The link of a post on X, by its author and id: what a person copies from Share. */
export function xReplyUrl(post: { id: string; handle: string | null }): string | null {
  if (!post.handle || !HANDLE.test(post.handle) || !STATUS_ID.test(post.id)) return null;
  return `https://x.com/${post.handle}/status/${post.id}`;
}

/**
 * Which of the posts X returned is the person's reply to the thread, if any
 * is surely it.
 *
 * A post is a candidate only when it is by `handle` (the account the site's
 * own linked replies carry), in that thread (its conversation is the post, or
 * it answers the post), made from an hour before "I posted it" to six hours
 * after, and not already the link of another reply (`taken`). Then:
 *
 * - one direct reply to the post: that is it, whatever its words (the person
 *   often edits the draft on X before posting);
 * - several direct replies: the one whose words read closely like the reply
 *   on record (`replyText`: the draft marked as posted), only when exactly
 *   one does; otherwise nothing is saved;
 * - no direct reply: a reply further down the thread is taken only when
 *   exactly one reads closely like the reply on record.
 *
 * Anything else is no link: a wrong link is worse than none.
 */
export function matchOwnReply(input: {
  threadId: string;
  handle: string;
  /** When the person tapped "I posted it" (`published_at`). */
  markedAt: string;
  /** The words that went out as far as they are known; null when none are on record. */
  replyText: string | null;
  posts: readonly ReplyCandidate[];
  /** Status ids already saved as the link of another reply of the site. */
  taken?: ReadonlySet<string>;
}): OwnReplyMatch {
  const marked = instant(input.markedAt);
  if (marked === null || !STATUS_ID.test(input.threadId)) return { kind: "none" };
  const seen = new Set<string>();
  const candidates = input.posts.filter((post) => {
    if (seen.has(post.id)) return false;
    seen.add(post.id);
    if (post.id === input.threadId || input.taken?.has(post.id)) return false;
    if (!sameHandle(post.handle, input.handle) || !xReplyUrl(post)) return false;
    const created = instant(post.createdAt);
    if (created === null || created < marked - LINK_POSTED_BEFORE_MS || created > marked + LINK_POSTED_AFTER_MS) return false;
    // In the thread, as X says it: never assumed from the query alone.
    return post.conversationId === input.threadId || post.repliedToId === input.threadId;
  });
  if (candidates.length === 0) return { kind: "none" };

  const found = (post: ReplyCandidate, why: "the_reply" | "closest_text"): OwnReplyMatch => ({
    kind: "found",
    post,
    url: xReplyUrl(post) as string,
    why,
  });
  const closeTo = (pool: ReplyCandidate[]) => {
    const said = input.replyText ? replyWords(input.replyText) : "";
    if (!said) return [];
    return pool.filter((post) => textSimilarity(replyWords(post.text), said) >= CLOSE_MATCH);
  };

  const direct = candidates.filter((post) => post.repliedToId === input.threadId);
  if (direct.length === 1) return found(direct[0], "the_reply");
  if (direct.length > 1) {
    const close = closeTo(direct);
    return close.length === 1 ? found(close[0], "closest_text") : { kind: "ambiguous", candidateIds: direct.map((p) => p.id) };
  }
  const close = closeTo(candidates);
  if (close.length === 1) return found(close[0], "closest_text");
  if (close.length > 1) return { kind: "ambiguous", candidateIds: close.map((p) => p.id) };
  return { kind: "none" };
}

// ── What is stored, and what a posted reply shows ───────────────────────────

/**
 * How the last attempt ended, as stored in `placement_link_searches.outcome`:
 *   searching      — an attempt is being made now;
 *   found          — the link was found and saved;
 *   not_found      — X returned nothing in the thread from the account: tried again later;
 *   other_replies  — X returned replies of the account there, none of them this one: stopped (each was billed);
 *   ambiguous      — more than one could be it: stopped, nothing saved;
 *   error          — X failed or refused: the attempt counts;
 *   not_saved      — found, but the row had a link by then or was no longer posted: stopped.
 */
export const LINK_SEARCH_OUTCOMES = ["searching", "found", "not_found", "other_replies", "ambiguous", "error", "not_saved"] as const;
export type LinkSearchOutcome = (typeof LINK_SEARCH_OUTCOMES)[number];

/** One posted reply's search, as `placement_link_searches` stores it. */
export interface LinkSearchRecord {
  attempts: number;
  lastAttemptAt: string | null;
  outcome: LinkSearchOutcome | null;
  /** Posts X returned over every attempt: what was billed. */
  postsSeen: number;
  /** The link GTF found and saved; kept when the person later replaces it. */
  foundUrl: string | null;
  foundAt: string | null;
}

/** Who gave the reply's link: GTF found it on X, or the person gave it. */
export type LinkSource = "found_on_x" | "person";

/** The searches table: the owner reads, the platform writes (migration 20261113100000). */
export const LINK_SEARCHES_TABLE = "placement_link_searches";

type Row = Record<string, unknown>;

function outcomeOf(value: unknown): LinkSearchOutcome | null {
  return typeof value === "string" && (LINK_SEARCH_OUTCOMES as readonly string[]).includes(value) ? (value as LinkSearchOutcome) : null;
}

export function mapLinkSearch(row: Row): LinkSearchRecord {
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  return {
    attempts: count(row.attempts),
    lastAttemptAt: str(row.last_attempt_at),
    outcome: outcomeOf(row.outcome),
    postsSeen: count(row.posts_seen),
    foundUrl: str(row.found_url),
    foundAt: str(row.found_at),
  };
}

export const LINK_SEARCH_COLUMNS = "target_id, attempts, last_attempt_at, outcome, posts_seen, found_url, found_at";

/**
 * The searches of these targets, by target id; null when the table cannot be
 * read (the migration is not applied yet): unknown, and every reply then
 * asks for its link as before. Through the caller's client: the owner reads
 * their own rows (RLS), the service role every row.
 */
export async function loadLinkSearches(
  supabase: SupabaseClient,
  ids: readonly string[]
): Promise<Map<string, LinkSearchRecord> | null> {
  if (ids.length === 0) return new Map();
  try {
    const { data, error } = await supabase.from(LINK_SEARCHES_TABLE).select(LINK_SEARCH_COLUMNS).in("target_id", [...ids]);
    if (error) return null;
    const out = new Map<string, LinkSearchRecord>();
    for (const row of (data ?? []) as Row[]) out.set(row.target_id as string, mapLinkSearch(row));
    return out;
  } catch {
    return null;
  }
}

/**
 * A target row with its search on it (`link_search`, null when never
 * searched), when the searches could be read. Unread, the row is left without
 * the key: unknown, not "never searched".
 */
export function withLinkSearch(row: Row, searches: Map<string, LinkSearchRecord> | null): Row {
  return searches ? { ...row, link_search: searches.get(row.id as string) ?? null } : row;
}

/** Where a saved link came from; null with no link. The person replacing a found link makes it theirs. */
export function linkSourceOf(publishedUrl: string | null | undefined, search: LinkSearchRecord | null | undefined): LinkSource | null {
  const url = (publishedUrl ?? "").trim();
  if (!url) return null;
  return search?.foundUrl && search.foundUrl === url ? "found_on_x" : "person";
}

/**
 * What a posted reply with no link shows about the search:
 *   looking — GTF will look again by itself, until `stopsBy`;
 *   stopped — GTF looked and stopped (`outcome` says why): the person pastes;
 *   off     — GTF does not look for this one: not on X, removed, too old
 *             for X's search, the platform has it off, the
 *             account is not known, or the searches could not be read.
 * Null for a reply that has its link or is not a posted reply.
 */
export type LinkFinding =
  | { state: "looking"; stopsBy: string }
  | { state: "stopped"; outcome: LinkSearchOutcome | null }
  | { state: "off" };

export interface LinkFindingTarget {
  surface: string;
  status: string;
  url: string;
  publishedUrl: string | null;
  publishedAt: string | null;
  removedAt?: string | null;
  /** Absent: the searches were not read. */
  linkSearch?: LinkSearchRecord | null;
}

/**
 * The state of the search for one posted reply. `finderOn` is whether GTF
 * looks for this site's replies at all (lib/placements/reply-link-search.ts,
 * `replyLinkFinderOn`: the platform's X API, the cap, the account known, the
 * owner paying).
 */
export function linkFinding(target: LinkFindingTarget, ctx: { finderOn: boolean; now: number }): LinkFinding | null {
  if (target.status !== "published_manually" || (target.publishedUrl ?? "").trim()) return null;
  if (target.surface !== "x" || target.removedAt || !xStatusIdOf(target.url)) return { state: "off" };
  if (target.linkSearch === undefined) return { state: "off" };
  const attempts = target.linkSearch?.attempts ?? 0;
  const outcome = target.linkSearch?.outcome ?? null;
  const now = new Date(ctx.now);
  const searchable = searchWindow(target.publishedAt, now) !== null;
  if (attempts >= LINK_SEARCH_ATTEMPTS || (attempts > 0 && !searchable)) return { state: "stopped", outcome };
  if (!ctx.finderOn || !searchable) return { state: "off" };
  const marked = instant(target.publishedAt) as number;
  const lastSlot = marked + LINK_SEARCH_AFTER_MIN[LINK_SEARCH_ATTEMPTS - 1] * MINUTE_MS;
  return { state: "looking", stopsBy: new Date(Math.max(lastSlot, ctx.now) + LINK_SWEEP_EVERY_MS).toISOString() };
}

/** Why GTF stopped, in a sentence a person reads above the paste field. */
export function stoppedLine(outcome: LinkSearchOutcome | null): string {
  switch (outcome) {
    case "ambiguous":
      return "GTF found more than one reply of yours there and could not tell which one this is. Paste its link.";
    case "other_replies":
      return "GTF found other replies of yours there, not this one. Paste its link.";
    case "error":
      return "GTF could not search X for this reply. Paste its link.";
    default:
      return "GTF looked for this reply on X and did not find it. Paste its link.";
  }
}

/** "3:40 PM", or "tomorrow 3:40 AM", or "Nov 15, 3:40 AM": when the search stops, in the reader's zone. */
export function stopsByLabel(iso: string, now: number, timeZone?: string): string {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return "later";
  const zone = timeZone ? { timeZone } : {};
  const time = at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", ...zone });
  const day = (d: Date) => d.toLocaleDateString("en-CA", zone);
  if (day(at) === day(new Date(now))) return time;
  if (day(at) === day(new Date(now + 86_400_000))) return `tomorrow ${time}`;
  return `${at.toLocaleDateString("en-US", { month: "short", day: "numeric", ...zone })}, ${time}`;
}

/** The line a posted reply shows while GTF looks for its link. */
export function lookingLine(stopsBy: string, now: number, timeZone?: string): string {
  return `GTF is looking for this reply on X and will add its link. It stops by ${stopsByLabel(stopsBy, now, timeZone)}; you can paste it any time.`;
}
