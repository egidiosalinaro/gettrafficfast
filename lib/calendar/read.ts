import type { SupabaseClient } from "@supabase/supabase-js";
import type { QualityReport } from "@/lib/content/pipeline";
import type { CanonicalArticle } from "@/lib/content/types";

/**
 * The calendar as the screens and the API read it: every article of one
 * site, by day, with the keyword it was written for.
 *
 * `loadCalendarArticles` is what the calendar screen gets
 * (GET /api/calendar/get), bodies included. `listCalendarItems` is the same
 * list without bodies, filtered, for `list_calendar`; `loadArticle` is one
 * article with its body and quality report, for `get_article`. All three read
 * through the caller's client (RLS, or the owner-scoped service role) AND
 * filter `business_id`: an article of another site is not found.
 */

type Row = Record<string, unknown>;
type JoinedKeyword = { id?: string; keyword?: string; search_volume?: number | null };

const KEYWORD_JOIN = `keywords!articles_keyword_id_fkey (
  id,
  keyword,
  search_volume
)`;

function joinedKeyword(row: Row): JoinedKeyword | undefined {
  const joined = row.keywords as JoinedKeyword | JoinedKeyword[] | null | undefined;
  return Array.isArray(joined) ? joined[0] : (joined ?? undefined);
}

/** One article as the calendar screen receives it. */
export interface CalendarArticle {
  id: unknown;
  keywordId: unknown;
  keyword: string;
  searchVolume: number | null;
  scheduledDate: unknown;
  status: unknown;
  content: unknown;
  canonical: unknown;
  qualityReport: unknown;
  publishedUrl: unknown;
  lastError: unknown;
}

export type CalendarRead = { ok: true; articles: CalendarArticle[] } | { ok: false; error: unknown };

/**
 * The calendar screen's list: the site's articles by day, bodies included.
 * With `articleId`, that one article of the site, in the same shape (an empty
 * list when the site has no such article): what the Content screen opens in
 * the article modal without reading every body.
 */
export async function loadCalendarArticles(
  supabase: SupabaseClient,
  businessId: string,
  filter: { articleId?: string } = {}
): Promise<CalendarRead> {
  let query = supabase
    .from("articles")
    .select(
      `
        id,
        scheduled_date,
        status,
        content,
        canonical,
        quality_report,
        published_url,
        last_error,
        keyword_id,
        ${KEYWORD_JOIN}
      `
    )
    .eq("business_id", businessId);
  if (filter.articleId) query = query.eq("id", filter.articleId);
  const { data: rows, error } = await query.order("scheduled_date", { ascending: true });

  if (error) return { ok: false, error };

  return {
    ok: true,
    articles: ((rows || []) as Row[]).map((row) => {
      const kw = joinedKeyword(row);
      return {
        id: row.id,
        keywordId: row.keyword_id,
        keyword: kw?.keyword ?? "",
        searchVolume: kw?.search_volume ?? null,
        scheduledDate: row.scheduled_date,
        status: row.status,
        content: row.content,
        canonical: row.canonical,
        qualityReport: row.quality_report,
        publishedUrl: row.published_url,
        lastError: row.last_error,
      };
    }),
  };
}

/** One calendar entry without its body: what `list_calendar` lists. */
export interface CalendarItem {
  id: string;
  keywordId: string | null;
  keyword: string;
  /** A model's estimate, never measured; null when it gave none. */
  searchVolume: number | null;
  /** The canonical document's title; null before the article is written. */
  title: string | null;
  scheduledDate: string | null;
  status: string;
  publishedUrl: string | null;
  lastError: string | null;
}

export interface CalendarFilter {
  /** First day, inclusive, YYYY-MM-DD. */
  from?: string;
  /** Last day, inclusive, YYYY-MM-DD. */
  to?: string;
  status?: string;
}

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

function itemOf(row: Row): CalendarItem {
  const kw = joinedKeyword(row);
  return {
    id: row.id as string,
    keywordId: str(row.keyword_id),
    keyword: kw?.keyword ?? "",
    searchVolume: kw?.search_volume ?? null,
    title: str(row.title),
    scheduledDate: str(row.scheduled_date),
    status: String(row.status ?? ""),
    publishedUrl: str(row.published_url),
    lastError: str(row.last_error),
  };
}

const ITEM_COLUMNS = `id, scheduled_date, status, published_url, last_error, keyword_id,
  title:canonical->>title,
  ${KEYWORD_JOIN}`;

/** The site's calendar without bodies, by day, optionally between two days and in one status. */
export async function listCalendarItems(
  supabase: SupabaseClient,
  businessId: string,
  filter: CalendarFilter = {}
): Promise<CalendarItem[]> {
  let query = supabase.from("articles").select(ITEM_COLUMNS).eq("business_id", businessId);
  if (filter.from) query = query.gte("scheduled_date", filter.from);
  if (filter.to) query = query.lte("scheduled_date", filter.to);
  if (filter.status) query = query.eq("status", filter.status);
  const { data, error } = await query.order("scheduled_date", { ascending: true });
  if (error) throw new Error(`calendar: ${error.message}`);
  return ((data ?? []) as Row[]).map(itemOf);
}

/** One article with what it says and how the quality gates judged it. */
export interface ArticleRecord extends CalendarItem {
  /** The Canonical Article; null for a row written before the pipeline, or not written yet. */
  canonical: CanonicalArticle | null;
  /** The stored HTML of a legacy row. */
  content: string | null;
  qualityReport: QualityReport | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** One article of this site, or null when the site has no article with that id. */
export async function loadArticle(
  supabase: SupabaseClient,
  businessId: string,
  articleId: string
): Promise<ArticleRecord | null> {
  const { data, error } = await supabase
    .from("articles")
    .select(
      `id, scheduled_date, status, published_url, last_error, keyword_id, content, canonical,
       quality_report, created_at, updated_at, ${KEYWORD_JOIN}`
    )
    .eq("id", articleId)
    .eq("business_id", businessId)
    .maybeSingle();
  if (error) throw new Error(`article: ${error.message}`);
  if (!data) return null;
  const row = data as Row;
  const canonical =
    row.canonical && typeof row.canonical === "object" ? (row.canonical as CanonicalArticle) : null;
  return {
    ...itemOf(row),
    title: canonical?.title ?? null,
    canonical,
    content: str(row.content),
    qualityReport:
      row.quality_report && typeof row.quality_report === "object" ? (row.quality_report as QualityReport) : null,
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  };
}
