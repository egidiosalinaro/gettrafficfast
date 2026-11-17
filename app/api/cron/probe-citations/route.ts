import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createAdminClient } from "@/lib/supabase/admin";
import { findCitation, recordCitationProbe } from "@/lib/lifecycle/citations";
import { getCitationProviders } from "@/lib/providers/citations/registry";
import { isCronAuthorized } from "@/lib/cron-auth";
import { logOwnerSkip, skipSummary, spendingOwners, type OwnerSkipReason } from "@/lib/limits/owners";

/**
 * The citation sweep.
 *
 * Asks every configured answer engine the question each published article is
 * meant to answer, and records whether the customer's site was cited. This is
 * the only measurement behind the product's AEO claim, so it must run
 * regularly and it must record negatives — a rate is meaningless without them.
 *
 * It measures and nothing else. Unlike the refresh sweep it enqueues no work:
 * what a falling citation rate should trigger is a decision for a later slice,
 * and collecting the history is the part that cannot be done retroactively.
 *
 * Only articles whose owner pays (`hasPaidAccess`) are probed: they are
 * filtered out of the pool before the rotation picks, so a lapsed account's
 * catalogue neither costs probes nor takes paying accounts' slots. Each
 * owner left out is logged once per run.
 */

export const maxDuration = 300;

/**
 * Every probe is a paid call, multiplied by the number of engines. The sweep
 * is a rotation, not a race to cover the whole catalogue in one run.
 */
const MAX_ARTICLES = 25;

/** Pool considered before picking the least recently probed. */
const CANDIDATE_POOL = 200;

/** An article probed within this window is skipped; matches the weekly cron. */
const PROBE_INTERVAL_DAYS = 7;

async function run(request: NextRequest) {
  if (!isCronAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const providers = getCitationProviders();
  if (providers.length === 0) {
    return NextResponse.json({
      probed: 0,
      engines: "disabled (no citation provider configured)",
    });
  }

  const supabase = createAdminClient();

  const { data: articles, error } = await supabase
    .from("articles")
    .select(
      `id, user_id, business_id, published_url,
       keywords!articles_keyword_id_fkey ( keyword )`
    )
    .eq("status", "published")
    .not("published_url", "is", null)
    .limit(CANDIDATE_POOL);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const candidates = (articles ?? [])
    .map((article) => {
      const kw = article.keywords as { keyword?: string } | { keyword?: string }[] | null;
      return {
        id: article.id as string,
        userId: article.user_id as string,
        businessId: (article.business_id as string | null) ?? null,
        publishedUrl: article.published_url as string,
        keyword: (Array.isArray(kw) ? kw[0]?.keyword : kw?.keyword) ?? "",
      };
    })
    .filter((article) => article.keyword.length > 0);

  // Every probe is paid: only owners who pay, and are under their daily AI
  // spend limit, are probed.
  const owners = spendingOwners(supabase);
  const paidCandidates: typeof candidates = [];
  const unpaid = new Map<string, { reason: OwnerSkipReason; articles: number }>();
  for (const candidate of candidates) {
    const verdict = await owners.verdict(candidate.userId);
    if (verdict === true) {
      paidCandidates.push(candidate);
      continue;
    }
    const entry = unpaid.get(candidate.userId) ?? { reason: verdict, articles: 0 };
    entry.articles += 1;
    unpaid.set(candidate.userId, entry);
  }
  for (const [userId, entry] of unpaid) {
    logOwnerSkip("probe-citations", { user_id: userId, reason: entry.reason, articles_seen: entry.articles });
  }

  // Skip what was already asked this week: the rotation is what keeps the
  // catalogue covered without probing the same first articles every run.
  const since = new Date(Date.now() - PROBE_INTERVAL_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const { data: recent } = await supabase
    .from("ai_citations")
    .select("article_id")
    .in(
      "article_id",
      paidCandidates.map((c) => c.id)
    )
    .gte("checked_on", since);

  const recentlyProbed = new Set((recent ?? []).map((row) => row.article_id as string));
  const due = paidCandidates.filter((c) => !recentlyProbed.has(c.id)).slice(0, MAX_ARTICLES);

  // Language is a property of the site, so the cache is keyed by site: two
  // businesses on one account can publish in two languages, and probing in
  // the wrong one asks a question nobody would ask.
  const languages = new Map<string, string>();
  const resolveLanguage = async (businessId: string | null): Promise<string> => {
    if (!businessId) return "en";
    const cached = languages.get(businessId);
    if (cached) return cached;
    const { data } = await supabase
      .from("businesses")
      .select("content_language")
      .eq("id", businessId)
      .maybeSingle();
    const language = (data?.content_language as string) ?? "en";
    languages.set(businessId, language);
    return language;
  };

  let probed = 0;
  let cited = 0;
  const notes: string[] = [];

  for (const article of due) {
    const language = await resolveLanguage(article.businessId);

    for (const provider of providers) {
      try {
        const answer = await provider.probe({ query: article.keyword, language });
        const match = findCitation(answer.sources, article.publishedUrl);

        await recordCitationProbe({
          supabase,
          userId: article.userId,
          businessId: article.businessId,
          articleId: article.id,
          engine: answer.engine,
          query: article.keyword,
          match,
          answer: answer.answer,
        });

        probed += 1;
        if (match) cited += 1;
      } catch (err) {
        // One engine failing must not cost the other engines' measurements,
        // nor the rest of the sweep.
        const message = err instanceof Error ? err.message : String(err);
        notes.push(`${article.id} via ${provider.name}: ${message}`);
        Sentry.captureException(err, {
          tags: { stage: "citation_sweep", engine: provider.name },
          extra: { article_id: article.id },
        });
      }
    }
  }

  return NextResponse.json({
    candidates: candidates.length,
    skippedUnpaid: skipSummary(unpaid, "unpaid"),
    skippedSpendCap: skipSummary(unpaid, "spend"),
    due: due.length,
    probed,
    cited,
    engines: providers.map((p) => p.name),
    notes: notes.slice(0, 10),
  });
}

export async function GET(request: NextRequest) {
  return run(request);
}

export async function POST(request: NextRequest) {
  return run(request);
}
