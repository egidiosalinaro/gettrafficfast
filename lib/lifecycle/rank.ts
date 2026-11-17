import type { SupabaseClient } from "@supabase/supabase-js";
import { domainOf, SerpResult } from "@/lib/providers/serp/types";

/**
 * Rank measurement.
 *
 * Where an article sits in the SERP is a fact we can already read from the
 * snapshots Phase 4 records — no new external dependency, no OAuth. Finding
 * the position is pure code (a URL either appears or it does not); what a
 * falling position MEANS is decay detection's job, next door.
 */

/**
 * Position of a published article in a SERP, or null when it does not appear.
 *
 * Matching is by exact URL first, then by domain: a customer's site often
 * ranks with a different page for the same keyword, and that is still evidence
 * about the article's topic, so the best position their domain reaches counts.
 */
export function findOwnPosition(
  results: SerpResult[],
  publishedUrl: string
): { position: number; exact: boolean } | null {
  const target = publishedUrl.trim();
  if (!target) return null;

  const normalize = (url: string) => url.replace(/\/+$/, "").toLowerCase();
  const exact = results.find((r) => normalize(r.url) === normalize(target));
  if (exact) return { position: exact.position, exact: true };

  const targetDomain = domainOf(target);
  if (!targetDomain) return null;
  const sameDomain = results
    .filter((r) => r.domain === targetDomain)
    .sort((a, b) => a.position - b.position)[0];

  return sameDomain ? { position: sameDomain.position, exact: false } : null;
}

/**
 * Records today's measurement. A missing position is stored as null — "we
 * looked and it was not there" is data, and a gap in the series would read as
 * "we never looked".
 */
export async function recordRankMeasurement(params: {
  supabase: SupabaseClient;
  userId: string;
  businessId?: string | null;
  articleId: string;
  keywordId: string | null;
  position: number | null;
  capturedOn?: string;
}): Promise<void> {
  const capturedOn = params.capturedOn ?? new Date().toISOString().slice(0, 10);

  const { error } = await params.supabase.from("content_metrics").upsert(
    {
      user_id: params.userId,
      business_id: params.businessId ?? null,
      article_id: params.articleId,
      keyword_id: params.keywordId,
      captured_on: capturedOn,
      source: "serp",
      position: params.position,
    },
    { onConflict: "article_id,captured_on,source" }
  );

  if (error) throw new Error(`rank measurement upsert failed: ${error.message}`);
}

export interface RankPoint {
  capturedOn: string;
  position: number | null;
}

/** The article's measured rank history, oldest first. */
export async function loadRankHistory(params: {
  supabase: SupabaseClient;
  articleId: string;
  limit?: number;
}): Promise<RankPoint[]> {
  const { data } = await params.supabase
    .from("content_metrics")
    .select("captured_on, position")
    .eq("article_id", params.articleId)
    .order("captured_on", { ascending: true })
    .limit(params.limit ?? 60);

  return (data ?? []).map((row) => ({
    capturedOn: row.captured_on as string,
    position: row.position === null ? null : Number(row.position),
  }));
}
