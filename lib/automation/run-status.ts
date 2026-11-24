import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

/**
 * What Autopilot's last run did for one site, and why it did less than the
 * calendar needed when it did.
 *
 * Until 2026-11-24 every reason the sweep had for leaving a site's calendar
 * empty (a pool of topics that all overlap what the site already published,
 * a top-up that found nothing new, a lapsed plan, today's AI limit, an
 * error) went into the cron's own JSON response or a log line, which no
 * customer reads. A site could show "Autopilot on" for weeks while nothing
 * happened. The sweep now stores this record on the site
 * (`businesses.autopilot_run`) at the end of every run for a site with
 * Autopilot on, and the Content screen, `get_content` and Settings →
 * Autopilot say it in words.
 *
 * Pure: the sweep builds it, the readers describe it. A column that cannot
 * be parsed reads as "no run recorded", never as a run that went well.
 */

export const AUTOPILOT_REASON_CODES = [
  /** The account has no active plan: the site was skipped whole. */
  "no_plan",
  /** Today's limit for AI work is reached: new topics wait, scheduling went on. */
  "ai_limit",
  /** AI work is paused for now: new topics wait, scheduling went on. */
  "ai_paused",
  /** Topics in the pool not scheduled: each overlaps one already covered. */
  "pool_overlaps",
  /** The top-up asked for topics and every suggestion overlapped one the site has. */
  "no_new_topics",
  /** Days in the buffer stay empty: no topic was left to schedule. */
  "days_empty",
  /** The run stopped with an error; it is tried again next run. */
  "failed",
] as const;

export type AutopilotReasonCode = (typeof AUTOPILOT_REASON_CODES)[number];

export const AutopilotRunRecord = z.object({
  /** When the run finished for this site (ISO). */
  at: z.string(),
  /** Articles put on the calendar by this run. */
  scheduled: z.number().int().min(0),
  /** Topics bought by the top-up. */
  topicsAdded: z.number().int().min(0),
  /** Questions people ask added to the pool. */
  questionsAdded: z.number().int().min(0),
  /** Days of the buffer (tomorrow onward) still without an article after the run; null when not counted. */
  emptyDays: z.number().int().min(0).nullable(),
  bufferDays: z.number().int().min(0),
  reasons: z.array(z.object({ code: z.enum(AUTOPILOT_REASON_CODES), message: z.string() })),
});

export type AutopilotRunRecord = z.infer<typeof AutopilotRunRecord>;

/** Tolerant read: anything malformed is "no run recorded". */
export function parseAutopilotRun(value: unknown): AutopilotRunRecord | null {
  if (value === null || value === undefined) return null;
  const parsed = AutopilotRunRecord.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The reasons, in the customer's words. One builder so the screens and the tool say the same thing. */
export const autopilotReason = {
  noPlan: () => ({
    code: "no_plan" as const,
    message: "Autopilot did nothing for this site: the account has no active plan. It picks up again on the first run after the plan is active.",
  }),
  aiLimit: () => ({
    code: "ai_limit" as const,
    message: "New topics wait: the account reached today's limit for AI work. Topics already in the pool were still scheduled.",
  }),
  aiPaused: () => ({
    code: "ai_paused" as const,
    message: "New topics wait: AI work is paused for now. Topics already in the pool were still scheduled.",
  }),
  poolOverlaps: (count: number, example: string | null) => ({
    code: "pool_overlaps" as const,
    message: `${plural(count, "topic", "topics")} in the pool ${count === 1 ? "was" : "were"} not scheduled: ${count === 1 ? "it overlaps" : "each overlaps"} a topic already published or on the calendar${example ? ` (e.g. ${example})` : ""}. Two articles on one topic compete with each other.`,
  }),
  noNewTopics: (asked: number) => ({
    code: "no_new_topics" as const,
    message: `The top-up looked for ${plural(asked, "new topic", "new topics")} and found none: every suggestion overlapped a topic the site already has. Add topics on Content, or give the site's description more to work with in Settings.`,
  }),
  daysEmpty: (days: number, bufferDays: number) => ({
    code: "days_empty" as const,
    message: `${plural(days, "day", "days")} of the next ${bufferDays} ${days === 1 ? "has" : "have"} no article: no topic was left to schedule.`,
  }),
  failed: () => ({
    code: "failed" as const,
    message: "The last run stopped with an error before it finished for this site. It is tried again on the next run.",
  }),
};

export type AutopilotRunState =
  /** Enabled, never run since this was recorded. */
  | "not_run_yet"
  /** The run did what the calendar needed. */
  | "working"
  /** The run did less than the calendar needed: see reasons. */
  | "stalled"
  /** The run skipped the site whole (no plan). */
  | "skipped";

export interface AutopilotRunView {
  state: AutopilotRunState;
  /** One sentence for the screen. */
  message: string;
  /** The last run, as stored; null before the first. */
  lastRun: AutopilotRunRecord | null;
}

/** When the sweep runs, as the screens say it. */
export const AUTOPILOT_RUN_TIME = "06:00 UTC";

/**
 * The state of a site's Autopilot in one sentence, from its setting and its
 * last run. Null while Autopilot is off: the screens already say "off".
 */
export function describeAutopilotRun(input: { enabled: boolean; run: AutopilotRunRecord | null }): AutopilotRunView | null {
  if (!input.enabled) return null;
  const run = input.run;
  if (!run) {
    return {
      state: "not_run_yet",
      message: `Autopilot has not run for this site yet. It runs every day at ${AUTOPILOT_RUN_TIME}.`,
      lastRun: null,
    };
  }
  if (run.reasons.some((r) => r.code === "no_plan")) {
    return { state: "skipped", message: run.reasons.find((r) => r.code === "no_plan")!.message, lastRun: run };
  }
  if (run.reasons.length > 0) {
    // The reason that explains the empty days first, then the rest.
    const order: AutopilotReasonCode[] = ["failed", "days_empty", "no_new_topics", "pool_overlaps", "ai_limit", "ai_paused"];
    const first = [...run.reasons].sort((a, b) => order.indexOf(a.code) - order.indexOf(b.code))[0];
    return { state: "stalled", message: first.message, lastRun: run };
  }
  const did = [
    run.scheduled > 0 ? `scheduled ${plural(run.scheduled, "article", "articles")}` : null,
    run.topicsAdded > 0 ? `added ${plural(run.topicsAdded, "topic", "topics")}` : null,
    run.questionsAdded > 0 ? `added ${plural(run.questionsAdded, "question", "questions")} people ask` : null,
  ].filter(Boolean);
  return {
    state: "working",
    message: did.length > 0 ? `Last run ${did.join(", ")}.` : `Last run: the next ${run.bufferDays} days were already covered.`,
    lastRun: run,
  };
}

/** Days from tomorrow to `bufferDays` ahead with no article, given the dates that carry one. */
export function countEmptyDays(today: Date, bufferDays: number, occupied: ReadonlySet<string>): number {
  let empty = 0;
  for (let offset = 1; offset <= Math.max(0, Math.floor(bufferDays)); offset += 1) {
    const day = new Date(today.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
    if (!occupied.has(day)) empty += 1;
  }
  return empty;
}

/**
 * The site's last run record, read on its own so that a database without
 * the column yet (the migration not applied) reads as "no run recorded"
 * rather than breaking the screen that asks.
 */
export async function readAutopilotRun(supabase: SupabaseClient, businessId: string): Promise<AutopilotRunRecord | null> {
  const { data, error } = await supabase.from("businesses").select("autopilot_run").eq("id", businessId).maybeSingle();
  if (error) {
    console.error("Error reading the Autopilot run record:", error.message);
    return null;
  }
  return parseAutopilotRun((data as { autopilot_run?: unknown } | null)?.autopilot_run);
}
