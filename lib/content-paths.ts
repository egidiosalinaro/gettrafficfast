/**
 * Where the Content section lives (docs/ARCHITECTURE.md): the calendar of
 * every article, with the Autopilot state above it, and the topics behind
 * it. Every link to Articles or Keywords points here; the old addresses
 * redirect.
 */
export const CONTENT_PATHS = {
  /**
   * The calendar: every article by day, the production board. "All
   * articles" (`/content/articles`) was a page of its own until the
   * calendar became Content's first view; that address redirects here.
   */
  home: "/content",
  /** Every topic, with search, sort, estimates and bulk scheduling: what was "Keywords". */
  topics: "/content/topics",
  /** The sections of the topics view a link on the Content screen opens. */
  overlapping: "/content/topics#overlapping-topics",
  questions: "/content/topics#questions-people-ask",
} as const;

/**
 * The calendar with one article's modal open (`?article=<id>`): where a
 * link about one article lands.
 */
export function articlePath(articleId: string): string {
  return `${CONTENT_PATHS.home}?article=${encodeURIComponent(articleId)}`;
}

/** The old addresses and where they went. */
export const LEGACY_CONTENT_REDIRECTS = {
  "/dashboard/calendar": CONTENT_PATHS.home,
  "/content/articles": CONTENT_PATHS.home,
  "/keywords": CONTENT_PATHS.topics,
  "/dashboard/keywords": CONTENT_PATHS.topics,
} as const;

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * `path` with the request's query string kept, so a bookmarked or emailed
 * link (`/keywords?search=seo`) lands on the same view with the same query.
 */
export function withQuery(path: string, searchParams: SearchParams | undefined): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams ?? {})) {
    if (value === undefined) continue;
    for (const one of Array.isArray(value) ? value : [value]) query.append(key, one);
  }
  const text = query.toString();
  return text ? `${path}?${text}` : path;
}
