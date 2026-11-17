import { formatDay } from "@/lib/format";

/**
 * Indexing status as a person reads it. Pure, no I/O and no server imports,
 * so the article modal, the Results page, the API and the tests share one
 * reading of a stored inspection.
 *
 * The rule that matters: a URL nobody inspected has no row, and that is
 * "not checked", never "not indexed". Counts are made only from rows that
 * exist and always say how many of how many were checked.
 */

/** One stored inspection, as the API and the screens carry it. */
export interface IndexStatusView {
  url: string;
  articleId: string | null;
  checkedAt: string;
  verdict: string;
  /** "indexed", "not_indexed", or "unknown" when Google gave no verdict. */
  state: IndexState;
  /** Google's own sentence: "Submitted and indexed", "Page with redirect". */
  coverageState: string | null;
  indexingState: string | null;
  robotsState: string | null;
  fetchState: string | null;
  googleCanonical: string | null;
  userCanonical: string | null;
  lastCrawlAt: string | null;
  /** Google's report for this URL, for a person to open. */
  inspectionResultLink: string | null;
}

export type IndexState = "indexed" | "not_indexed" | "unknown";

/**
 * Google's verdict as indexed or not. PASS is indexed. PARTIAL is a value
 * Google reserves and no longer sends; when it did, it meant indexed with
 * warnings, so it reads as indexed. FAIL and NEUTRAL (excluded, e.g. a
 * redirect or a noindex) are not indexed. Anything else is unknown, never
 * guessed either way.
 */
export function indexStateOf(verdict: string | null | undefined): IndexState {
  if (verdict === "PASS" || verdict === "PARTIAL") return "indexed";
  if (verdict === "FAIL" || verdict === "NEUTRAL") return "not_indexed";
  return "unknown";
}

export interface IndexLine {
  text: string;
  tone: "ok" | "warn" | "muted";
  /** Google's report for the URL; null when there is none. */
  link: string | null;
}

/**
 * The one quiet line under a published article: "On Google · checked Nov 12",
 * "Not on Google: Crawled - currently not indexed · checked Nov 12", or "Not
 * checked on Google yet" when there is no row.
 */
export function indexStatusLine(row: IndexStatusView | null, now: Date = new Date()): IndexLine {
  if (!row) return { text: "Not checked on Google yet", tone: "muted", link: null };
  const checked = `checked ${formatDay(row.checkedAt, { now })}`;
  switch (row.state) {
    case "indexed":
      return { text: `On Google · ${checked}`, tone: "ok", link: row.inspectionResultLink };
    case "not_indexed":
      return {
        text: `Not on Google: ${row.coverageState ?? "Google gave no reason"} · ${checked}`,
        tone: "warn",
        link: row.inspectionResultLink,
      };
    default:
      return {
        text: `Google gave no verdict${row.coverageState ? `: ${row.coverageState}` : ""} · ${checked}`,
        tone: "muted",
        link: row.inspectionResultLink,
      };
  }
}

export interface IndexingSummary {
  /** The site's URLs that could be checked: its published articles with a live address. */
  total: number;
  /** How many of them have an inspection. Never more than `total`. */
  checked: number;
  indexed: number;
  notIndexed: number;
  unknown: number;
  /** Counts per Google sentence, most frequent first, from checked URLs only. */
  byCoverageState: Array<{ coverageState: string; state: IndexState; count: number }>;
  /** The checked URLs that are not indexed, each with Google's reason. */
  notIndexedRows: IndexStatusView[];
  /** "12 of 40 checked"; null when there is nothing to check. */
  caption: string | null;
}

/**
 * Counts from checked URLs only. `totalUrls` is how many there are to check;
 * the gap between the two is "not checked yet", and is never counted as not
 * indexed.
 */
export function summarizeIndexing(rows: readonly IndexStatusView[], totalUrls: number): IndexingSummary {
  const byState = new Map<string, { coverageState: string; state: IndexState; count: number }>();
  let indexed = 0;
  let notIndexed = 0;
  let unknown = 0;
  for (const row of rows) {
    if (row.state === "indexed") indexed += 1;
    else if (row.state === "not_indexed") notIndexed += 1;
    else unknown += 1;
    const label = row.coverageState ?? "No reason given";
    const key = `${row.state}|${label}`;
    const entry = byState.get(key) ?? { coverageState: label, state: row.state, count: 0 };
    entry.count += 1;
    byState.set(key, entry);
  }
  const checked = rows.length;
  const total = Math.max(totalUrls, checked);
  return {
    total,
    checked,
    indexed,
    notIndexed,
    unknown,
    byCoverageState: [...byState.values()].sort(
      (a, b) => b.count - a.count || a.coverageState.localeCompare(b.coverageState)
    ),
    notIndexedRows: rows
      .filter((row) => row.state === "not_indexed")
      .sort((a, b) => a.url.localeCompare(b.url)),
    caption: total === 0 ? null : `${checked} of ${total} checked`,
  };
}
