/**
 * Two facts about Reddit that let a thread's age be bounded without asking
 * Reddit.
 *
 * 1. Six months after it is posted a thread is archived: no new comments, no
 *    votes. A subreddit can opt out, but the default holds almost everywhere,
 *    and an archived thread is not a placement — the reply cannot be posted.
 *
 * 2. Post ids are one global base-36 counter. A post with a smaller id was
 *    posted earlier, so any post whose id is at or below the id of a post
 *    KNOWN to be older than six months is older than six months too. That is
 *    how a thread a web search found without a date is still judged: not by
 *    guessing its date, but by comparing it with dated neighbours.
 *
 * Nothing here is a date estimate. An anchor is an observation — "this id
 * was dated by the engine as posted no later than this day" — and the bound
 * that comes out of it is only ever "older than", never "posted on".
 */

/** Reddit locks a thread against new comments and votes six months after it is posted. */
export const REDDIT_ARCHIVE_DAYS = 180;

const BASE36 = /^[0-9a-z]{1,10}$/;

/** A Reddit post id as a number, or null for anything that is not one. */
export function redditIdValue(id: string | null | undefined): number | null {
  const key = (id ?? "").toLowerCase();
  if (!BASE36.test(key)) return null;
  const value = parseInt(key, 36);
  return Number.isFinite(value) ? value : null;
}

export interface RedditAnchor {
  /** A post id. */
  id: string;
  /** The latest instant that post can have been posted at, ISO. */
  postedBefore: string;
}

/**
 * Observations recorded from the search engine's own dates on threads this
 * platform found: id → "posted no later than". A distance the engine showed
 * ("7 months ago" on 2026-09-28) is turned into its latest possible day, so
 * every bound here errs towards younger. The list is a floor: anchors read
 * from stored, dated threads extend it as discovery runs.
 */
export const REDDIT_SEED_ANCHORS: ReadonlyArray<RedditAnchor> = [
  { id: "103x2uj", postedBefore: "2024-01-01T00:00:00Z" },
  { id: "1hnst6u", postedBefore: "2025-09-28T00:00:00Z" },
  { id: "1n6s43r", postedBefore: "2025-09-28T00:00:00Z" },
  { id: "1o5apge", postedBefore: "2025-10-28T00:00:00Z" },
  { id: "1oplma6", postedBefore: "2025-11-28T00:00:00Z" },
  { id: "1pixhz4", postedBefore: "2025-12-28T00:00:00Z" },
  { id: "1qlnu38", postedBefore: "2026-01-26T00:00:00Z" },
  { id: "1qtonc8", postedBefore: "2026-02-28T00:00:00Z" },
  { id: "1rsqq3t", postedBefore: "2026-03-28T00:00:00Z" },
  { id: "1snu2bf", postedBefore: "2026-04-26T00:00:00Z" },
  { id: "1sil7jg", postedBefore: "2026-04-28T00:00:00Z" },
  { id: "1tes7ts", postedBefore: "2026-05-29T00:00:00Z" },
  { id: "1wdgutr", postedBefore: "2026-09-17T00:00:00Z" },
];

/**
 * The newest post id known to be older than the archive window at `now`:
 * every Reddit thread with an id at or below it is archived. Null when no
 * anchor is old enough yet, which means "cannot tell", not "fresh".
 */
export function redditArchivedBelow(
  anchors: ReadonlyArray<RedditAnchor>,
  now: Date,
  archiveDays = REDDIT_ARCHIVE_DAYS
): string | null {
  const cutoff = now.getTime() - archiveDays * 86_400_000;
  let best: { id: string; value: number } | null = null;
  for (const anchor of anchors) {
    const value = redditIdValue(anchor.id);
    const before = new Date(anchor.postedBefore).getTime();
    if (value === null || !Number.isFinite(before) || before > cutoff) continue;
    if (!best || value > best.value) best = { id: anchor.id.toLowerCase(), value };
  }
  return best?.id ?? null;
}

/** Whether `id` is at or below `bound` on Reddit's counter; false when either is not an id. */
export function redditIdAtOrBelow(id: string | null | undefined, bound: string | null | undefined): boolean {
  const a = redditIdValue(id);
  const b = redditIdValue(bound);
  return a !== null && b !== null && a <= b;
}
