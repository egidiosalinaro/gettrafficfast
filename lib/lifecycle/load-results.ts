import type { SupabaseClient } from "@supabase/supabase-js";
import { hasActiveSearchConsoleIngest } from "@/lib/analytics/runs";
import { SEARCH_CONSOLE, searchConsoleNeedsPull } from "@/lib/analytics/search-console";
import type { CitationPoint } from "./citations";
import type { RankPoint } from "./rank";
import { latestPushes } from "./push-store";
import {
  pickRankSeries,
  summarizeCitations,
  summarizeDailyTraffic,
  summarizeRank,
  summarizeTotals,
  summarizeTraffic,
  type ArticleResult,
  type ResultsTotals,
  type SearchConsoleStatus,
  type TrafficPoint,
  type TrafficSeries,
} from "./results";

/**
 * Reading the measurements of a site's published articles, once: the
 * Results screen (GET /api/results), the Overview's Measure stage
 * (GET /api/home) and `get_results` all call these, so the three cannot
 * compute a different number from the same rows. The arithmetic is the pure
 * half in ./results.ts; this is the I/O around it.
 *
 * Every read goes through the caller's client (RLS, or the owner-scoped
 * service role), and the article ids are the site's own: a metric of
 * another site's article is never read here.
 */

/** No connection: what the Results screen shows before Search Console is connected. */
export const ABSENT_SEARCH_CONSOLE: SearchConsoleStatus = {
  status: "absent",
  siteUrl: null,
  lastSyncedOn: null,
  pulledAt: null,
  stale: false,
  lastError: null,
  syncing: false,
};

/**
 * The site's Search Console connection in its three states: never
 * connected, connected (waiting for the first sync, or synced), or broken.
 * The refresh token column is deliberately not selected: nothing that shows
 * the connection ever needs the credential.
 */
export async function loadSearchConsoleStatus(supabase: SupabaseClient, businessId: string): Promise<SearchConsoleStatus> {
  const { data: connectionRow } = await supabase
    .from("analytics_connections")
    .select("site_url, status, last_error, last_synced_on, updated_at")
    .eq("business_id", businessId)
    .eq("provider", SEARCH_CONSOLE)
    .maybeSingle();

  if (!connectionRow || connectionRow.status === "disconnected") return { ...ABSENT_SEARCH_CONSOLE };

  const syncing =
    connectionRow.status !== "error" &&
    Boolean(connectionRow.site_url) &&
    !connectionRow.last_synced_on &&
    (await hasActiveSearchConsoleIngest(supabase, businessId));

  return {
    status: connectionRow.status === "error" ? "error" : "connected",
    siteUrl: (connectionRow.site_url as string | null) ?? null,
    lastSyncedOn: (connectionRow.last_synced_on as string | null) ?? null,
    pulledAt: (connectionRow.updated_at as string | null) ?? null,
    stale: searchConsoleNeedsPull((connectionRow.last_synced_on as string | null) ?? null),
    lastError: connectionRow.status === "error" ? ((connectionRow.last_error as string | null) ?? null) : null,
    syncing,
  };
}

export interface PublishedArticle {
  id: string;
  keyword: string;
  publishedUrl: string | null;
}

/**
 * Rank, traffic and citations for each article, from two bulk reads rather
 * than two per article. `traffic` is every Search Console day of every
 * article, for the per-day series.
 *
 * Rank is split by source rather than merged: a scraped SERP position and
 * the average Google actually served are different measurements, and a
 * series that alternates between them describes neither.
 */
export async function articleResults(
  supabase: SupabaseClient,
  articles: readonly PublishedArticle[]
): Promise<{ results: ArticleResult[]; traffic: TrafficPoint[] }> {
  if (articles.length === 0) return { results: [], traffic: [] };
  const ids = articles.map((a) => a.id);

  const [{ data: metrics }, { data: citations }, pushes] = await Promise.all([
    supabase
      .from("content_metrics")
      .select("article_id, captured_on, position, source, impressions, clicks")
      .in("article_id", ids)
      .order("captured_on", { ascending: true }),
    supabase
      .from("ai_citations")
      .select("article_id, checked_on, engine, cited")
      .in("article_id", ids)
      .order("checked_on", { ascending: true }),
    latestPushes(supabase, ids),
  ]);

  const serpByArticle = new Map<string, RankPoint[]>();
  const consoleByArticle = new Map<string, RankPoint[]>();
  const trafficByArticle = new Map<string, TrafficPoint[]>();

  for (const row of metrics ?? []) {
    const articleId = row.article_id as string;
    const point: RankPoint = {
      capturedOn: row.captured_on as string,
      position: row.position === null ? null : Number(row.position),
    };

    if (row.source === "search_console") {
      consoleByArticle.set(articleId, [...(consoleByArticle.get(articleId) ?? []), point]);
      trafficByArticle.set(articleId, [
        ...(trafficByArticle.get(articleId) ?? []),
        {
          capturedOn: row.captured_on as string,
          impressions: Number(row.impressions ?? 0),
          clicks: Number(row.clicks ?? 0),
        },
      ]);
    } else {
      serpByArticle.set(articleId, [...(serpByArticle.get(articleId) ?? []), point]);
    }
  }

  const citationsByArticle = new Map<string, CitationPoint[]>();
  for (const row of citations ?? []) {
    const list = citationsByArticle.get(row.article_id as string) ?? [];
    list.push({
      checkedOn: row.checked_on as string,
      engine: row.engine as string,
      cited: Boolean(row.cited),
    });
    citationsByArticle.set(row.article_id as string, list);
  }

  const results: ArticleResult[] = articles.map((article) => {
    const series = pickRankSeries({
      searchConsole: consoleByArticle.get(article.id) ?? [],
      serp: serpByArticle.get(article.id) ?? [],
    });
    return {
      articleId: article.id,
      keyword: article.keyword,
      publishedUrl: article.publishedUrl,
      rank: summarizeRank(series.points),
      rankSource: series.source,
      traffic: summarizeTraffic(trafficByArticle.get(article.id) ?? []),
      citations: summarizeCitations(citationsByArticle.get(article.id) ?? []),
      // Only when the article was pushed: the answer is unchanged otherwise.
      ...(pushes.get(article.id)?.line
        ? { push: { line: pushes.get(article.id)!.line as string, status: pushes.get(article.id)!.status } }
        : {}),
    };
  });

  return { results, traffic: [...trafficByArticle.values()].flat() };
}

/** Everything the Results screen shows. */
export interface ResultsView {
  articles: ArticleResult[];
  totals: ResultsTotals;
  searchConsole: SearchConsoleStatus;
  traffic: TrafficSeries;
}

/** The Results screen with nothing published and nothing connected. */
export function emptyResults(searchConsole: SearchConsoleStatus = ABSENT_SEARCH_CONSOLE): ResultsView {
  return {
    articles: [],
    totals: summarizeTotals([]),
    searchConsole: { ...searchConsole },
    traffic: summarizeDailyTraffic([]),
  };
}

/** The site's published articles, newest first, with their measurements. Throws when the articles cannot be read. */
export async function loadResults(supabase: SupabaseClient, businessId: string): Promise<ResultsView> {
  const [{ data: rows, error }, searchConsole] = await Promise.all([
    supabase
      .from("articles")
      .select(
        `id, published_url, published_at:created_at,
         keywords!articles_keyword_id_fkey ( keyword )`
      )
      .eq("business_id", businessId)
      .eq("status", "published")
      .order("created_at", { ascending: false }),
    loadSearchConsoleStatus(supabase, businessId),
  ]);
  if (error) throw new Error(error.message);

  const articles: PublishedArticle[] = (rows ?? []).map((row) => {
    const kw = row.keywords as { keyword?: string } | { keyword?: string }[] | null;
    return {
      id: row.id as string,
      publishedUrl: (row.published_url as string | null) ?? null,
      keyword: (Array.isArray(kw) ? kw[0]?.keyword : kw?.keyword) ?? "",
    };
  });

  const { results, traffic } = await articleResults(supabase, articles);
  return {
    articles: results,
    totals: summarizeTotals(results),
    searchConsole,
    traffic: summarizeDailyTraffic(traffic),
  };
}
