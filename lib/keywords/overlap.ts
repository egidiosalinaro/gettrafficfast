import type { SupabaseClient } from "@supabase/supabase-js";
import { formatPosition, roundPosition } from "@/lib/format";
import {
  DUPLICATE_REASON_TEXT,
  clusterDuplicates,
  duplicateIndex,
  topSerpUrls,
  type DuplicateEntry,
  type DuplicateIndex,
  type DuplicateReason,
} from "./duplicates";

/**
 * The site's topics as the near-duplicate rule (lib/keywords/duplicates.ts)
 * reads them, and the three uses of it:
 *
 *  - `findOverlaps`: which of a batch of new phrases duplicate a keyword the
 *    site has, or a published article (adding and suggesting);
 *  - `committedIndex`: the topics already scheduled, being written or
 *    published, which a keyword about to be scheduled must not duplicate
 *    (the calendar and Autopilot);
 *  - `loadOverlappingTopics`: the clusters that already exist, with what
 *    Search Console measured for each article and which one to keep
 *    ("Overlapping topics" on the Keywords screen, `list_duplicate_keywords`).
 *
 * Reads only, through the caller's client, every one filtered by
 * `business_id`. No model is asked and nothing is fetched from outside: free.
 * Nothing here deletes, merges or redirects anything.
 */

/** How many of the site's most recent SERP snapshots are read for the second signal. */
export const SERP_SNAPSHOTS_READ = 500;
/** How many Search Console rows are read for the clusters' articles. */
export const METRIC_ROWS_READ = 5000;

export interface TopicKeyword {
  id: string;
  keyword: string;
  status: string;
  articleId: string | null;
  /** Top result pages of its latest stored SERP snapshot; null when it has none. */
  serpUrls: string[] | null;
}

export interface TopicArticle {
  id: string;
  keywordId: string | null;
  status: string;
  title: string | null;
  publishedUrl: string | null;
  scheduledDate: string | null;
}

export interface SiteTopics {
  keywords: TopicKeyword[];
  articles: TopicArticle[];
}

export type SiteTopicsRead = ({ ok: true } & SiteTopics) | { ok: false; error: unknown };

const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/**
 * The site's keywords and articles, and, with `serp`, the top results of each
 * keyword's latest stored snapshot. Two reads, or three: never one per row.
 */
export async function loadSiteTopics(
  supabase: SupabaseClient,
  businessId: string,
  options: { serp?: boolean } = {}
): Promise<SiteTopicsRead> {
  const [keywords, articles, snapshots] = await Promise.all([
    supabase.from("keywords").select("id, keyword, status, article_id").eq("business_id", businessId),
    supabase
      .from("articles")
      .select("id, keyword_id, status, published_url, scheduled_date, title:canonical->>title")
      .eq("business_id", businessId),
    options.serp
      ? supabase
          .from("serp_snapshots")
          // Only the result list: the snapshot also keeps the provider's raw payload.
          .select("keyword_id, captured_at, urls:results->results")
          .eq("business_id", businessId)
          .order("captured_at", { ascending: false })
          .limit(SERP_SNAPSHOTS_READ)
      : Promise.resolve({ data: [], error: null }),
  ]);
  const failed = keywords.error ?? articles.error;
  if (failed) return { ok: false, error: failed };
  // The second signal is optional: a snapshot read that fails leaves the
  // word signal standing, and says so in the log rather than failing the page.
  if (snapshots.error) console.error("Error reading SERP snapshots for overlap:", snapshots.error);

  const serpByKeyword = new Map<string, string[]>();
  for (const row of (snapshots.data ?? []) as Array<Record<string, unknown>>) {
    const keywordId = str(row.keyword_id);
    // Newest first: the first snapshot seen for a keyword is its latest.
    if (!keywordId || serpByKeyword.has(keywordId)) continue;
    const results = row.urls ?? (row.results as { results?: unknown } | null)?.results;
    const urls = topSerpUrls(results);
    if (urls.length > 0) serpByKeyword.set(keywordId, urls);
  }

  return {
    ok: true,
    keywords: ((keywords.data ?? []) as Array<Record<string, unknown>>).flatMap((row) => {
      const id = str(row.id);
      const keyword = str(row.keyword);
      if (!id || !keyword) return [];
      return [
        {
          id,
          keyword,
          status: str(row.status) ?? "available",
          articleId: str(row.article_id),
          serpUrls: serpByKeyword.get(id) ?? null,
        },
      ];
    }),
    articles: ((articles.data ?? []) as Array<Record<string, unknown>>).flatMap((row) => {
      const id = str(row.id);
      if (!id) return [];
      return [
        {
          id,
          keywordId: str(row.keyword_id),
          status: str(row.status) ?? "queued",
          title: str(row.title),
          publishedUrl: str(row.published_url),
          scheduledDate: str(row.scheduled_date),
        },
      ];
    }),
  };
}

/** What a phrase duplicates: a keyword of the site, with its article when it has one, or a published article. */
export interface DuplicateOf {
  keywordId: string | null;
  keyword: string | null;
  /** available, queued, published…: the keyword's own status; null for an article with no keyword. */
  status: string | null;
  articleId: string | null;
  articleTitle: string | null;
  publishedUrl: string | null;
  reason: DuplicateReason;
  /** The reason in words, as the screens say it. */
  why: string;
}

const keywordEntryId = (id: string) => `keyword:${id}`;
const articleEntryId = (id: string) => `article:${id}`;

function keywordEntry(keyword: TopicKeyword): DuplicateEntry {
  return { id: keywordEntryId(keyword.id), text: keyword.keyword, serpUrls: keyword.serpUrls };
}

/** Resolves an index match back to the keyword or article it stands for. */
function describe(topics: SiteTopics, entryId: string, reason: DuplicateReason): DuplicateOf {
  const articleById = new Map(topics.articles.map((a) => [a.id, a]));
  const base = { reason, why: DUPLICATE_REASON_TEXT[reason] };
  if (entryId.startsWith("article:")) {
    const article = articleById.get(entryId.slice("article:".length)) ?? null;
    const keyword = article?.keywordId ? topics.keywords.find((k) => k.id === article.keywordId) : undefined;
    return {
      ...base,
      keywordId: keyword?.id ?? null,
      keyword: keyword?.keyword ?? null,
      status: keyword?.status ?? null,
      articleId: article?.id ?? null,
      articleTitle: article?.title ?? null,
      publishedUrl: article?.publishedUrl ?? null,
    };
  }
  const keyword = topics.keywords.find((k) => keywordEntryId(k.id) === entryId);
  const article = keyword?.articleId ? (articleById.get(keyword.articleId) ?? null) : null;
  return {
    ...base,
    keywordId: keyword?.id ?? null,
    keyword: keyword?.keyword ?? null,
    status: keyword?.status ?? null,
    articleId: article?.id ?? null,
    articleTitle: article?.title ?? null,
    publishedUrl: article?.publishedUrl ?? null,
  };
}

/** Every keyword of the site, and the title of every published article. */
function knownIndex(topics: SiteTopics): DuplicateIndex {
  return duplicateIndex([
    ...topics.keywords.map(keywordEntry),
    ...topics.articles
      .filter((a) => a.status === "published" && a.title)
      .map((a) => ({ id: articleEntryId(a.id), text: a.title as string, kind: "title" as const })),
  ]);
}

export interface PhraseOverlap {
  keyword: string;
  /** Null when it duplicates an earlier phrase of the same batch rather than something the site has. */
  duplicateOf: DuplicateOf | null;
  /** The earlier phrase of the batch it duplicates, when that is the case. */
  duplicateOfPhrase: string | null;
  reason: DuplicateReason;
  why: string;
}

/**
 * Splits a batch of new phrases into the ones that are new topics and the
 * ones that duplicate a keyword the site has, a published article, or an
 * earlier phrase of the same batch. A phrase the site already has letter for
 * letter is NOT reported here: that is the unique index's case ("already in
 * your list"), which the callers answered before this rule existed.
 */
export function findOverlaps(topics: SiteTopics, phrases: readonly string[]): { fresh: string[]; overlaps: PhraseOverlap[] } {
  const index = knownIndex(topics);
  const stored = new Set(topics.keywords.map((k) => k.keyword));
  const fresh: string[] = [];
  const overlaps: PhraseOverlap[] = [];
  phrases.forEach((raw, position) => {
    const phrase = raw.trim();
    if (stored.has(phrase)) {
      fresh.push(raw);
      return;
    }
    const batchId = `batch:${position}`;
    const match = index.find({ id: batchId, text: phrase });
    if (!match) {
      fresh.push(raw);
      index.add({ id: batchId, text: phrase });
      return;
    }
    const inBatch = match.entry.id.startsWith("batch:");
    overlaps.push({
      keyword: phrase,
      duplicateOf: inBatch ? null : describe(topics, match.entry.id, match.reason),
      duplicateOfPhrase: inBatch ? match.entry.text : null,
      reason: match.reason,
      why: DUPLICATE_REASON_TEXT[match.reason],
    });
  });
  return { fresh, overlaps };
}

/**
 * The topics the site has committed to: every keyword with an article on the
 * calendar, being written, written or published (any article row at all),
 * and every published article's title. A keyword about to be scheduled is
 * checked against these; a keyword that merely sits in the pool commits to
 * nothing.
 */
export function committedIndex(topics: SiteTopics): { index: DuplicateIndex; describe: (entryId: string, reason: DuplicateReason) => DuplicateOf } {
  const articleIds = new Set(topics.articles.map((a) => a.id));
  const index = duplicateIndex([
    ...topics.keywords.filter((k) => k.articleId && articleIds.has(k.articleId)).map(keywordEntry),
    ...topics.articles
      .filter((a) => a.status === "published" && a.title)
      .map((a) => ({ id: articleEntryId(a.id), text: a.title as string, kind: "title" as const })),
  ]);
  return { index, describe: (entryId, reason) => describe(topics, entryId, reason) };
}

export interface ScheduleRefusal {
  keywordId: string;
  keyword: string;
  duplicateOf: DuplicateOf;
  /** The sentence the screens and the tools show. */
  reason: string;
}

function refusalText(keyword: string, of: DuplicateOf): string {
  const other = of.keyword ? `"${of.keyword}"` : of.articleTitle ? `the article "${of.articleTitle}"` : "another topic";
  const state = of.publishedUrl ? "is already published" : "is already on the calendar";
  return `"${keyword}" overlaps ${other}, which ${state} (${of.why}). Two articles on one topic compete with each other.`;
}

/**
 * Of the keywords about to be scheduled, in the order given: the ones that
 * may go on the calendar, and the ones refused because a near-duplicate is
 * already scheduled, being written or published, or was accepted earlier in
 * this same call. Order is the caller's priority: the first of two
 * duplicates wins.
 */
export function splitSchedulable<T extends { id: string }>(
  topics: SiteTopics,
  candidates: readonly T[]
): { schedulable: T[]; refused: ScheduleRefusal[] } {
  const { index, describe: describeMatch } = committedIndex(topics);
  const byId = new Map(topics.keywords.map((k) => [k.id, k]));
  const schedulable: T[] = [];
  const refused: ScheduleRefusal[] = [];
  for (const candidate of candidates) {
    const keyword = byId.get(candidate.id);
    // Not one of the site's keywords: nothing to compare, the caller's own
    // checks decide.
    if (!keyword) {
      schedulable.push(candidate);
      continue;
    }
    const entry = keywordEntry(keyword);
    const match = index.find(entry);
    if (!match) {
      schedulable.push(candidate);
      index.add(entry);
      continue;
    }
    const duplicateOf = describeMatch(match.entry.id, match.reason);
    refused.push({ keywordId: keyword.id, keyword: keyword.keyword, duplicateOf, reason: refusalText(keyword.keyword, duplicateOf) });
  }
  return { schedulable, refused };
}

// ── Existing clusters ───────────────────────────────────────────────────────

export interface SearchConsoleTotals {
  /** Impressions Search Console counted for the article, all stored days; null when it has no Search Console row. */
  impressions: number | null;
  clicks: number | null;
  /**
   * Average position, weighted by impressions, over the days that have one;
   * null when none was measured. Lower is better.
   */
  position: number | null;
  /** Days of Search Console data behind the numbers. 0 means not measured, not zero traffic. */
  days: number;
}

export interface OverlapMember {
  keywordId: string;
  keyword: string;
  status: string;
  article: { id: string; status: string; title: string | null; publishedUrl: string | null; scheduledDate: string | null } | null;
  /** Null when the keyword has no article: there is nothing to measure. */
  searchConsole: SearchConsoleTotals | null;
}

export type KeeperBasis = "most_impressions" | "best_position" | "only_published" | "not_measured" | "nothing_published";

export interface OverlapCluster {
  members: OverlapMember[];
  reasons: DuplicateReason[];
  /** The member whose article to keep; null when nothing measured can tell. */
  keeperKeywordId: string | null;
  keeperBasis: KeeperBasis;
  /** The recommendation in words. */
  recommendation: string;
}

export const OVERLAP_NOTE =
  "Clusters are found by comparing the keywords' words, and, where both keywords have a stored results page, their top 10 results. Impressions, clicks and position are Search Console's own counts for each article over the days stored; null means not measured, never zero. The keeper is a suggestion: nothing is deleted, merged or redirected.";

function totalsOf(rows: Array<{ position: number | null; impressions: number | null; clicks: number | null }>): SearchConsoleTotals {
  if (rows.length === 0) return { impressions: null, clicks: null, position: null, days: 0 };
  let impressions = 0;
  let clicks = 0;
  let weighted = 0;
  let weight = 0;
  let plain = 0;
  let positioned = 0;
  for (const row of rows) {
    impressions += row.impressions ?? 0;
    clicks += row.clicks ?? 0;
    if (row.position === null) continue;
    plain += row.position;
    positioned += 1;
    weighted += row.position * (row.impressions ?? 0);
    weight += row.impressions ?? 0;
  }
  const position = positioned === 0 ? null : weight > 0 ? weighted / weight : plain / positioned;
  return { impressions, clicks, position: position === null ? null : roundPosition(position), days: rows.length };
}

/** Which member's article to keep: most impressions, then best position. Pure. */
export function pickKeeper(members: readonly OverlapMember[]): Pick<OverlapCluster, "keeperKeywordId" | "keeperBasis" | "recommendation"> {
  const published = members.filter((m) => m.article?.publishedUrl);
  if (published.length === 0) {
    return {
      keeperKeywordId: null,
      keeperBasis: "nothing_published",
      recommendation: "None of these is published yet: write one of them, not all.",
    };
  }
  if (published.length === 1) {
    return {
      keeperKeywordId: published[0].keywordId,
      keeperBasis: "only_published",
      recommendation: `Keep "${published[0].keyword}": it is the only one published. The others would compete with it.`,
    };
  }
  const measured = published.filter((m) => (m.searchConsole?.days ?? 0) > 0);
  if (measured.length === 0) {
    return {
      keeperKeywordId: null,
      keeperBasis: "not_measured",
      recommendation: "Search Console has measured none of these articles yet, so nothing says which one to keep.",
    };
  }
  const ranked = [...measured].sort((a, b) => {
    const byImpressions = (b.searchConsole?.impressions ?? 0) - (a.searchConsole?.impressions ?? 0);
    if (byImpressions !== 0) return byImpressions;
    // A measured position beats an unmeasured one; lower is better.
    const pa = a.searchConsole?.position ?? Number.POSITIVE_INFINITY;
    const pb = b.searchConsole?.position ?? Number.POSITIVE_INFINITY;
    return pa - pb;
  });
  const [best, second] = ranked;
  const tied = second !== undefined && (second.searchConsole?.impressions ?? 0) === (best.searchConsole?.impressions ?? 0);
  const impressions = best.searchConsole?.impressions ?? 0;
  const position = best.searchConsole?.position;
  return {
    keeperKeywordId: best.keywordId,
    keeperBasis: tied ? "best_position" : "most_impressions",
    recommendation: tied
      ? `Keep "${best.keyword}": the same impressions as the next one, at a better average position${position !== null && position !== undefined ? ` (${formatPosition(position)})` : ""}.`
      : `Keep "${best.keyword}": the most Search Console impressions of the cluster (${impressions}).`,
  };
}

export type OverlappingTopicsRead = { ok: true; clusters: OverlapCluster[] } | { ok: false; error: unknown };

/**
 * How many clusters `loadOverlappingTopics` would report, from topics already
 * read: the Content screen's notice says how many, and its link shows them.
 */
export function countOverlapClusters(topics: SiteTopics): number {
  return clusterDuplicates(topics.keywords.map(keywordEntry)).length;
}

/**
 * The clusters of overlapping keywords the site already has, each member
 * with its article and what Search Console counted for it, and the member
 * to keep. Clusters with a published article come first, then by size.
 */
export async function loadOverlappingTopics(supabase: SupabaseClient, businessId: string): Promise<OverlappingTopicsRead> {
  const topics = await loadSiteTopics(supabase, businessId, { serp: true });
  if (!topics.ok) return topics;

  const keywordById = new Map(topics.keywords.map((k) => [k.id, k]));
  const articleById = new Map(topics.articles.map((a) => [a.id, a]));
  const found = clusterDuplicates(topics.keywords.map(keywordEntry));
  if (found.length === 0) return { ok: true, clusters: [] };

  const memberKeywords = found.map((cluster) =>
    cluster.members.flatMap((entry) => {
      const keyword = keywordById.get(entry.id.slice("keyword:".length));
      return keyword ? [keyword] : [];
    })
  );
  const articleIds = [
    ...new Set(memberKeywords.flat().flatMap((k) => (k.articleId && articleById.has(k.articleId) ? [k.articleId] : []))),
  ];

  const metricsByArticle = new Map<string, Array<{ position: number | null; impressions: number | null; clicks: number | null }>>();
  if (articleIds.length > 0) {
    const { data, error } = await supabase
      .from("content_metrics")
      .select("article_id, captured_on, position, impressions, clicks, source")
      .in("article_id", articleIds)
      .eq("source", "search_console")
      .order("captured_on", { ascending: false })
      .limit(METRIC_ROWS_READ);
    if (error) return { ok: false, error };
    const num = (value: unknown): number | null => (value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value));
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const articleId = str(row.article_id);
      if (!articleId) continue;
      const list = metricsByArticle.get(articleId) ?? [];
      list.push({ position: num(row.position), impressions: num(row.impressions), clicks: num(row.clicks) });
      metricsByArticle.set(articleId, list);
    }
  }

  const clusters = found.map((cluster, i): OverlapCluster => {
    const members = memberKeywords[i].map((keyword): OverlapMember => {
      const article = keyword.articleId ? (articleById.get(keyword.articleId) ?? null) : null;
      return {
        keywordId: keyword.id,
        keyword: keyword.keyword,
        status: keyword.status,
        article: article
          ? { id: article.id, status: article.status, title: article.title, publishedUrl: article.publishedUrl, scheduledDate: article.scheduledDate }
          : null,
        searchConsole: article ? totalsOf(metricsByArticle.get(article.id) ?? []) : null,
      };
    });
    return { members, reasons: cluster.reasons, ...pickKeeper(members) };
  });

  const publishedIn = (cluster: OverlapCluster) => cluster.members.filter((m) => m.article?.publishedUrl).length;
  clusters.sort((a, b) => publishedIn(b) - publishedIn(a) || b.members.length - a.members.length);
  return { ok: true, clusters };
}
