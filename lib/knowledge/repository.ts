import type { SupabaseClient } from "@supabase/supabase-js";
import type { KnowledgeExtractOutput } from "@/lib/agents/knowledge-extract";
import type { CanonicalArticle } from "@/lib/content/types";
import { slugify } from "@/lib/content/text";

/**
 * The knowledge graph's storage layer. Everything the platform knows about
 * entities, topics and links goes through here — agents return data, the
 * workflow orchestrates, this module is the only place that writes the graph.
 */

/** Dedup key for an entity: display form reduced to its comparable core. */
export function canonicalEntityName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}

export interface PersistExtractionParams {
  supabase: SupabaseClient;
  userId: string;
  /** The site whose graph this is. Two sites never share entities or topics. */
  businessId?: string | null;
  articleId: string;
  extraction: KnowledgeExtractOutput;
}

export interface PersistExtractionResult {
  entities: number;
  topics: number;
}

/**
 * Records what an article is about. Upserts are keyed on the natural keys
 * (user/type/canonical_name, user/slug), so re-running a job — or two articles
 * naming the same thing — converge on one graph node instead of duplicating it.
 */
export async function persistExtraction({
  supabase,
  userId,
  businessId = null,
  articleId,
  extraction,
}: PersistExtractionParams): Promise<PersistExtractionResult> {
  let entityCount = 0;
  let topicCount = 0;

  if (extraction.entities.length > 0) {
    const rows = extraction.entities.map((e) => ({
      user_id: userId,
      business_id: businessId,
      type: e.type,
      name: e.name,
      canonical_name: canonicalEntityName(e.name),
    }));
    const { data: entities, error } = await supabase
      .from("entities")
      .upsert(rows, { onConflict: "business_id,type,canonical_name" })
      .select("id, type, canonical_name");
    if (error) throw new Error(`entity upsert failed: ${error.message}`);

    const idFor = new Map(
      (entities ?? []).map((e) => [`${e.type}:${e.canonical_name}`, e.id as string])
    );
    const junction = extraction.entities.flatMap((e) => {
      const id = idFor.get(`${e.type}:${canonicalEntityName(e.name)}`);
      return id
        ? [{ article_id: articleId, entity_id: id, role: e.role, salience: e.salience }]
        : [];
    });
    if (junction.length > 0) {
      const { error: junctionError } = await supabase
        .from("article_entities")
        .upsert(junction, { onConflict: "article_id,entity_id" });
      if (junctionError) {
        throw new Error(`article_entities upsert failed: ${junctionError.message}`);
      }
      entityCount = junction.length;
    }
  }

  if (extraction.topics.length > 0) {
    const rows = extraction.topics.map((t) => ({
      user_id: userId,
      business_id: businessId,
      name: t.name,
      slug: slugify(t.name),
    }));
    const { data: topics, error } = await supabase
      .from("topics")
      .upsert(rows, { onConflict: "business_id,slug" })
      .select("id, slug");
    if (error) throw new Error(`topic upsert failed: ${error.message}`);

    const idFor = new Map((topics ?? []).map((t) => [t.slug as string, t.id as string]));
    const junction = extraction.topics.flatMap((t) => {
      const id = idFor.get(slugify(t.name));
      return id
        ? [{ article_id: articleId, topic_id: id, is_primary: t.isPrimary }]
        : [];
    });
    if (junction.length > 0) {
      const { error: junctionError } = await supabase
        .from("article_topics")
        .upsert(junction, { onConflict: "article_id,topic_id" });
      if (junctionError) {
        throw new Error(`article_topics upsert failed: ${junctionError.message}`);
      }
      topicCount = junction.length;
    }
  }

  return { entities: entityCount, topics: topicCount };
}

export interface RelatedArticle {
  articleId: string;
  title: string;
  keyword: string;
  excerpt: string;
  publishedUrl: string;
  /** Shared graph nodes with the source article — higher is closer. */
  score: number;
}

/**
 * Articles related to `articleId` through shared entities or topics —
 * restricted to articles that are LIVE (published_url set): an internal link
 * must point somewhere a reader can actually go.
 */
export async function findRelatedArticles(params: {
  supabase: SupabaseClient;
  userId: string;
  /** Candidates are restricted to this site: a link across two of the same
   *  account's businesses would send a reader to a different company. */
  businessId?: string | null;
  articleId: string;
  limit?: number;
}): Promise<RelatedArticle[]> {
  const { supabase, userId, articleId } = params;
  const businessId = params.businessId ?? null;
  const limit = params.limit ?? 5;

  const [{ data: myEntities }, { data: myTopics }] = await Promise.all([
    supabase.from("article_entities").select("entity_id").eq("article_id", articleId),
    supabase.from("article_topics").select("topic_id").eq("article_id", articleId),
  ]);
  const entityIds = (myEntities ?? []).map((r) => r.entity_id as string);
  const topicIds = (myTopics ?? []).map((r) => r.topic_id as string);
  if (entityIds.length === 0 && topicIds.length === 0) return [];

  type Row = {
    article_id: string;
    articles: {
      id: string;
      user_id: string;
      published_url: string | null;
      canonical: CanonicalArticle | null;
    } | null;
  };

  const scores = new Map<string, { row: Row["articles"]; score: number }>();
  const tally = (rows: Row[] | null) => {
    for (const row of rows ?? []) {
      const article = row.articles;
      if (!article?.published_url || !article.canonical) continue;
      const existing = scores.get(article.id);
      if (existing) existing.score += 1;
      else scores.set(article.id, { row: article, score: 1 });
    }
  };

  if (entityIds.length > 0) {
    const { data } = await supabase
      .from("article_entities")
      .select("article_id, articles!inner(id, user_id, business_id, published_url, canonical)")
      .in("entity_id", entityIds)
      .neq("article_id", articleId)
      .eq(businessId ? "articles.business_id" : "articles.user_id", businessId ?? userId);
    tally(data as unknown as Row[] | null);
  }
  if (topicIds.length > 0) {
    const { data } = await supabase
      .from("article_topics")
      .select("article_id, articles!inner(id, user_id, business_id, published_url, canonical)")
      .in("topic_id", topicIds)
      .neq("article_id", articleId)
      .eq(businessId ? "articles.business_id" : "articles.user_id", businessId ?? userId);
    tally(data as unknown as Row[] | null);
  }

  return Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ row, score }) => ({
      articleId: row!.id,
      title: row!.canonical!.title,
      keyword: row!.canonical!.keyword,
      excerpt: row!.canonical!.excerpt,
      publishedUrl: row!.published_url!,
      score,
    }));
}

/** How many of the site's live articles the Read next fallback reads. */
export const LIVE_ARTICLES_READ = 60;

/**
 * The site's other live articles (`published_url` set), latest scheduled
 * day first: what the Read next block falls back on when the graph
 * relates too few (lib/knowledge/read-next.ts). Title and keyword only,
 * read out of the canonical document, never its body.
 */
export async function listLiveArticles(params: {
  supabase: SupabaseClient;
  userId: string;
  businessId?: string | null;
  articleId: string;
  limit?: number;
}): Promise<Array<{ articleId: string; title: string; keyword: string; publishedUrl: string }>> {
  const businessId = params.businessId ?? null;
  const { data, error } = await params.supabase
    .from("articles")
    .select("id, published_url, title:canonical->>title, keyword:canonical->>keyword")
    .eq(businessId ? "business_id" : "user_id", businessId ?? params.userId)
    .neq("id", params.articleId)
    .not("published_url", "is", null)
    .order("scheduled_date", { ascending: false, nullsFirst: false })
    .limit(params.limit ?? LIVE_ARTICLES_READ);
  if (error) throw new Error(`live articles read failed: ${error.message}`);
  return ((data ?? []) as Array<{ id: string; published_url: string | null; title: string | null; keyword: string | null }>)
    .filter((row) => row.published_url && row.title)
    .map((row) => ({
      articleId: row.id,
      title: row.title as string,
      keyword: row.keyword ?? "",
      publishedUrl: row.published_url as string,
    }));
}

/**
 * Records links that were actually placed in the article body, so graph
 * queries (orphans, cannibalisation, link equity) never have to parse HTML.
 */
export async function recordAppliedLinks(params: {
  supabase: SupabaseClient;
  userId: string;
  businessId?: string | null;
  fromArticleId: string;
  links: Array<{ targetArticleId: string; anchor: string }>;
  /**
   * "applied" (the default): the link is in the body a reader sees.
   * "suggested": it is in the stored document but its delivery failed, so
   * nobody can follow it yet (the back-link pass, when the site refuses the
   * update).
   */
  status?: "applied" | "suggested";
}): Promise<void> {
  if (params.links.length === 0) return;
  const rows = params.links.map((l) => ({
    user_id: params.userId,
    business_id: params.businessId ?? null,
    from_article_id: params.fromArticleId,
    to_article_id: l.targetArticleId,
    anchor: l.anchor,
    status: params.status ?? "applied",
  }));
  const { error } = await params.supabase
    .from("article_links")
    .upsert(rows, { onConflict: "from_article_id,to_article_id,anchor" });
  if (error) throw new Error(`article_links upsert failed: ${error.message}`);
}
