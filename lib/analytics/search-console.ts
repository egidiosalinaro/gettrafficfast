import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptSecret, encryptSecret } from "@/lib/integrations/crypto";
import type { AnalyticsQueryRow, AnalyticsRow } from "@/lib/providers/analytics/types";
import { refreshAccessToken, SearchConsoleProvider } from "@/lib/providers/analytics/search-console";

/**
 * Search Console ingestion.
 *
 * This is the first real traffic the platform can show: impressions and clicks
 * counted by Google itself, not sampled. It lands in `content_metrics`
 * alongside SERP-derived rank, tagged with its own source, exactly as that
 * table was designed for from day one.
 *
 * Rank and Search Console coexist rather than compete: they answer slightly
 * different questions (where a scraped SERP put us on one day, versus the
 * average position Google actually served over that day) and the unique key
 * keeps one from overwriting the other.
 */

export const SEARCH_CONSOLE = "search_console";

/** Google keeps roughly 16 months; a first sync does not need all of it. */
export const FIRST_SYNC_DAYS = 90;

/** Search Console data settles over about three days. Re-reading the tail is
 *  cheap and stops us freezing a number that was still moving. */
export const RESETTLE_DAYS = 3;

export interface AnalyticsConnection {
  id: string;
  userId: string;
  businessId: string | null;
  siteUrl: string | null;
  refreshToken: string;
  lastSyncedOn: string | null;
  /** When the last pull finished. Distinct from lastSyncedOn, which is the newest day fetched. */
  pulledAt: string | null;
}

/**
 * Loads a site's connection, decrypting the credential. Service-role only.
 *
 * Keyed by business: one account can own two properties in Search Console, one
 * per site, and loading "the user's connection" would attribute one site's
 * traffic to the other's articles.
 */
export async function loadConnection(params: {
  supabase: SupabaseClient;
  businessId: string;
}): Promise<AnalyticsConnection | null> {
  const { data } = await params.supabase
    .from("analytics_connections")
    .select("id, user_id, business_id, site_url, refresh_token_encrypted, last_synced_on, updated_at, status")
    .eq("business_id", params.businessId)
    .eq("provider", SEARCH_CONSOLE)
    .maybeSingle();

  if (!data || data.status === "disconnected") return null;

  return {
    id: data.id as string,
    userId: data.user_id as string,
    businessId: (data.business_id as string | null) ?? null,
    siteUrl: (data.site_url as string | null) ?? null,
    refreshToken: decryptSecret(data.refresh_token_encrypted as string),
    lastSyncedOn: (data.last_synced_on as string | null) ?? null,
    pulledAt: (data.updated_at as string | null) ?? null,
  };
}

/**
 * True when a pull would ask Google for a day we have not stored yet.
 * A watermark already equal to the newest settled day is not due: opening
 * Results again the same day must not spend another query on the same window.
 */
export function searchConsoleNeedsPull(lastSyncedOn: string | null, today = new Date()): boolean {
  if (!lastSyncedOn) return true;
  return lastSyncedOn < nextSyncWindow(lastSyncedOn, today).endDate;
}

export async function saveConnection(params: {
  supabase: SupabaseClient;
  userId: string;
  businessId: string;
  refreshToken: string;
  siteUrl?: string | null;
}): Promise<void> {
  const { error } = await params.supabase.from("analytics_connections").upsert(
    {
      user_id: params.userId,
      business_id: params.businessId,
      provider: SEARCH_CONSOLE,
      refresh_token_encrypted: encryptSecret(params.refreshToken),
      site_url: params.siteUrl ?? null,
      status: "connected",
      last_error: null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "business_id,provider" }
  );
  if (error) throw new Error(`analytics connection upsert failed: ${error.message}`);
}

/** Comparable form of a URL: no scheme case, no trailing slash, no query. */
export function normalizeUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "";
  try {
    const parsed = new URL(trimmed);
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.hostname.toLowerCase().replace(/^www\./, "")}${path}`.toLowerCase();
  } catch {
    return trimmed.replace(/\/+$/, "").toLowerCase();
  }
}

export interface DailyArticleMetrics {
  articleId: string;
  date: string;
  impressions: number;
  clicks: number;
  position: number;
}

/**
 * Folds Google's rows onto our articles.
 *
 * Several URLs can map to one article (a trailing slash, a tracking parameter,
 * http and https). Their metrics are SUMMED, and the position is averaged
 * weighted by impressions, because a position seen by three people and one
 * seen by three thousand are not worth the same. Rows we cannot attribute are
 * dropped: a metric on the wrong article is worse than a missing one.
 */
export function groupRowsByArticle(
  rows: AnalyticsRow[],
  articles: Array<{ id: string; publishedUrl: string }>
): DailyArticleMetrics[] {
  const byUrl = new Map<string, string>();
  for (const article of articles) {
    const key = normalizeUrl(article.publishedUrl);
    if (key) byUrl.set(key, article.id);
  }

  const buckets = new Map<
    string,
    { articleId: string; date: string; impressions: number; clicks: number; weighted: number }
  >();

  for (const row of rows) {
    const articleId = byUrl.get(normalizeUrl(row.page));
    if (!articleId) continue;

    const key = `${articleId}|${row.date}`;
    const bucket = buckets.get(key) ?? {
      articleId,
      date: row.date,
      impressions: 0,
      clicks: 0,
      weighted: 0,
    };
    bucket.impressions += row.impressions;
    bucket.clicks += row.clicks;
    bucket.weighted += row.position * row.impressions;
    buckets.set(key, bucket);
  }

  return [...buckets.values()].map((bucket) => ({
    articleId: bucket.articleId,
    date: bucket.date,
    impressions: bucket.impressions,
    clicks: bucket.clicks,
    // With zero impressions there is no weight to average by, and no position
    // worth reporting either.
    position: bucket.impressions > 0 ? bucket.weighted / bucket.impressions : 0,
  }));
}

/** The window the stored queries cover: the last 28 settled days. */
export const QUERY_WINDOW_DAYS = 28;

export interface ArticleQueryMetrics {
  articleId: string;
  query: string;
  impressions: number;
  clicks: number;
  /** Impression-weighted over the URL variants; null with no impression. */
  position: number | null;
}

/**
 * Folds Google's (page, query) rows onto our articles, the same way
 * `groupRowsByArticle` folds days: URL variants of one article summed, the
 * position weighted by impressions, rows we cannot attribute dropped. The
 * query is compared as Google wrote it, lowercased and trimmed.
 */
export function groupQueriesByArticle(
  rows: AnalyticsQueryRow[],
  articles: Array<{ id: string; publishedUrl: string }>
): ArticleQueryMetrics[] {
  const byUrl = new Map<string, string>();
  for (const article of articles) {
    const key = normalizeUrl(article.publishedUrl);
    if (key) byUrl.set(key, article.id);
  }
  const buckets = new Map<string, { articleId: string; query: string; impressions: number; clicks: number; weighted: number }>();
  for (const row of rows) {
    const articleId = byUrl.get(normalizeUrl(row.page));
    const query = row.query.trim().toLowerCase().replace(/\s+/g, " ");
    if (!articleId || !query) continue;
    const key = `${articleId}|${query}`;
    const bucket = buckets.get(key) ?? { articleId, query, impressions: 0, clicks: 0, weighted: 0 };
    bucket.impressions += row.impressions;
    bucket.clicks += row.clicks;
    bucket.weighted += row.position * row.impressions;
    buckets.set(key, bucket);
  }
  return [...buckets.values()].map((b) => ({
    articleId: b.articleId,
    query: b.query,
    impressions: b.impressions,
    clicks: b.clicks,
    position: b.impressions > 0 ? b.weighted / b.impressions : null,
  }));
}

/** The 28 settled days ending on `endDate`, inclusive. */
export function queryWindow(endDate: string): { startDate: string; endDate: string } {
  const start = new Date(new Date(`${endDate}T00:00:00Z`).getTime() - (QUERY_WINDOW_DAYS - 1) * 86_400_000);
  return { startDate: start.toISOString().slice(0, 10), endDate };
}

/**
 * Pulls which searches showed each published article over the last 28
 * settled days and stores them in `content_queries` (one row per article and
 * query, replaced on every pull; `period_end` names the window). Free: one
 * Search Console request per site per day. Best-effort: a failure here is
 * returned, never thrown, so the page-level numbers above still land.
 */
export async function ingestSearchConsoleQueries(params: {
  supabase: SupabaseClient;
  connection: AnalyticsConnection;
  provider: Pick<SearchConsoleProvider, "queries">;
  articles: Array<{ id: string; publishedUrl: string }>;
  endDate: string;
}): Promise<{ status: "ingested"; rows: number; stored: number } | { status: "failed"; error: string }> {
  const { supabase, connection, articles } = params;
  if (!connection.siteUrl) return { status: "failed", error: "no property selected" };
  const window = queryWindow(params.endDate);
  try {
    const rows = await params.provider.queries({ siteUrl: connection.siteUrl, ...window });
    const grouped = groupQueriesByArticle(rows, articles);
    const now = new Date().toISOString();
    for (let i = 0; i < grouped.length; i += 1000) {
      const { error } = await supabase.from("content_queries").upsert(
        grouped.slice(i, i + 1000).map((metric) => ({
          article_id: metric.articleId,
          query: metric.query,
          user_id: connection.userId,
          business_id: connection.businessId,
          period_start: window.startDate,
          period_end: window.endDate,
          impressions: metric.impressions,
          clicks: metric.clicks,
          position: metric.position === null ? null : Number(metric.position.toFixed(2)),
          updated_at: now,
        })),
        { onConflict: "article_id,query" }
      );
      if (error) throw new Error(`content_queries upsert failed: ${error.message}`);
    }
    return { status: "ingested", rows: rows.length, stored: grouped.length };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.warn(JSON.stringify({ level: "warn", event: "search_console.queries_failed", business_id: connection.businessId, error: error.slice(0, 300) }));
    return { status: "failed", error };
  }
}

/** The window to fetch: resume from the last sync, re-reading the unsettled tail. */
export function nextSyncWindow(
  lastSyncedOn: string | null,
  today: Date,
  firstSyncDays = FIRST_SYNC_DAYS
): { startDate: string; endDate: string } {
  const day = (offset: number) =>
    new Date(today.getTime() - offset * 86_400_000).toISOString().slice(0, 10);

  // Google lags by a couple of days; asking for today returns nothing useful.
  const endDate = day(RESETTLE_DAYS - 1);
  if (!lastSyncedOn) return { startDate: day(firstSyncDays), endDate };

  const resume = new Date(new Date(lastSyncedOn).getTime() - RESETTLE_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return { startDate: resume, endDate };
}

/**
 * Pulls one window and records it. Returns what was written, so the sweep can
 * report something truthful instead of "done".
 */
export async function ingestSearchConsole(params: {
  supabase: SupabaseClient;
  connection: AnalyticsConnection;
  articles: Array<{ id: string; publishedUrl: string }>;
  today?: Date;
}): Promise<{
  rows: number;
  matched: number;
  window: { startDate: string; endDate: string };
  queries?: Awaited<ReturnType<typeof ingestSearchConsoleQueries>>;
}> {
  const { supabase, connection, articles } = params;
  if (!connection.siteUrl) {
    throw new Error("no Search Console property selected for this connection");
  }

  const window = nextSyncWindow(connection.lastSyncedOn, params.today ?? new Date());
  const accessToken = await refreshAccessToken(connection.refreshToken);
  const provider = new SearchConsoleProvider(accessToken);

  const rows = await provider.metrics({
    siteUrl: connection.siteUrl,
    startDate: window.startDate,
    endDate: window.endDate,
  });

  const grouped = groupRowsByArticle(rows, articles);

  if (grouped.length > 0) {
    const { error } = await supabase.from("content_metrics").upsert(
      grouped.map((metric) => ({
        user_id: connection.userId,
        business_id: connection.businessId,
        article_id: metric.articleId,
        captured_on: metric.date,
        source: SEARCH_CONSOLE,
        position: Number(metric.position.toFixed(2)),
        impressions: metric.impressions,
        clicks: metric.clicks,
      })),
      { onConflict: "article_id,captured_on,source" }
    );
    if (error) throw new Error(`search console metrics upsert failed: ${error.message}`);
  }

  // Which searches showed each article (Push page 3, docs/LIFECYCLE.md):
  // best-effort, after the page numbers are stored.
  const queries = await ingestSearchConsoleQueries({
    supabase,
    connection,
    provider,
    articles,
    endDate: window.endDate,
  });

  await supabase
    .from("analytics_connections")
    .update({
      last_synced_on: window.endDate,
      status: "connected",
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", connection.id);

  return { rows: rows.length, matched: grouped.length, window, queries };
}

/** Records a failure on the connection so the settings page can show it. */
export async function markConnectionError(params: {
  supabase: SupabaseClient;
  connectionId: string;
  message: string;
}): Promise<void> {
  await params.supabase
    .from("analytics_connections")
    .update({
      status: "error",
      last_error: params.message.slice(0, 500),
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.connectionId);
}

export type SearchConsoleIngestResult =
  | {
      status: "ingested";
      rows: number;
      matched: number;
      window: { startDate: string; endDate: string };
      queries?: Awaited<ReturnType<typeof ingestSearchConsoleQueries>>;
    }
  | {
      status: "skipped";
      reason: "no_connection" | "no_property" | "no_published_articles";
    };

/**
 * One business, one ingest. Shared by the daily sweep and the first-connect
 * job, so a property selected at 15:00 does not wait until 07:00.
 *
 * No published articles is a skip, not a watermark: marking last_synced_on
 * without fetching would shrink the next window to three days and lose the
 * 90-day first pull. The UI says so, instead of promising a daily sync that
 * still cannot attribute anything.
 */
export async function ingestBusinessSearchConsole(params: {
  supabase: SupabaseClient;
  businessId: string;
  today?: Date;
}): Promise<SearchConsoleIngestResult> {
  const connection = await loadConnection({
    supabase: params.supabase,
    businessId: params.businessId,
  });
  if (!connection) return { status: "skipped", reason: "no_connection" };
  if (!connection.siteUrl) return { status: "skipped", reason: "no_property" };

  const { data: articles } = await params.supabase
    .from("articles")
    .select("id, published_url")
    .eq("business_id", params.businessId)
    .eq("status", "published");

  const published = (articles ?? [])
    .map((row) => ({
      id: row.id as string,
      publishedUrl: (row.published_url as string | null)?.trim() ?? "",
    }))
    .filter((row) => row.publishedUrl);

  if (published.length === 0) {
    return { status: "skipped", reason: "no_published_articles" };
  }

  try {
    const result = await ingestSearchConsole({
      supabase: params.supabase,
      connection,
      articles: published,
      today: params.today,
    });
    return { status: "ingested", ...result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markConnectionError({
      supabase: params.supabase,
      connectionId: connection.id,
      message,
    });
    throw err;
  }
}
