import type { SupabaseClient } from "@supabase/supabase-js";
import { addKeywords } from "@/lib/keywords/manage";
import { loadSiteTopics } from "@/lib/keywords/overlap";
import { QUESTION_IDEAS_DEFAULT, QUESTION_SOURCE } from "@/lib/keywords/questions";
import { loadQuestionIdeas } from "@/lib/keywords/read";
import { MAX_QUESTIONS_PER_DAY, questionsToAdd } from "./autopilot";

/**
 * Autopilot's free top-up: "Questions people ask" go into the pool on their
 * own, up to `MAX_QUESTIONS_PER_DAY` a site a UTC day. Called by the
 * Autopilot sweep (app/api/cron/autopilot) before it schedules and before it
 * considers buying keywords, so a question is fuel like any other topic and
 * a model call is saved when the pool reaches its floor this way.
 *
 * What it costs: nothing. A few reads of the site's own rows (today's
 * question topics, the ideas, the site's topics) and one insert through
 * `addKeywords`, the function every add goes through, which checks the
 * thread is one of the site's and the topic overlaps nothing the site has.
 * No model, no provider. The article written for a question is the one
 * Autopilot writes that day anyway: one a day, whatever the pool holds.
 *
 * Behind Autopilot's opt-in: the sweep calls it only for a site with
 * Autopilot on, and only for an owner who pays.
 */

export interface AskedQuestionsResult {
  /** The questions added, as stored. */
  added: string[];
  /** Question topics the site already had today, before this call. */
  addedBefore: number;
}

function utcDayStart(now: Date): string {
  return `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
}

export async function addAskedQuestions(input: {
  supabase: SupabaseClient;
  userId: string;
  businessId: string;
  now?: Date;
  cap?: number;
  /** The platforms the site's data names, so a how-to about one is stored as a platform how-to. */
  names?: readonly string[];
}): Promise<AskedQuestionsResult> {
  const { supabase, userId, businessId } = input;
  const now = input.now ?? new Date();
  const cap = input.cap ?? MAX_QUESTIONS_PER_DAY;

  const { count, error: countError } = await supabase
    .from("keywords")
    .select("id", { count: "exact", head: true })
    .eq("business_id", businessId)
    .eq("source", QUESTION_SOURCE)
    .gte("created_at", utcDayStart(now));
  // Unreadable: do not add blind, the cap could not be honoured.
  if (countError) throw new Error(`question topics today: ${countError.message}`);
  const addedBefore = count ?? 0;
  if (addedBefore >= cap) return { added: [], addedBefore };

  const [ideas, topics] = await Promise.all([
    loadQuestionIdeas(supabase, businessId, { limit: QUESTION_IDEAS_DEFAULT }),
    loadSiteTopics(supabase, businessId),
  ]);
  if (!ideas.ok) throw new Error("could not read the questions people ask");
  if (!topics.ok) throw new Error("could not read the site's topics");

  const chosen = questionsToAdd({ topics, ideas: ideas.questions, addedToday: addedBefore, cap });
  if (chosen.length === 0) return { added: [], addedBefore };

  const result = await addKeywords({
    supabase,
    userId,
    businessId,
    keywords: chosen.map((idea) => ({ keyword: idea.question, source: QUESTION_SOURCE, sourceUrl: idea.sourceUrl })),
    names: input.names,
  });
  if (!result.ok) {
    // Every one already in the list (a race with the person): nothing to add.
    if (result.status === 409) return { added: [], addedBefore };
    throw new Error(`adding questions: ${result.error}`);
  }
  return { added: result.keywords.map((row) => String(row.keyword ?? "")), addedBefore };
}
