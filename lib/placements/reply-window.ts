/**
 * How long a found row is worth a reply, by platform and kind of page
 * (2026-11-12), and what an unknown date means for it (2026-11-13).
 *
 * Its own module because two layers read it: the inbox's display rule
 * (`./inbox-view.ts`, which moves a row past its window to Expired) and the
 * free rules before the paid qualifier (`./rules.ts`, which does not pay to
 * judge a row that would land in Expired the moment it was judged). Pure,
 * no imports, so the client bundle that renders the inbox can carry it.
 */

/**
 * The owner had not opened the inbox for weeks and asked whether what he
 * saw was new: of 322 found rows still inside their `fresh_until`, 221 were
 * over 30 days old, because web discovery ran weekly and the stored windows
 * are long (thread 180 days, post 60). On X a reply matters in the first
 * hours; a Reddit thread is quiet after a month; a GitHub issue stays open
 * for months. A kind not named here (a list article, a repository, a web
 * page) keeps its stored window alone.
 */
export const REPLY_WINDOW_DAYS = {
  xPost: 2,
  linkedinPost: 14,
  redditThread: 30,
  /** Quora, Hacker News, Indie Hackers, DEV, Stack Exchange. */
  questionSite: 60,
  /** An issue, and a discussion, which is answered the same way. */
  githubIssue: 90,
} as const;

const QUESTION_SITES = new Set(["quora", "hackernews", "indiehackers", "devto", "stackexchange"]);

/** The "To reply" window of a found row, in days; null when only its stored `fresh_until` applies. */
export function replyWindowDays(surface: string | null | undefined, kind: string | null | undefined): number | null {
  const k = kind || "thread";
  if (k === "listicle" || k === "repository" || k === "page") return null;
  switch (surface) {
    case "x":
      return k === "post" ? REPLY_WINDOW_DAYS.xPost : null;
    case "linkedin":
      return k === "post" ? REPLY_WINDOW_DAYS.linkedinPost : null;
    case "reddit":
      return k === "thread" ? REPLY_WINDOW_DAYS.redditThread : null;
    case "github":
      return k === "issue" || k === "discussion" ? REPLY_WINDOW_DAYS.githubIssue : null;
    default:
      return surface && QUESTION_SITES.has(surface) && k !== "article" ? REPLY_WINDOW_DAYS.questionSite : null;
  }
}

/**
 * How long a found row whose post date nobody could read stays in "To
 * reply", counted from when it was found (2026-11-13). Until then an
 * undated row was aged from `created_at`, so an X post from 5 October found
 * on 12 November counted as a day old. When it was found is not when it was
 * posted: a week after finding it, still without a date, it leaves for
 * Expired, where it says "date unknown".
 */
export const UNDATED_GRACE_DAYS = 7;

/**
 * Kinds that have no age at all: a list article takes additions while its
 * author keeps it, a repository is judged by its last push. An unknown date
 * on them is not a reason to expire them.
 */
export function isEvergreenKind(kind: string | null | undefined): boolean {
  return kind === "listicle" || kind === "repository";
}
