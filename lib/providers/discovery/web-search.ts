import { parseEngineDate, type DatePrecision } from "@/lib/providers/serp/dates";
import type { SerpProvider, SerpResult } from "@/lib/providers/serp/types";
import { SerpProviderError } from "@/lib/providers/serp/types";
import { canonicalTarget } from "./canonical";
import { REDDIT_ARCHIVE_DAYS } from "./reddit-ids";
import { Discussion, DiscoveryProvider, DiscoveryProviderError, DiscoveryQuery } from "./types";

/**
 * Web search as a discovery surface: the universal fallback.
 *
 * Every platform's public threads are indexed by the search engine, whether or
 * not the platform gives us an API. So one query, scoped with `site:` to the
 * places engines read, finds Reddit threads without Reddit's app, LinkedIn
 * articles and X posts without anyone's personal API key, GitHub pages beside
 * the API, and the question sites (Hacker News, Stack Exchange, Quora, Indie
 * Hackers, DEV) that have no API worth the name. It rides on the SERP provider
 * the platform already has (`lib/providers/serp/`); no second vendor is
 * introduced.
 *
 * What a search result knows is a URL, a title and a snippet, and often the
 * date the engine shows beside it. Engagement is null; the date is the
 * engine's when it shows one (as an instant or as "4 months ago", which is
 * kept as the bound it is) and null otherwise; the surface, kind, community
 * and identity are derived from the URL by the canonicaliser, so a thread
 * found here and the same thread found by a platform API collapse to one
 * row.
 */

export interface SearchScope {
  name: string;
  operator: string;
  /**
   * Ask the engine only for pages it dates within this window. Set where an
   * older page is worthless: Reddit archives a thread six months after it
   * is posted, so a thread older than that takes no reply and paying to
   * find it is paying to throw it away.
   */
  maxAgeDays?: number;
}

export { REDDIT_ARCHIVE_DAYS };

/** One paid search per scope per query; the scopes are where AEO is won. */
export const DEFAULT_SCOPES: ReadonlyArray<SearchScope> = [
  { name: "reddit", operator: "site:reddit.com", maxAgeDays: REDDIT_ARCHIVE_DAYS },
  { name: "github", operator: "site:github.com" },
  { name: "linkedin", operator: "site:linkedin.com/pulse OR site:linkedin.com/posts" },
  { name: "x", operator: "site:x.com" },
  {
    name: "communities",
    operator:
      "site:news.ycombinator.com OR site:indiehackers.com OR site:stackexchange.com OR site:stackoverflow.com OR site:quora.com OR site:dev.to",
  },
];

const EXCERPT_LIMIT = 600;

/**
 * Snippets often open with the page's date: "Aug 12, 2026 — …",
 * "12 Aug 2026 · …", "4 months ago — …". It is read with the same parser as
 * the engine's own date field and stripped from the excerpt; when there is
 * none the date stays null rather than "today".
 */
const LEADING_DATE = /^\s*([^—–·]{3,40}?)\s*(?:—|–|·|\.{3}|\s-\s)\s*/u;

export function splitLeadingDate(
  snippet: string,
  now: Date = new Date()
): { createdAt: string | null; createdAtPrecision: DatePrecision | null; text: string } {
  const match = LEADING_DATE.exec(snippet);
  const parsed = match ? parseEngineDate(match[1], now) : null;
  if (!match || !parsed) return { createdAt: null, createdAtPrecision: null, text: snippet.trim() };
  return { createdAt: parsed.at, createdAtPrecision: parsed.precision, text: snippet.slice(match[0].length).trim() };
}

/**
 * Pure mapping from search results to discussions; the contract is pinned by
 * tests. `now` is when the engine was asked, which a relative date needs.
 */
export function discussionsFromResults(results: SerpResult[], now: Date = new Date()): Discussion[] {
  const seen = new Set<string>();
  const out: Discussion[] = [];
  for (const result of results) {
    const canonical = canonicalTarget(result.url);
    if (!canonical || !result.title.trim()) continue;
    const key = `${canonical.surface}:${canonical.externalId}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // The engine's own date field first; the snippet's opening date when
    // there is none. Both are the engine's, read the same way.
    const leading = splitLeadingDate(result.snippet ?? "", now);
    const createdAt = result.publishedAt ?? leading.createdAt;
    const createdAtPrecision = result.publishedAt ? (result.publishedAtPrecision ?? "day") : leading.createdAtPrecision;
    out.push({
      externalId: canonical.externalId,
      surface: canonical.surface,
      kind: canonical.kind,
      url: canonical.url,
      title: cleanTitle(result.title, canonical.surface),
      excerpt: leading.text.slice(0, EXCERPT_LIMIT),
      community: canonical.community,
      author: canonical.author,
      createdAt,
      createdAtPrecision,
      score: null,
      commentCount: null,
    });
  }
  return out;
}

/** Search engines append the site name to titles: "… : r/seo" or "… - Reddit". */
function cleanTitle(title: string, surface: string): string {
  let clean = title.trim();
  if (surface === "reddit") clean = clean.replace(/\s*[:\-–|]\s*r\/\w+\s*$/i, "").replace(/\s*[-–|]\s*Reddit\s*$/i, "");
  if (surface === "github") clean = clean.replace(/\s*[·\-–|]\s*GitHub\s*$/i, "").replace(/\s*·\s*Issue #\d+\s*·\s*[\w.-]+\/[\w.-]+$/i, "");
  if (surface === "linkedin") clean = clean.replace(/\s*[-–|]\s*LinkedIn\s*$/i, "");
  if (surface === "x") clean = clean.replace(/\s*(?:\/|on)\s*X\s*$/i, "").replace(/^[^:]{1,60} on X:\s*"?/i, "").replace(/"\s*$/, "");
  if (surface === "hackernews") clean = clean.replace(/\s*[-–|]\s*Hacker News\s*$/i, "");
  if (surface === "quora") clean = clean.replace(/\s*[-–|]\s*Quora\s*$/i, "");
  if (surface === "stackexchange") {
    // "javascript - How do I … - Stack Overflow": the leading token is the
    // primary tag, the trailing one the site. Only a bare tag is stripped.
    clean = clean.replace(/\s*[-–|]\s*(?:[\w .+#]+ )?Stack (?:Exchange|Overflow)\s*$/i, "").replace(/^[a-z0-9.+#-]{1,30}\s+-\s+(?=\S)/, "");
  }
  if (surface === "indiehackers") clean = clean.replace(/\s*[-–|]\s*Indie Hackers\s*$/i, "");
  if (surface === "devto") clean = clean.replace(/\s*[-–|]\s*DEV Community\s*$/i, "");
  return clean.trim() || title.trim();
}

export class WebSearchDiscoveryProvider implements DiscoveryProvider {
  readonly name = "web-search";

  constructor(
    private readonly serp: SerpProvider,
    private readonly scopes: ReadonlyArray<SearchScope> = DEFAULT_SCOPES
  ) {}

  async search(query: DiscoveryQuery): Promise<Discussion[]> {
    const perScope = Math.min(query.limit ?? 10, 10);
    const now = new Date();

    // The scopes run together: one vendor, five small requests, and a
    // discovery run has dozens of queries behind this one.
    const outcomes = await Promise.all(
      this.scopes.map(async (scope) => {
        try {
          const data = await this.serp.search({
            keyword: `${query.query} ${scope.operator}`,
            language: query.language,
            maxResults: perScope,
            // The engine's filter only where the scope has a hard window;
            // the run's own age limit is applied to dated results later.
            ...(scope.maxAgeDays ? { maxAgeDays: scope.maxAgeDays } : {}),
            signal: query.signal,
          });
          return { scope, discussions: discussionsFromResults(data.results, now), error: null };
        } catch (err) {
          return { scope, discussions: [] as Discussion[], error: err };
        }
      })
    );

    const failures = outcomes.filter((o) => o.error !== null);
    const rateLimited = failures.find(
      (o) => o.error instanceof SerpProviderError && (o.error.status === 429 || o.error.status === 403)
    );
    // A rate limit stops the provider for the run; one scope failing for
    // another reason loses that scope's results and nothing else. Only when
    // every scope failed is there nothing to hand back.
    if (rateLimited || failures.length === outcomes.length) {
      const first = (rateLimited ?? failures[0]).error;
      const status = first instanceof SerpProviderError ? first.status : undefined;
      throw new DiscoveryProviderError(
        `Web search failed for scope "${(rateLimited ?? failures[0]).scope.name}": ${first instanceof Error ? first.message : String(first)}`,
        this.name,
        first,
        { status }
      );
    }

    // Two scopes can return the same URL (a GitHub link surfacing in the
    // communities scope); the canonical key collapses them.
    const seen = new Set<string>();
    return outcomes
      .flatMap((o) => o.discussions)
      .filter((d) => {
        const key = `${d.surface}:${d.externalId}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }
}
