import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createAdminClient } from "@/lib/supabase/admin";
import { detectDecay } from "@/lib/lifecycle/decay";
import { findOwnPosition, loadRankHistory, recordRankMeasurement } from "@/lib/lifecycle/rank";
import { ensureSerpSnapshot } from "@/lib/intelligence/serp";
import { enqueueJob, hasActiveJob } from "@/lib/jobs/queue";
import { REFRESH_ARTICLE } from "@/lib/jobs/workflows/refresh-article";
import { getSerpProvider } from "@/lib/providers/serp/registry";
import { isCronAuthorized } from "@/lib/cron-auth";
import { skipWhileLlmPaused } from "@/lib/llm-billing";
import { logOwnerSkip, skipSummary, spendingOwners, type OwnerSkipReason } from "@/lib/limits/owners";

/**
 * The content lifecycle sweep.
 *
 * Two jobs, in order: MEASURE where every published article sits today, then
 * decide which ones have decayed enough to be worth rewriting. Measuring is
 * the part that must happen every week without fail — a rank history cannot be
 * reconstructed after the fact, and it is what makes every later refresh
 * decision evidence-based rather than a guess.
 *
 * Refreshing itself is only enqueued here; the worker does the work.
 *
 * Both halves spend (a SERP lookup to measure, model calls to rewrite), so
 * only articles whose owner pays (`hasPaidAccess`) are swept. They are
 * picked from a wider pool after the lapsed owners' articles are left out,
 * so those cannot hold the oldest slots week after week; each owner left
 * out is logged once per run.
 */

export const maxDuration = 300;

/** Bounded per run: the sweep is weekly, not a race to finish the backlog. */
const MAX_ARTICLES = 40;

/** Read before leaving out the owners who do not pay, then cut to MAX_ARTICLES. */
const CANDIDATE_POOL = 200;

async function run(request: NextRequest) {
  if (!isCronAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();
  const serp = getSerpProvider();
  // Measuring is not model work and keeps its weekly history. Rewriting is:
  // while the model accounts cannot pay, decayed articles are counted but
  // no refresh job is enqueued.
  const llmPausedUntil = await skipWhileLlmPaused(supabase, "refresh-articles");

  const { data: pool, error } = await supabase
    .from("articles")
    .select(
      `id, user_id, business_id, keyword_id, published_url, last_refreshed_at, created_at,
       keywords!articles_keyword_id_fkey ( keyword )`
    )
    .eq("status", "published")
    .not("published_url", "is", null)
    .order("last_refreshed_at", { ascending: true, nullsFirst: true })
    .limit(CANDIDATE_POOL);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const owners = spendingOwners(supabase);
  const articles: NonNullable<typeof pool> = [];
  const unpaid = new Map<string, { reason: OwnerSkipReason; articles: number }>();
  for (const article of pool ?? []) {
    if (articles.length >= MAX_ARTICLES) break;
    const userId = article.user_id as string;
    const verdict = await owners.verdict(userId);
    if (verdict === true) {
      articles.push(article);
      continue;
    }
    const entry = unpaid.get(userId) ?? { reason: verdict, articles: 0 };
    entry.articles += 1;
    unpaid.set(userId, entry);
  }
  for (const [userId, entry] of unpaid) {
    logOwnerSkip("refresh-articles", { user_id: userId, reason: entry.reason, articles_seen: entry.articles });
  }

  let measured = 0;
  let enqueued = 0;
  let deferred = 0;
  let holding = 0;
  const notes: string[] = [];

  for (const article of articles) {
    const articleId = article.id as string;
    const userId = article.user_id as string;
    const businessId = (article.business_id as string | null) ?? null;
    const keywordId = (article.keyword_id as string | null) ?? null;
    const kw = article.keywords as { keyword?: string } | { keyword?: string }[] | null;
    const keyword = (Array.isArray(kw) ? kw[0]?.keyword : kw?.keyword) ?? "";

    try {
      // ── Measure ──────────────────────────────────────────────────────────
      if (serp && keywordId && keyword) {
        // The article's own site, not "the user's site": on an account with
        // two, the wrong one would set the language and the domain to exclude
        // from competitor discovery.
        const { data: business } = businessId
          ? await supabase
              .from("businesses")
              .select("website_url, content_language")
              .eq("id", businessId)
              .maybeSingle()
          : { data: null };

        const snapshot = await ensureSerpSnapshot({
          supabase,
          userId,
          businessId,
          keywordId,
          keyword,
          language: (business?.content_language as string) ?? "en",
          provider: serp,
          ownWebsiteUrl: business?.website_url ?? undefined,
        });

        const found = findOwnPosition(
          snapshot.data.results,
          article.published_url as string
        );
        await recordRankMeasurement({
          supabase,
          userId,
          businessId,
          articleId,
          keywordId,
          position: found?.position ?? null,
        });
        measured += 1;
      }

      // ── Decide ───────────────────────────────────────────────────────────
      const { data: firstPublish } = await supabase
        .from("article_events")
        .select("created_at")
        .eq("article_id", articleId)
        .eq("to_state", "published")
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();

      const verdict = detectDecay({
        points: await loadRankHistory({ supabase, articleId }),
        publishedAt:
          (firstPublish?.created_at as string | undefined) ??
          (article.created_at as string | null),
        lastRefreshedAt: (article.last_refreshed_at as string | null) ?? null,
        now: new Date(),
      });

      if (!verdict.decaying) {
        holding += 1;
        continue;
      }
      if (llmPausedUntil) {
        deferred += 1;
        continue;
      }
      if (await hasActiveJob(supabase, articleId, REFRESH_ARTICLE)) continue;

      await enqueueJob({
        supabase,
        userId,
        type: REFRESH_ARTICLE,
        articleId,
        input: { articleId, reason: verdict.reason, detail: verdict.detail },
      });
      enqueued += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      notes.push(`${articleId}: ${message}`);
      Sentry.captureException(err, {
        tags: { stage: "refresh_sweep" },
        extra: { article_id: articleId },
      });
    }
  }

  return NextResponse.json({
    scanned: articles.length,
    skippedUnpaid: skipSummary(unpaid, "unpaid"),
    skippedSpendCap: skipSummary(unpaid, "spend"),
    measured,
    enqueued,
    holding,
    ...(llmPausedUntil ? { deferred, llmPausedUntil: llmPausedUntil.toISOString() } : {}),
    rankTracking: serp ? serp.name : "disabled (no SERP provider configured)",
    notes: notes.slice(0, 10),
  });
}

export async function GET(request: NextRequest) {
  return run(request);
}

export async function POST(request: NextRequest) {
  return run(request);
}
