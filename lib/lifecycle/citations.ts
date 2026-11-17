import type { SupabaseClient } from "@supabase/supabase-js";
import { CitationSource, domainOf } from "@/lib/providers/citations/types";

/**
 * Citation measurement — the AEO half of the lifecycle loop.
 *
 * Rank answers "where does this article sit on Google". This answers "does an
 * answer engine cite us when someone asks the question the article answers".
 * Same shape as rank.ts on purpose: finding the citation is pure code, storing
 * it is one function, and what the rate MEANS over time is read from the
 * series rather than decided at write time.
 *
 * The limit is structural and must never be smoothed over in a customer-facing
 * number: this is a SAMPLED metric. We ask a handful of questions, on a
 * schedule, of engines whose answers are not deterministic. A rising rate is
 * evidence; a single probe is close to noise.
 */

export interface CitationMatch {
  /** True when the cited URL is the article itself, not just its domain. */
  exact: boolean;
  source: CitationSource;
}

/**
 * Whether the engine cited us, and how precisely.
 *
 * Exact URL first, then domain, exactly like rank matching: a customer's site
 * being cited with a different page still means the engine considers that site
 * an authority on the topic, which is the thing being measured. The difference
 * is recorded rather than flattened, because "our article" and "our site" are
 * two different wins.
 */
export function findCitation(
  sources: CitationSource[],
  publishedUrl: string
): CitationMatch | null {
  const target = publishedUrl.trim();
  if (!target) return null;

  const normalize = (url: string) => url.replace(/\/+$/, "").toLowerCase();
  const exact = sources.find((s) => normalize(s.url) === normalize(target));
  if (exact) return { exact: true, source: exact };

  const targetDomain = domainOf(target);
  if (!targetDomain) return null;
  const sameDomain = sources.find((s) => s.domain === targetDomain);

  return sameDomain ? { exact: false, source: sameDomain } : null;
}

/**
 * Records one probe.
 *
 * A negative result is written, not skipped. "We asked and were not cited" is
 * the measurement; a missing row would read as "we never asked", and the two
 * would be indistinguishable a month later when the rate is computed. This is
 * the same rule that stores a null rank position.
 */
export async function recordCitationProbe(params: {
  supabase: SupabaseClient;
  userId: string;
  businessId?: string | null;
  articleId: string;
  engine: string;
  query: string;
  match: CitationMatch | null;
  /** The engine's answer, trimmed to a readable excerpt when cited. */
  answer?: string;
  checkedOn?: string;
}): Promise<void> {
  const checkedOn = params.checkedOn ?? new Date().toISOString().slice(0, 10);

  const { error } = await params.supabase.from("ai_citations").upsert(
    {
      user_id: params.userId,
      business_id: params.businessId ?? null,
      article_id: params.articleId,
      engine: params.engine,
      query: params.query,
      checked_on: checkedOn,
      cited: params.match !== null,
      exact: params.match?.exact ?? false,
      source_url: params.match?.source.url ?? null,
      snippet: params.match ? (params.answer ?? "").slice(0, 500) || null : null,
    },
    { onConflict: "article_id,engine,query,checked_on" }
  );

  if (error) throw new Error(`citation probe upsert failed: ${error.message}`);
}

export interface CitationPoint {
  checkedOn: string;
  engine: string;
  cited: boolean;
}

/** The article's probe history, oldest first. */
export async function loadCitationHistory(params: {
  supabase: SupabaseClient;
  articleId: string;
  limit?: number;
}): Promise<CitationPoint[]> {
  const { data } = await params.supabase
    .from("ai_citations")
    .select("checked_on, engine, cited")
    .eq("article_id", params.articleId)
    .order("checked_on", { ascending: true })
    .limit(params.limit ?? 120);

  return (data ?? []).map((row) => ({
    checkedOn: row.checked_on as string,
    engine: row.engine as string,
    cited: Boolean(row.cited),
  }));
}

/**
 * Share of probes that found a citation, 0 to 1, or null when nothing was
 * measured. Null is deliberate: an empty series must not render as 0%, which
 * would read as "we are never cited" instead of "we have not looked yet".
 *
 * Rates are computed per engine when an engine is given, because engines are
 * not comparable to each other and averaging them produces a number that
 * describes nothing.
 */
export function citationRate(points: CitationPoint[], engine?: string): number | null {
  const scope = engine ? points.filter((p) => p.engine === engine) : points;
  if (scope.length === 0) return null;
  return scope.filter((p) => p.cited).length / scope.length;
}
