import type { SupabaseClient } from "@supabase/supabase-js";
import { questionIdeas, type QuestionIdea, type QuestionThread } from "./questions";

/**
 * A site's keyword pool as the Keywords screen reads it
 * (GET /api/keywords/get) and `list_keywords` / `recommend_keywords` read
 * it: newest first, optionally narrowed by a search and a status, each
 * keyword with the link of its live article. Through the caller's client
 * (RLS, or the owner-scoped service role), filtered by `business_id`.
 */

/** A pool row as stored, plus where its article went live. */
export type KeywordRow = Record<string, unknown> & {
  article_id: string | null;
  published_url: string | null;
};

export interface KeywordQuery {
  /** Case-insensitive part of the keyword. */
  search?: string;
  status?: string;
}

export type KeywordsRead = { ok: true; keywords: KeywordRow[] } | { ok: false; error: unknown };

export async function loadKeywords(
  supabase: SupabaseClient,
  businessId: string,
  { search = "", status = "" }: KeywordQuery = {}
): Promise<KeywordsRead> {
  let query = supabase
    .from("keywords")
    .select("*")
    .eq("business_id", businessId)
    .order("created_at", { ascending: false });

  if (search) {
    query = query.ilike("keyword", `%${search}%`);
  }
  if (status) {
    query = query.eq("status", status);
  }

  const { data, error } = await query;
  if (error) return { ok: false, error };

  // Where a keyword's article went live, for "View article". One batched
  // read for the whole list, scoped to the same site, never one per row.
  const rows = (data || []) as Array<{ article_id: string | null } & Record<string, unknown>>;
  const articleIds = [...new Set(rows.map((row) => row.article_id).filter((id): id is string => Boolean(id)))];
  const publishedUrlById = new Map<string, string>();
  if (articleIds.length > 0) {
    const { data: articles, error: articlesError } = await supabase
      .from("articles")
      .select("id, published_url")
      .eq("business_id", businessId)
      .in("id", articleIds);
    if (articlesError) {
      // The list is still right without the links: say nothing rather than fail.
      console.error("Error fetching published URLs for keywords:", articlesError);
    }
    for (const article of articles ?? []) {
      if (typeof article.published_url === "string" && article.published_url) {
        publishedUrlById.set(article.id as string, article.published_url);
      }
    }
  }

  return {
    ok: true,
    keywords: rows.map((row) => ({
      ...row,
      published_url: row.article_id ? (publishedUrlById.get(row.article_id) ?? null) : null,
    })),
  };
}

/**
 * How many of the site's discovered threads the question ideas are drawn
 * from: the most recently found ones. A bound on one read, not a sample of
 * anything measured.
 */
export const QUESTION_THREADS_READ = 1000;

export type QuestionIdeasRead = { ok: true; questions: QuestionIdea[] } | { ok: false; error: unknown };

/**
 * "Questions people ask" (lib/keywords/questions.ts) for one site, as the
 * Keywords screen (GET /api/keywords/questions) and `list_question_ideas`
 * read it: three reads of the site's own rows (its discovered threads, its
 * keywords, its articles' titles) and the pure rule over them. No model is
 * asked and nothing is fetched from outside: free.
 */
export async function loadQuestionIdeas(
  supabase: SupabaseClient,
  businessId: string,
  { limit }: { limit?: number } = {}
): Promise<QuestionIdeasRead> {
  const [threads, keywords, articles] = await Promise.all([
    supabase
      .from("placement_targets")
      .select("url, title, surface, kind, community, status, qualified_by, qualify_score, intent, posted_at, created_at")
      .eq("business_id", businessId)
      // Finished pieces are never questions (lib/keywords/questions.ts
      // skips them too); leaving them out here lets the bound reach further.
      .not("kind", "in", "(article,repository,page)")
      .order("created_at", { ascending: false })
      .limit(QUESTION_THREADS_READ),
    supabase.from("keywords").select("keyword").eq("business_id", businessId),
    supabase.from("articles").select("id, title:canonical->>title").eq("business_id", businessId),
  ]);
  const failed = threads.error ?? keywords.error ?? articles.error;
  if (failed) return { ok: false, error: failed };

  const text = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
  return {
    ok: true,
    questions: questionIdeas({
      threads: (threads.data ?? []) as unknown as QuestionThread[],
      keywords: ((keywords.data ?? []) as Array<{ keyword?: unknown }>).map((k) => k.keyword).filter(text),
      articleTitles: ((articles.data ?? []) as Array<{ title?: unknown }>).map((a) => a.title).filter(text),
      limit,
    }),
  };
}
