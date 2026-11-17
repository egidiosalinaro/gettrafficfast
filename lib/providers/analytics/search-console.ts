import {
  AnalyticsProvider,
  AnalyticsProviderError,
  AnalyticsQuery,
  AnalyticsQueryRow,
  AnalyticsRow,
  INSPECTION_VERDICTS,
  InspectionError,
  type InspectionErrorKind,
  type InspectionVerdict,
  type UrlInspection,
} from "./types";

/**
 * Google Search Console.
 *
 * Optional like every other external system: without OAuth credentials the
 * connect flow is unavailable and the ingestion sweep reports itself disabled.
 * Nothing else in the platform degrades.
 *
 * Everything here is stateless: the caller supplies an access token. Obtaining
 * and refreshing that token is the job of the functions below, and storing it
 * belongs to lib/analytics/search-console.ts.
 */

const OAUTH_AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
const OAUTH_TOKEN = "https://oauth2.googleapis.com/token";
const API_BASE = "https://searchconsole.googleapis.com/webmasters/v3";
const URL_INSPECTION = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect";

/**
 * The language Google writes `coverageState` in. Fixed to the interface's
 * locale, so "Crawled - currently not indexed" reads the same on every row.
 */
const INSPECTION_LANGUAGE = "en-US";

/** Read-only: the platform never needs to write to a customer's property. */
export const SEARCH_CONSOLE_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";

/** Google caps a single searchAnalytics page at 25k rows. */
const ROW_LIMIT = 25000;

export function isSearchConsoleConfigured(): boolean {
  return Boolean(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET);
}

function credentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new AnalyticsProviderError(
      "GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET are not set",
      "search_console"
    );
  }
  return { clientId, clientSecret };
}

/**
 * The consent URL.
 *
 * access_type=offline plus prompt=consent is not belt and braces: Google only
 * returns a refresh token on the first grant unless consent is forced, and a
 * connection without a refresh token works until the access token expires an
 * hour later and then silently stops.
 */
export function buildConsentUrl(params: { redirectUri: string; state: string }): string {
  const { clientId } = credentials();
  const url = new URL(OAUTH_AUTHORIZE);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SEARCH_CONSOLE_SCOPE);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", params.state);
  return url.toString();
}

async function postToken(body: Record<string, string>): Promise<Record<string, unknown>> {
  const response = await fetch(OAUTH_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new AnalyticsProviderError(
      `Google token exchange failed (${response.status}): ${String(payload.error_description ?? payload.error ?? "")}`,
      "search_console"
    );
  }
  return payload;
}

/** Exchanges the one-time code for tokens. The refresh token is the durable one. */
export async function exchangeAuthorizationCode(params: {
  code: string;
  redirectUri: string;
}): Promise<{ accessToken: string; refreshToken: string | null }> {
  const { clientId, clientSecret } = credentials();
  const payload = await postToken({
    code: params.code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: params.redirectUri,
    grant_type: "authorization_code",
  });
  return {
    accessToken: String(payload.access_token ?? ""),
    refreshToken: payload.refresh_token ? String(payload.refresh_token) : null,
  };
}

export async function refreshAccessToken(refreshToken: string): Promise<string> {
  const { clientId, clientSecret } = credentials();
  const payload = await postToken({
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
  });
  const accessToken = String(payload.access_token ?? "");
  if (!accessToken) {
    throw new AnalyticsProviderError("Google returned no access token", "search_console");
  }
  return accessToken;
}

export interface SearchConsoleSite {
  siteUrl: string;
  permissionLevel: string;
}

/** The properties this grant can read. The customer picks one. */
export async function listSites(accessToken: string): Promise<SearchConsoleSite[]> {
  const response = await fetch(`${API_BASE}/sites`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new AnalyticsProviderError(
      `Search Console site list failed (${response.status}): ${body.slice(0, 300)}`,
      "search_console"
    );
  }
  const payload = (await response.json()) as {
    siteEntry?: Array<{ siteUrl?: string; permissionLevel?: string }>;
  };
  return (payload.siteEntry ?? [])
    .filter((entry) => entry.siteUrl)
    .map((entry) => ({
      siteUrl: entry.siteUrl as string,
      permissionLevel: entry.permissionLevel ?? "unknown",
    }));
}

export interface SearchAnalyticsResponse {
  rows?: Array<{
    keys?: string[];
    clicks?: number;
    impressions?: number;
    position?: number;
  }>;
}

/**
 * Pure mapping from Google's payload to platform rows, exported so the
 * contract is pinned by tests without a network.
 *
 * Dimensions are requested as ["date", "page"], so keys[0] is the day and
 * keys[1] is the URL. Rows without both are dropped rather than guessed:
 * a metric attributed to the wrong page is worse than a missing one.
 */
export function parseSearchAnalyticsResponse(payload: SearchAnalyticsResponse): AnalyticsRow[] {
  return (payload.rows ?? [])
    .map((row) => {
      const [date, page] = row.keys ?? [];
      if (!date || !page) return null;
      return {
        date,
        page,
        impressions: Math.round(row.impressions ?? 0),
        clicks: Math.round(row.clicks ?? 0),
        // Google reports a 1-based average position as a float.
        position: typeof row.position === "number" ? row.position : 0,
      };
    })
    .filter((row): row is AnalyticsRow => row !== null);
}

/**
 * Pure mapping for a ["page", "query"] request: keys[0] is the URL and
 * keys[1] the query. Rows without both are dropped, as above.
 */
export function parseSearchQueryResponse(payload: SearchAnalyticsResponse): AnalyticsQueryRow[] {
  return (payload.rows ?? [])
    .map((row) => {
      const [page, query] = row.keys ?? [];
      if (!page || !query || !query.trim()) return null;
      return {
        page,
        query: query.trim(),
        impressions: Math.round(row.impressions ?? 0),
        clicks: Math.round(row.clicks ?? 0),
        position: typeof row.position === "number" ? row.position : 0,
      };
    })
    .filter((row): row is AnalyticsQueryRow => row !== null);
}

export class SearchConsoleProvider implements AnalyticsProvider {
  readonly name = "search_console";

  constructor(private readonly accessToken: string) {}

  async metrics(query: AnalyticsQuery): Promise<AnalyticsRow[]> {
    const endpoint = `${API_BASE}/sites/${encodeURIComponent(query.siteUrl)}/searchAnalytics/query`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        startDate: query.startDate,
        endDate: query.endDate,
        dimensions: ["date", "page"],
        rowLimit: ROW_LIMIT,
      }),
      signal: query.signal ?? null,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new AnalyticsProviderError(
        `Search Console query failed (${response.status}): ${body.slice(0, 300)}`,
        "search_console"
      );
    }

    return parseSearchAnalyticsResponse((await response.json()) as SearchAnalyticsResponse);
  }

  /**
   * Which searches showed each page over the range, one row per page and
   * query (no day). One request, one page of at most 25k rows, the largest
   * first: on a site big enough to exceed it, the long tail of rare queries
   * is what is left out, never a page's main query. Free, like every Search
   * Console call.
   */
  async queries(query: AnalyticsQuery): Promise<AnalyticsQueryRow[]> {
    const endpoint = `${API_BASE}/sites/${encodeURIComponent(query.siteUrl)}/searchAnalytics/query`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        startDate: query.startDate,
        endDate: query.endDate,
        dimensions: ["page", "query"],
        rowLimit: ROW_LIMIT,
      }),
      signal: query.signal ?? null,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new AnalyticsProviderError(
        `Search Console query report failed (${response.status}): ${body.slice(0, 300)}`,
        "search_console"
      );
    }
    return parseSearchQueryResponse((await response.json()) as SearchAnalyticsResponse);
  }

  /**
   * Google's URL Inspection for one URL of `siteUrl`: whether it is in the
   * index, and Google's reason in its own words when it is not.
   *
   * Free, and works with the read-only scope (`webmasters.readonly` is one of
   * the two scopes the method accepts). Google's quota is per property:
   * about 2,000 inspections a day and 600 a minute, which the callers stay
   * well under (lib/analytics/index-status.ts). A refusal is an
   * InspectionError whose `kind` says what to do: `quota` means stop for
   * today, `forbidden` means the grant cannot inspect this property.
   */
  async inspectUrl(siteUrl: string, url: string, signal?: AbortSignal): Promise<UrlInspection> {
    let response: Response;
    try {
      response = await fetch(URL_INSPECTION, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ inspectionUrl: url, siteUrl, languageCode: INSPECTION_LANGUAGE }),
        signal: signal ?? null,
      });
    } catch (err) {
      throw new InspectionError(
        `URL Inspection did not answer: ${err instanceof Error ? err.message : String(err)}`,
        "search_console",
        "unavailable",
        null
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new InspectionError(
        `URL Inspection failed (${response.status}): ${body.slice(0, 300)}`,
        "search_console",
        classifyInspectionStatus(response.status),
        response.status
      );
    }

    return parseUrlInspectionResponse(await response.json());
  }
}

/** An HTTP status from URL Inspection, as what the caller should do about it. */
export function classifyInspectionStatus(status: number): InspectionErrorKind {
  if (status === 403) return "forbidden";
  if (status === 429) return "quota";
  if (status === 400 || status === 404) return "invalid";
  if (status === 401) return "unauthorized";
  return "unavailable";
}

const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null;

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];

/**
 * Pure mapping from Google's `inspectionResult` to the platform's shape,
 * exported so the contract is pinned by fixtures without a network.
 *
 * Enum values Google adds later are kept as sent rather than refused; only
 * the verdict is narrowed, to VERDICT_UNSPECIFIED when it is not one we know,
 * because the verdict decides "indexed or not" and an unknown one must not.
 */
export function parseUrlInspectionResponse(payload: unknown): UrlInspection {
  const result = ((payload as { inspectionResult?: unknown } | null)?.inspectionResult ?? {}) as Record<string, unknown>;
  const index = (result.indexStatusResult ?? {}) as Record<string, unknown>;
  const verdict = (INSPECTION_VERDICTS as readonly string[]).includes(index.verdict as string)
    ? (index.verdict as InspectionVerdict)
    : "VERDICT_UNSPECIFIED";
  return {
    verdict,
    coverageState: str(index.coverageState),
    indexingState: str(index.indexingState),
    robotsTxtState: str(index.robotsTxtState),
    pageFetchState: str(index.pageFetchState),
    googleCanonical: str(index.googleCanonical),
    userCanonical: str(index.userCanonical),
    lastCrawlTime: str(index.lastCrawlTime),
    sitemap: strings(index.sitemap),
    referringUrls: strings(index.referringUrls),
    inspectionResultLink: str(result.inspectionResultLink),
    raw: payload,
  };
}
