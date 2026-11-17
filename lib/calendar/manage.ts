import type { SupabaseClient } from "@supabase/supabase-js";
import { loadSiteTopics, splitSchedulable, type ScheduleRefusal } from "@/lib/keywords/overlap";
import { nextFreeDays, utcDay } from "./schedule";

/**
 * The calendar's writes, one function each, called by its routes
 * (`/api/calendar/*`) and by the calendar tools
 * (lib/tools/write-calendar.ts), so the screen and the API cannot drift.
 *
 * A change by id is scoped to the id, the site and the user: an article of
 * another of the user's sites (a stale tab, a key for another site) is not
 * found. Whether the caller may schedule at all (the paywall) is the
 * caller's check, made before any of these runs.
 */

export type CalendarFailure = { ok: false; status: 400 | 404 | 409 | 500; error: string };

/** At most this many keywords go on the calendar in one call. */
export const MAX_BULK_SCHEDULE = 200;

export interface ScheduledArticle {
  articleId: string;
  keywordId: string;
  scheduledDate: string;
}

export type ScheduleKeywordsResult =
  | {
      ok: true;
      added: number;
      articles: ScheduledArticle[];
      message: string;
      /**
       * Keywords left off the calendar because a near-duplicate is already
       * scheduled, being written or published, or was scheduled earlier in
       * this same call (lib/keywords/duplicates.ts), each with why.
       */
      overlapping: ScheduleRefusal[];
    }
  | CalendarFailure;

/**
 * Why a keyword may not go on the calendar for overlapping a topic the site
 * has already committed to, or null when it may. The single "Add to
 * calendar" asks this; the bulk add applies the same rule to a list.
 */
export async function scheduleOverlap(
  supabase: SupabaseClient,
  businessId: string,
  keywordId: string
): Promise<ScheduleRefusal | null> {
  const topics = await loadSiteTopics(supabase, businessId, { serp: true });
  if (!topics.ok) throw new Error("Could not read the site's topics");
  return splitSchedulable(topics, [{ id: keywordId }]).refused[0] ?? null;
}

/**
 * Puts the site's keywords among `keywordIds` that are not on the calendar
 * yet on the site's first free days after today, one per day, in the order
 * the ids were given (lib/calendar/schedule.ts), and links each keyword to its
 * article. Ids of another site, and keywords already scheduled, are skipped.
 *
 * A keyword whose near-duplicate is already scheduled, being written or
 * published is never scheduled: it is left in the pool and reported in
 * `overlapping` with the topic it overlaps. Of two duplicates in one call
 * the first, in the order the ids were given, is scheduled.
 */
export async function scheduleKeywords(input: {
  supabase: SupabaseClient;
  userId: string;
  businessId: string;
  keywordIds: string[];
  now?: Date;
}): Promise<ScheduleKeywordsResult> {
  const { supabase, userId, businessId } = input;
  const ids = [...new Set(input.keywordIds)];

  const { data: keywords, error: kwError } = await supabase
    .from("keywords")
    .select("id")
    .eq("business_id", businessId)
    .eq("user_id", userId)
    .is("article_id", null)
    .in("id", ids);
  if (kwError) {
    console.error("Error loading keywords for bulk add:", kwError);
    return { ok: false, status: 500, error: "Failed to load keywords" };
  }

  const eligible = new Set((keywords ?? []).map((kw) => kw.id as string));
  if (eligible.size === 0) {
    return {
      ok: true,
      added: 0,
      articles: [],
      message: "No eligible keywords to add. They may already be scheduled.",
      overlapping: [],
    };
  }

  // Never two articles on one topic: a keyword that overlaps one already
  // scheduled, being written or published stays in the pool. In the order
  // the caller gave, so the first of two duplicates is the one scheduled.
  const topics = await loadSiteTopics(supabase, businessId, { serp: true });
  if (!topics.ok) {
    console.error("Error reading the site's topics:", topics.error);
    return { ok: false, status: 500, error: "Failed to load keywords" };
  }
  const { schedulable: addable, refused: overlapping } = splitSchedulable(
    topics,
    ids.filter((id) => eligible.has(id)).map((id) => ({ id }))
  );
  const overlapNote =
    overlapping.length > 0
      ? ` ${overlapping.length} ${overlapping.length === 1 ? "was" : "were"} left out: ${overlapping[0].reason}`
      : "";
  if (addable.length === 0) {
    return {
      ok: true,
      added: 0,
      articles: [],
      message: `No keywords added to your calendar.${overlapNote}`,
      overlapping,
    };
  }

  // The free days for THIS site, read once: one article per site per day.
  const days = await nextFreeDays(supabase, businessId, addable.length, input.now);
  const rows = addable.map((kw, i) => ({
    user_id: userId,
    business_id: businessId,
    keyword_id: kw.id as string,
    scheduled_date: days[i],
    status: "queued",
  }));

  const { data: inserted, error: insertError } = await supabase
    .from("articles")
    .insert(rows)
    .select("id, keyword_id, scheduled_date");
  if (insertError || !inserted) {
    console.error("Error bulk-adding to calendar:", insertError);
    return { ok: false, status: 500, error: "Failed to add keywords to calendar" };
  }

  // Link each keyword to its freshly created article.
  await Promise.all(
    inserted.map((article) =>
      supabase
        .from("keywords")
        .update({ status: "queued", article_id: article.id })
        .eq("id", article.keyword_id as string)
        .eq("business_id", businessId)
        .eq("user_id", userId)
    )
  );

  return {
    ok: true,
    added: inserted.length,
    articles: inserted.map((article) => ({
      articleId: article.id as string,
      keywordId: article.keyword_id as string,
      scheduledDate: article.scheduled_date as string,
    })),
    message: `${inserted.length} keyword${inserted.length === 1 ? "" : "s"} added to your calendar.${overlapNote}`,
    overlapping,
  };
}

/** Takes an article off the calendar; its keyword is available again. */
export async function unscheduleArticle(input: {
  supabase: SupabaseClient;
  userId: string;
  businessId: string;
  articleId: string;
}): Promise<{ ok: true; keywordId: string | null } | CalendarFailure> {
  const { supabase, userId, businessId, articleId } = input;
  const { data: article, error: fetchError } = await supabase
    .from("articles")
    .select("id, keyword_id")
    .eq("id", articleId)
    .eq("business_id", businessId)
    .eq("user_id", userId)
    .single();
  if (fetchError || !article) return { ok: false, status: 404, error: "Article not found" };

  const { error: deleteError } = await supabase
    .from("articles")
    .delete()
    .eq("id", articleId)
    .eq("business_id", businessId)
    .eq("user_id", userId);
  if (deleteError) {
    console.error("Error removing from calendar:", deleteError);
    return { ok: false, status: 500, error: "Failed to remove from calendar" };
  }

  const keywordId = (article.keyword_id as string | null) ?? null;
  await supabase
    .from("keywords")
    .update({ status: "available", article_id: null })
    .eq("id", keywordId)
    .eq("business_id", businessId)
    .eq("user_id", userId);

  return { ok: true, keywordId };
}

/**
 * Puts a failed article back in the queue with a fresh attempt count. No
 * paywall: re-queueing spends nothing by itself, and the generation cron
 * does not produce for an account without a subscription. A 404 when the
 * article is not this site's or not failed.
 */
export async function retryArticle(input: {
  supabase: SupabaseClient;
  userId: string;
  businessId: string;
  articleId: string;
  now?: Date;
}): Promise<{ ok: true } | CalendarFailure> {
  const { data, error } = await input.supabase
    .from("articles")
    .update({
      status: "queued",
      attempt_count: 0,
      last_error: null,
      failed_at: null,
      updated_at: (input.now ?? new Date()).toISOString(),
    })
    .eq("id", input.articleId)
    .eq("business_id", input.businessId)
    .eq("user_id", input.userId)
    .eq("status", "failed")
    .select("id")
    .maybeSingle();
  if (error) return { ok: false, status: 500, error: error.message };
  if (!data) return { ok: false, status: 404, error: "Article not found or not in a failed state" };
  return { ok: true };
}

/**
 * Why `targetDate` cannot take an article, or null when it can: a
 * YYYY-MM-DD day from today on (UTC, the generation cron's day).
 */
export function rescheduleDateRefusal(targetDate: string, now: Date = new Date()): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) return "articleId and targetDate (YYYY-MM-DD) are required";
  if (targetDate < utcDay(now)) return "Cannot schedule an article in the past";
  return null;
}

/**
 * The move itself, swapping dates with the article already on the target
 * day, atomically, so the one-article-per-day unique index never fails
 * half-way. Two ways to run the same SQL:
 *
 * - `sessionMove`: the person's own client, `move_article(id, date)`, which
 *   reads the owner from `auth.uid()`;
 * - `ownerMove`: an API key has no user JWT, so `auth.uid()` is null there;
 *   the service role runs `move_article_for_owner(owner, id, date)`, which
 *   is the same body with the owner passed in and is executable by the
 *   service role only (migration 20261109231500_move_article_for_owner.sql).
 */
export type ArticleMove = (articleId: string, targetDate: string) => Promise<{ error: { message?: string } | null }>;

export function sessionMove(supabase: SupabaseClient): ArticleMove {
  return async (articleId, targetDate) =>
    supabase.rpc("move_article", { p_article_id: articleId, p_target_date: targetDate });
}

export function ownerMove(admin: SupabaseClient, userId: string): ArticleMove {
  return async (articleId, targetDate) =>
    admin.rpc("move_article_for_owner", { p_owner: userId, p_article_id: articleId, p_target_date: targetDate });
}

/**
 * Moves one of the site's articles to `targetDate`. The date was checked
 * with `rescheduleDateRefusal`; the article is looked up on the site and the
 * user first, so an id of another site never reaches the move.
 */
export async function rescheduleArticle(input: {
  supabase: SupabaseClient;
  userId: string;
  businessId: string;
  articleId: string;
  targetDate: string;
  move: ArticleMove;
}): Promise<{ ok: true } | CalendarFailure> {
  const { data: owned } = await input.supabase
    .from("articles")
    .select("id")
    .eq("id", input.articleId)
    .eq("business_id", input.businessId)
    .eq("user_id", input.userId)
    .maybeSingle();
  if (!owned) return { ok: false, status: 404, error: "Article not found" };

  const { error } = await input.move(input.articleId, input.targetDate);
  if (error) {
    console.error("Error rescheduling article:", error);
    const notFound = /not found/i.test(error.message ?? "");
    return notFound
      ? { ok: false, status: 404, error: "Article not found" }
      : { ok: false, status: 500, error: "Failed to reschedule article" };
  }
  return { ok: true };
}
