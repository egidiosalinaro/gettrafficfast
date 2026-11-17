/**
 * Rules over a site's keyword pool that the Keywords screen and the API
 * share, so "best picks" and the column sort mean one thing wherever they
 * are read: the page (app/(app)/keywords/page.tsx), `list_keywords` and
 * `recommend_keywords`. Pure, so they run in the browser and on the server.
 *
 * Every number here is a model's estimate (volume, difficulty, CPC,
 * competition, opportunity), never measured data; the page labels each
 * column so, and the tools say so too. A keyword taken from a question asked
 * in a public thread (lib/keywords/questions.ts) has none of them: null, so
 * it is never a best pick and sorts last on every column.
 */

/** The fields the rules read; a pool row carries more. */
export interface PoolKeyword {
  opportunity: string | null;
  difficulty: number | null;
  search_volume: number | null;
  cpc: number | null;
  article_id: string | null;
}

/** The highest difficulty a best pick may have: realistically rankable. */
export const BEST_PICK_MAX_DIFFICULTY = 60;

/** The rule in words, for anything that shows best picks. */
export const BEST_PICK_RULE = `Not on the calendar yet, High opportunity, difficulty ${BEST_PICK_MAX_DIFFICULTY} or less (model estimates).`;

/** A keyword is addable until it has an article, i.e. until it is on the calendar. */
export function isAddable(keyword: Pick<PoolKeyword, "article_id">): boolean {
  return !keyword.article_id;
}

/**
 * A best pick: strong opportunity paired with a realistically rankable
 * difficulty, and not on the calendar yet, so a person (or an agent) can
 * queue the best ones in one go.
 */
export function isBestPick(keyword: Pick<PoolKeyword, "article_id" | "opportunity" | "difficulty">): boolean {
  return (
    isAddable(keyword) &&
    keyword.opportunity === "High" &&
    keyword.difficulty !== null &&
    keyword.difficulty <= BEST_PICK_MAX_DIFFICULTY
  );
}

/** The best picks of a pool, in the pool's order. */
export function bestPicks<T extends Pick<PoolKeyword, "article_id" | "opportunity" | "difficulty">>(keywords: readonly T[]): T[] {
  return keywords.filter(isBestPick);
}

export const KEYWORD_SORT_COLUMNS = ["opportunity", "difficulty", "search_volume", "cpc"] as const;
export type KeywordSortColumn = (typeof KEYWORD_SORT_COLUMNS)[number];
export type SortDirection = "asc" | "desc";

const OPPORTUNITY_RANK: Record<string, number> = { Low: 0, Medium: 1, High: 2 };

function sortValue(keyword: PoolKeyword, column: KeywordSortColumn): number | null {
  if (column === "opportunity") return OPPORTUNITY_RANK[keyword.opportunity ?? ""] ?? null;
  if (column === "difficulty") return keyword.difficulty;
  if (column === "search_volume") return keyword.search_volume;
  return keyword.cpc;
}

/**
 * The pool sorted on one column, as the Keywords table sorts it. Unknown
 * values (no volume, no CPC, no opportunity) always go to the bottom, whatever the
 * direction: an unknown is not a small number. Stable, so equal values keep
 * the pool's order (newest first).
 */
export function sortKeywords<T extends PoolKeyword>(
  keywords: readonly T[],
  sort: { column: KeywordSortColumn; dir: SortDirection } | null
): T[] {
  if (!sort) return [...keywords];
  const factor = sort.dir === "asc" ? 1 : -1;
  return [...keywords].sort((a, b) => {
    const va = sortValue(a, sort.column);
    const vb = sortValue(b, sort.column);
    if (va === null && vb === null) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    return (va - vb) * factor;
  });
}
