/**
 * The analytics boundary. An analytics provider answers one question: what did
 * this site actually get, per page and per day?
 *
 * This is the first source of GROUND TRUTH in the platform. Rank measurement
 * samples the SERP and citation probing samples answer engines; both are
 * estimates by construction. Impressions and clicks are counted by the search
 * engine itself, which is why this connection is worth an OAuth flow.
 */

export interface AnalyticsQuery {
  /** The property in the vendor's own form, e.g. "sc-domain:example.com". */
  siteUrl: string;
  /** Inclusive ISO dates (YYYY-MM-DD). */
  startDate: string;
  endDate: string;
  signal?: AbortSignal;
}

export interface AnalyticsRow {
  /** The page URL the metrics belong to. */
  page: string;
  /** The day these metrics were counted, YYYY-MM-DD. */
  date: string;
  impressions: number;
  clicks: number;
  /** Average position over that day for that page. */
  position: number;
}

/**
 * One search query's numbers for one page over a whole range (no day): what
 * people typed when the engine showed that page. Rare queries the engine
 * anonymises are not reported, so a page's query rows can add up to fewer
 * impressions than its page row.
 */
export interface AnalyticsQueryRow {
  page: string;
  query: string;
  impressions: number;
  clicks: number;
  /** Average position over the range for that page on that query. */
  position: number;
}

export interface AnalyticsProvider {
  readonly name: string;
  metrics(query: AnalyticsQuery): Promise<AnalyticsRow[]>;
  /** Per page and query over the whole range. Optional: a provider without queries leaves them unknown. */
  queries?(query: AnalyticsQuery): Promise<AnalyticsQueryRow[]>;
}

export class AnalyticsProviderError extends Error {
  constructor(message: string, readonly provider: string, readonly cause?: unknown) {
    super(message);
    this.name = "AnalyticsProviderError";
  }
}

/**
 * How the search engine itself classifies one URL in its index: the state a
 * person sees in the engine's own inspection tool, in the engine's own words.
 *
 * Unlike rank and citations this is not sampled: it is the engine's record
 * for that URL as of its last crawl. It can still lag the live page by days,
 * which is why every stored row carries when it was asked.
 */
export const INSPECTION_VERDICTS = ["PASS", "PARTIAL", "FAIL", "NEUTRAL", "VERDICT_UNSPECIFIED"] as const;
export type InspectionVerdict = (typeof INSPECTION_VERDICTS)[number];

export interface UrlInspection {
  /** The engine's overall verdict: PASS is indexed; FAIL and NEUTRAL are not. */
  verdict: InspectionVerdict;
  /** The engine's human sentence: "Submitted and indexed", "Page with redirect". Null when absent. */
  coverageState: string | null;
  /** e.g. INDEXING_ALLOWED, BLOCKED_BY_META_TAG. Kept as the engine sends it. */
  indexingState: string | null;
  /** e.g. ALLOWED, DISALLOWED. */
  robotsTxtState: string | null;
  /** e.g. SUCCESSFUL, NOT_FOUND, REDIRECT_ERROR. */
  pageFetchState: string | null;
  googleCanonical: string | null;
  userCanonical: string | null;
  /** ISO instant of the engine's last crawl; null when it never crawled the URL. */
  lastCrawlTime: string | null;
  sitemap: string[];
  referringUrls: string[];
  /** The engine's own report for this URL, for a person to open. */
  inspectionResultLink: string | null;
  /** The engine's payload as received, for diagnosis. */
  raw: unknown;
}

/** Why an inspection was refused, in terms a caller can act on. */
export type InspectionErrorKind =
  /** 403: the grant cannot inspect this property (not owned, or a missing scope). */
  | "forbidden"
  /** 429: the property's or the project's quota is spent; stop and come back later. */
  | "quota"
  /** 400: the URL is not inside the property, or is malformed. */
  | "invalid"
  /** 401: the access token is not valid. */
  | "unauthorized"
  /** Anything else: the engine failed or did not answer. */
  | "unavailable";

export class InspectionError extends AnalyticsProviderError {
  constructor(
    message: string,
    provider: string,
    readonly kind: InspectionErrorKind,
    readonly status: number | null
  ) {
    super(message, provider);
    this.name = "InspectionError";
  }
}
