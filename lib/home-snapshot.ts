import type { SupabaseClient } from "@supabase/supabase-js";
import { EMPTY_ONBOARDING_STATUS } from "@/lib/onboarding";
import { ONBOARDING_BUSINESS_COLUMNS, countOnboarding, onboardingFrom } from "@/lib/onboarding-status";
import {
  citationRatesByEngine,
  describeOperatingLoop,
  emptyOperatingFacts,
  type EngineCitationRate,
  type OperatingFacts,
  type OperatingLoop,
} from "@/lib/domain/operating-loop";
import type { TargetStatus } from "@/lib/placements/workflow";
import { isArticleState, type ArticleState } from "@/lib/domain/lifecycle";
import { summarizeTotals } from "@/lib/lifecycle/results";
import { articleResults, loadSearchConsoleStatus } from "@/lib/lifecycle/load-results";

/**
 * The Overview: the operating loop, the next action, and enough of the
 * calendar and keyword pool to show what is actually in motion, without
 * pulling article bodies. GET /api/home answers it and `get_home` reads the
 * same function.
 *
 * The measurements come from lib/lifecycle/load-results.ts, the checklist
 * from lib/onboarding-status.ts, the story from lib/domain/operating-loop.ts:
 * nothing here computes a number the Results screen or the checklist
 * computes differently.
 */

/** Replies drafted or held by the audit: written, waiting for the person. */
const REPLIES_WAITING: TargetStatus[] = ["drafted", "needs_review"];
const REPLY_POSTED: TargetStatus = "published_manually";

type JoinedKeyword = { keyword?: string } | { keyword?: string }[] | null;

function keywordText(joined: JoinedKeyword): string {
  const row = Array.isArray(joined) ? joined[0] : joined;
  return row?.keyword ?? "";
}

export interface HomeSnapshot {
  business: { name: string | null; website_url: string | null; niche: string | null };
  loop: OperatingLoop;
  upcoming: Array<{ id: string; keyword: string; scheduledDate: string; status: string }>;
  unusedKeywords: Array<{ id: string; keyword: string; searchVolume: number | null; opportunity: string | null }>;
}

/** The Overview of an account with no site yet. */
export function emptyHomeSnapshot(): HomeSnapshot {
  return {
    business: { name: null, website_url: null, niche: null },
    loop: describeOperatingLoop(EMPTY_ONBOARDING_STATUS, emptyOperatingFacts()),
    upcoming: [],
    unusedKeywords: [],
  };
}

export type HomeRead = { ok: true; snapshot: HomeSnapshot } | { ok: false; error: string };

/**
 * Replies posted since `since` that are still up: one marked as removed from
 * the site (`removed_at`, lib/placements/removed.ts) is left out, since
 * nobody can read it. The count is not shown beside, the Replies page has
 * it per surface. On a database without the column, every posted reply
 * counts, which is what that database knows.
 */
async function countRepliesPosted(
  supabase: SupabaseClient,
  businessId: string,
  since: string
): Promise<{ count: number | null; error: unknown }> {
  const posted = () =>
    supabase
      .from("placement_targets")
      .select("id", { count: "exact", head: true })
      .eq("business_id", businessId)
      .eq("status", REPLY_POSTED)
      .gte("published_at", since);
  const live = await posted().is("removed_at", null);
  return live.error ? await posted() : live;
}

/** The Overview of the site `businessId`. Refused only when the calendar or the pool cannot be read. */
export async function loadHomeSnapshot(supabase: SupabaseClient, businessId: string, now = new Date()): Promise<HomeRead> {
  const today = now.toISOString().slice(0, 10);
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();

  const [business, articles, keywords, counts, searchConsoleStatus, repliesWaiting, repliesPosted] = await Promise.all([
    supabase
      .from("businesses")
      .select(`name, website_url, niche, ${ONBOARDING_BUSINESS_COLUMNS}`)
      .eq("id", businessId)
      .maybeSingle(),
    supabase
      .from("articles")
      .select(
        `id, status, scheduled_date, keyword_id,
         keywords!articles_keyword_id_fkey ( keyword )`
      )
      .eq("business_id", businessId)
      .order("scheduled_date", { ascending: true }),
    supabase
      .from("keywords")
      .select("id, keyword, search_volume, opportunity, is_starred, article_id")
      .eq("business_id", businessId)
      .order("created_at", { ascending: false }),
    countOnboarding(supabase, businessId),
    loadSearchConsoleStatus(supabase, businessId),
    // Two head counts, no rows: the Overview only says how many replies
    // wait for the person and how many went out in the last 7 days.
    supabase
      .from("placement_targets")
      .select("id", { count: "exact", head: true })
      .eq("business_id", businessId)
      .in("status", REPLIES_WAITING),
    countRepliesPosted(supabase, businessId, weekAgo),
  ]);

  if (articles.error) return { ok: false, error: articles.error.message };
  if (keywords.error) return { ok: false, error: keywords.error.message };

  const byStatus: Record<ArticleState, number> = {
    queued: 0,
    generating: 0,
    generated: 0,
    needs_review: 0,
    failed: 0,
    published: 0,
  };
  const publishedIds: string[] = [];

  for (const row of articles.data ?? []) {
    if (!isArticleState(row.status)) continue;
    byStatus[row.status] += 1;
    if (row.status === "published") publishedIds.push(row.id as string);
  }

  const unused = (keywords.data ?? []).filter((k) => !k.article_id);
  const unusedKeywords = [...unused]
    .sort((a, b) => Number(b.is_starred) - Number(a.is_starred))
    .slice(0, 5)
    .map((k) => ({
      id: k.id as string,
      keyword: k.keyword as string,
      searchVolume: (k.search_volume as number | null) ?? null,
      opportunity: (k.opportunity as string | null) ?? null,
    }));

  const upcoming = (articles.data ?? [])
    .filter((row) => String(row.scheduled_date ?? "") >= today)
    .slice(0, 7)
    .map((row) => ({
      id: row.id as string,
      keyword: keywordText(row.keywords as JoinedKeyword),
      scheduledDate: String(row.scheduled_date ?? ""),
      status: String(row.status ?? ""),
    }));

  // The same aggregation as the Results screen; only rank and citations are read here.
  const { results } = await articleResults(
    supabase,
    publishedIds.map((id) => ({ id, keyword: "", publishedUrl: null }))
  );
  const totals = summarizeTotals(results);
  // Per engine, never the pooled rate in totals: engines disagree.
  const citationsByEngine: EngineCitationRate[] = citationRatesByEngine(results);

  const onboarding = onboardingFrom(business.data, counts);

  const facts: OperatingFacts = {
    keywordCount: keywords.data?.length ?? 0,
    unusedKeywordCount: unused.length,
    queuedCount: byStatus.queued,
    generatingCount: byStatus.generating,
    generatedCount: byStatus.generated,
    needsReviewCount: byStatus.needs_review,
    failedCount: byStatus.failed,
    publishedCount: byStatus.published,
    hasIntegration: counts.integrationCount > 0,
    autopilotEnabled: onboarding.hasAutomation,
    citationsByEngine,
    rankMeasured: totals.rankMeasured,
    ranking: totals.ranking,
    searchConsole: searchConsoleStatus.status,
    // A failed count is unknown, not zero.
    repliesWaiting: repliesWaiting.error ? null : (repliesWaiting.count ?? 0),
    repliesPostedLast7Days: repliesPosted.error ? null : (repliesPosted.count ?? 0),
  };

  return {
    ok: true,
    snapshot: {
      business: {
        name: (business.data?.name as string | null) ?? null,
        website_url: (business.data?.website_url as string | null) ?? null,
        niche: (business.data?.niche as string | null) ?? null,
      },
      loop: describeOperatingLoop(onboarding, facts),
      upcoming,
      unusedKeywords,
    },
  };
}
