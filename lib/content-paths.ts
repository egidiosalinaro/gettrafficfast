/**
 * Where the Content section lives (docs/ARCHITECTURE.md): one screen for
 * today, the week and the next topics, and two views behind it. Every link
 * to Articles or Keywords points here; the old addresses redirect.
 */
export const CONTENT_PATHS = {
  home: "/content",
  /** Every article by day: the production board that was "Articles". */
  articles: "/content/articles",
  /** Every topic, with search, sort, estimates and bulk scheduling: what was "Keywords". */
  topics: "/content/topics",
  /** The sections of the topics view a link on the Content screen opens. */
  overlapping: "/content/topics#overlapping-topics",
  questions: "/content/topics#questions-people-ask",
} as const;

/** The old addresses and where they went. */
export const LEGACY_CONTENT_REDIRECTS = {
  "/dashboard/calendar": CONTENT_PATHS.articles,
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
