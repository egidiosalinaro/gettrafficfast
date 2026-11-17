import type { SupabaseClient } from "@supabase/supabase-js";
import type { SerpData, SerpProvider, SerpResult } from "@/lib/providers/serp/types";
import { domainOf } from "@/lib/providers/serp/types";

/**
 * SERP intelligence — snapshots and competitor discovery.
 *
 * A snapshot is the evidence: what the engine showed for a keyword at a point
 * in time, stored verbatim inside the parsed shape. Competitors are derived
 * from that evidence by code (a domain either appears in the results or it
 * does not — no judgement involved); what the SERP *means* is the
 * serp-analysis agent's job, elsewhere.
 */

/**
 * Platforms that rank for everything and compete with no one in particular.
 * Appearing here is not evidence of being this business's competitor.
 * A detector list — it filters, it never rewrites anything.
 */
export const GENERIC_DOMAINS = new Set([
  "wikipedia.org",
  "youtube.com",
  "google.com",
  "amazon.com",
  "facebook.com",
  "instagram.com",
  "linkedin.com",
  "pinterest.com",
  "reddit.com",
  "quora.com",
  "tiktok.com",
  "twitter.com",
  "x.com",
  "medium.com",
  "apple.com",
  "play.google.com",
  "tripadvisor.com",
  "trustpilot.com",
]);

function matchesDomain(domain: string, base: string): boolean {
  return domain === base || domain.endsWith(`.${base}`);
}

export interface DiscoveredCompetitor {
  domain: string;
  /** Best (lowest) organic position the domain reached in this SERP. */
  bestPosition: number;
}

/**
 * The domains competing with this business in a SERP: everything ranking that
 * is neither the business itself nor a generic platform. Deduped, ordered by
 * best position.
 */
export function extractCompetitorDomains(
  results: SerpResult[],
  ownWebsiteUrl?: string
): DiscoveredCompetitor[] {
  const own = ownWebsiteUrl ? domainOf(ownWebsiteUrl) : "";
  const best = new Map<string, number>();

  for (const result of results) {
    const domain = result.domain;
    if (!domain) continue;
    if (own && matchesDomain(domain, own)) continue;
    if ([...GENERIC_DOMAINS].some((g) => matchesDomain(domain, g))) continue;
    const current = best.get(domain);
    if (current === undefined || result.position < current) {
      best.set(domain, result.position);
    }
  }

  return [...best.entries()]
    .map(([domain, bestPosition]) => ({ domain, bestPosition }))
    .sort((a, b) => a.bestPosition - b.bestPosition);
}

const SNAPSHOT_MAX_AGE_DAYS = 7;

export interface EnsureSnapshotParams {
  supabase: SupabaseClient;
  userId: string;
  /** The site this research is for: competitors are discovered per site. */
  businessId?: string | null;
  keywordId: string;
  keyword: string;
  language: string;
  provider: SerpProvider;
  /** The business's own site, excluded from competitor discovery. */
  ownWebsiteUrl?: string;
  maxAgeDays?: number;
  signal?: AbortSignal;
}

export interface EnsureSnapshotResult {
  snapshotId: string;
  data: SerpData;
  /** True when a recent snapshot was reused instead of a paid API call. */
  reused: boolean;
}

/**
 * Returns the SERP for a keyword, reusing a recent snapshot when one exists —
 * SERPs move on the scale of weeks, and every fetch is a paid call. A fresh
 * fetch records the snapshot and upserts the competitors it reveals.
 */
export async function ensureSerpSnapshot(
  params: EnsureSnapshotParams
): Promise<EnsureSnapshotResult> {
  const { supabase, userId, keywordId, keyword, language, provider } = params;
  const businessId = params.businessId ?? null;
  const maxAgeDays = params.maxAgeDays ?? SNAPSHOT_MAX_AGE_DAYS;

  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
  const { data: recent } = await supabase
    .from("serp_snapshots")
    .select("id, results")
    .eq("keyword_id", keywordId)
    .gte("captured_at", cutoff)
    .order("captured_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (recent?.results) {
    return { snapshotId: recent.id as string, data: recent.results as SerpData, reused: true };
  }

  const data = await provider.search({ keyword, language, signal: params.signal });

  const { data: inserted, error } = await supabase
    .from("serp_snapshots")
    .insert({
      user_id: userId,
      business_id: businessId,
      keyword_id: keywordId,
      provider: provider.name,
      results: data,
    })
    .select("id")
    .single();
  if (error) throw new Error(`serp snapshot insert failed: ${error.message}`);

  const competitors = extractCompetitorDomains(data.results, params.ownWebsiteUrl);
  if (competitors.length > 0) {
    const now = new Date().toISOString();
    const rows = competitors.map((c) => ({
      user_id: userId,
      business_id: businessId,
      domain: c.domain,
      name: c.domain,
      source: "serp",
      last_seen_at: now,
    }));
    const { error: competitorError } = await supabase
      .from("competitors")
      .upsert(rows, { onConflict: "business_id,domain" });
    if (competitorError) {
      // Discovery is a side benefit — losing it must not lose the research.
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "serp.competitor_upsert_failed",
          error: competitorError.message,
        })
      );
    }
  }

  return { snapshotId: inserted.id as string, data, reused: false };
}

/** Attaches the serp-analysis agent's reading to the snapshot it read. */
export async function storeSnapshotAnalysis(
  supabase: SupabaseClient,
  snapshotId: string,
  analysis: unknown
): Promise<void> {
  const { error } = await supabase
    .from("serp_snapshots")
    .update({ analysis })
    .eq("id", snapshotId);
  if (error) {
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "serp.analysis_store_failed",
        error: error.message,
      })
    );
  }
}
