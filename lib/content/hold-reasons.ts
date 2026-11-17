/**
 * Why an article in `needs_review` was held, as plain sentences: what the
 * calendar's card and modal show and what `publish_article` answers with
 * (lib/articles/publish-now.ts), so the screen and the API say the same
 * thing. Pure and parser-free: the browser imports it.
 *
 * Read in this order, the first that has anything wins:
 *  1. `quality_report.blocking`, written by `settle` since 12 November 2026;
 *  2. `last_error`, where every hold has put its reasons, joined by " | ";
 *  3. the review-grade gate issues in `quality_report.issues` (a row parked
 *     by an older path that left no reason anywhere else).
 *
 * Until 12 November 2026 the modal read only (3). An article held by an
 * audit finding has nothing there, so it said "these quality checks
 * failed, so it was not sent to your site:" over an empty list. With
 * nothing in any of the three, the screen says `REASON_NOT_RECORDED`
 * instead of showing an empty list.
 */

export const REASON_NOT_RECORDED = "The reason was not recorded.";

/** The separator `settle` and the publish paths join reasons with in `last_error`. */
export const REASON_SEPARATOR = " | ";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messagesOf(list: unknown, keep: (item: Record<string, unknown>) => boolean = () => true): string[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => {
      if (typeof item === "string") return item;
      if (isRecord(item) && keep(item) && typeof item.message === "string") return item.message;
      return "";
    })
    .map((message) => message.trim())
    .filter(Boolean);
}

export function holdReasons(input: { qualityReport?: unknown; lastError?: unknown }): string[] {
  const report = isRecord(input.qualityReport) ? input.qualityReport : {};

  const blocking = messagesOf(report.blocking);
  if (blocking.length > 0) return blocking;

  if (typeof input.lastError === "string" && input.lastError.trim()) {
    const stored = input.lastError
      .split(REASON_SEPARATOR)
      .map((message) => message.trim())
      .filter(Boolean);
    if (stored.length > 0) return stored;
  }

  return messagesOf(report.issues, (issue) => issue.action !== "warn");
}
