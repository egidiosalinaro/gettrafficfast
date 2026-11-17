import type { SupabaseClient } from "@supabase/supabase-js";
import { canStartProduction, isArticleState } from "@/lib/domain/lifecycle";
import { enqueueJob, hasActiveJob } from "@/lib/jobs/queue";
import { PRODUCE_ARTICLE } from "@/lib/jobs/workflows/produce-article";
import { MANUAL_JOB_PRIORITY } from "@/lib/jobs/types";

/**
 * "Generate now" / "Regenerate" on one article: the decision and the
 * enqueue, shared by `POST /api/generate-now` (the calendar's button) and
 * the `generate_article` tool (lib/tools/articles-produce.ts). Running the
 * job is the caller's: the route runs it inline for 45 s, the tool for up
 * to its own budget; either way the worker tick finishes what they leave.
 *
 * Which statuses may start (or restart) production is `canStartProduction`
 * in the lifecycle: queued, failed, needs_review, generated, published. A
 * published article is rewritten; `published_url` stays so the next deliver
 * updates the existing post instead of opening a second one.
 *
 * The paywall is the caller's (the route's `requirePaidAccess`, the
 * runner's for a paid tool), and so is the site: `businessId` is the one the
 * caller picked from the user's own businesses, so an id from another of
 * their sites is not found.
 */

export const GENERATE_NOW_MAX_ATTEMPTS = 3;
/** A manual request goes to the front of the queue. */
export const GENERATE_NOW_PRIORITY = MANUAL_JOB_PRIORITY;

export type GenerateNowResult =
  | { ok: true; alreadyRunning: false; jobId: string }
  /** A production job for this article is queued or running: no second one. `jobId` is that job, when it can be read. */
  | { ok: true; alreadyRunning: true; jobId: string | null }
  | { ok: false; status: 404 | 409; code: "not_found" | "invalid_state"; error: string };

export async function requestArticleGeneration(params: {
  /** The caller's client: the person's RLS client, or an API key's owner-scoped one. */
  supabase: SupabaseClient;
  /** The service role: jobs are written by it; ownership is checked first, on `supabase`. */
  admin: SupabaseClient;
  userId: string;
  businessId: string;
  articleId: string;
}): Promise<GenerateNowResult> {
  const { supabase, admin, userId, businessId, articleId } = params;

  // Ownership on the caller's own client, scoped to the user AND the site.
  const { data: article } = await supabase
    .from("articles")
    .select("id, status, business_id")
    .eq("id", articleId)
    .eq("business_id", businessId)
    .eq("user_id", userId)
    .maybeSingle();

  if (!article) return { ok: false, status: 404, code: "not_found", error: "Article not found" };
  if (!isArticleState(article.status) || !canStartProduction(article.status)) {
    return { ok: false, status: 409, code: "invalid_state", error: "Article is not in a generatable state" };
  }

  if (await hasActiveJob(admin, articleId, PRODUCE_ARTICLE)) {
    return { ok: true, alreadyRunning: true, jobId: await activeProductionJob(admin, articleId) };
  }

  const jobId = await enqueueJob({
    supabase: admin,
    userId,
    businessId: (article.business_id as string | null) ?? null,
    type: PRODUCE_ARTICLE,
    input: { articleId },
    articleId,
    priority: GENERATE_NOW_PRIORITY,
    maxAttempts: GENERATE_NOW_MAX_ATTEMPTS,
  });
  return { ok: true, alreadyRunning: false, jobId };
}

/** The newest production job of the article still queued or running, or null. */
async function activeProductionJob(admin: SupabaseClient, articleId: string): Promise<string | null> {
  const { data } = await admin
    .from("jobs")
    .select("id")
    .eq("article_id", articleId)
    .eq("type", PRODUCE_ARTICLE)
    .in("status", ["pending", "running"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data?.id as string | undefined) ?? null;
}
