import { takeWeek, type TopicIntent } from "@/lib/keywords/intent";
import { findOverlaps, splitSchedulable, type ScheduleRefusal, type SiteTopics } from "@/lib/keywords/overlap";

/**
 * Autopilot planning.
 *
 * Pure by design: deciding WHICH keyword goes on WHICH day is the part that
 * can be wrong in ways nobody notices for a week, so it is decided here, in
 * functions a test can pin, and executed elsewhere.
 */

export interface PlannedArticle {
  keywordId: string;
  scheduledDate: string;
}

export interface SchedulableKeyword {
  id: string;
  /** Higher is better. Ties fall back to the order given. */
  score: number;
  /**
   * The kind of search (lib/keywords/intent.ts). A week aims for a mix of
   * them (`WEEKLY_MIX`); absent, the keyword counts as a core topic, and a
   * pool with no intents is scheduled by score alone, as before.
   */
  intent?: TopicIntent | null;
}

/** Opportunity and difficulty as stored, folded into one comparable number. */
export function keywordScore(params: {
  opportunity?: string | null;
  difficulty?: number | null;
  searchVolume?: number | null;
}): number {
  const opportunity = { High: 2, Medium: 1, Low: 0 }[params.opportunity ?? "Medium"] ?? 1;
  // Difficulty is 0-100 where lower is easier; volume only breaks ties.
  const ease = (100 - (params.difficulty ?? 50)) / 100;
  const volume = Math.min(params.searchVolume ?? 0, 10_000) / 10_000;
  return opportunity * 10 + ease * 2 + volume;
}

function isoDay(base: Date, offset: number): string {
  return new Date(base.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Fills the empty days inside the buffer window, a week at a time: each
 * week first takes what it lacks of the mix (`WEEKLY_MIX`: one or two
 * comparisons, two platform how-tos, two or three problem pieces, when the
 * pool has them, counting what the week already holds), then the best
 * keywords by score; within a week the best goes on the earliest free day.
 * A pool with no intents is scheduled best keyword first, as before.
 *
 * Three rules that all exist because breaking them is silent:
 *  - never today or the past: the generation cron has already run for those,
 *    so an article scheduled there would never be produced;
 *  - never a day that already has an article, which is what makes the sweep
 *    idempotent: running it twice in a day changes nothing;
 *  - never more than the caps, so a misconfigured buffer cannot schedule a
 *    year of work in one run.
 */
export function planSchedule(params: {
  today: Date;
  bufferDays: number;
  /** Dates (YYYY-MM-DD) that already carry an article. */
  occupiedDates: Iterable<string>;
  /**
   * The intent of the topic each occupied date carries, where known: what
   * a week already holds counts toward its mix. A date missing here counts
   * as a core topic.
   */
  occupiedIntents?: ReadonlyMap<string, TopicIntent | null>;
  /** Keywords with no article yet. */
  available: SchedulableKeyword[];
  maxPerRun: number;
}): PlannedArticle[] {
  const occupied = new Set(params.occupiedDates);
  const queue = [...params.available].sort((a, b) => b.score - a.score);
  const planned: PlannedArticle[] = [];
  const buffer = Math.max(0, Math.floor(params.bufferDays));

  // Weeks of the buffer, counted back from its last day, so the day a daily
  // run adds at the end is weighed with the six before it. Earliest week
  // first: the nearest days get the best topics.
  const weeks: number[][] = [];
  for (let end = buffer; end >= 1; end -= 7) {
    const week: number[] = [];
    for (let offset = Math.max(1, end - 6); offset <= end; offset += 1) week.push(offset);
    weeks.unshift(week);
  }

  for (const week of weeks) {
    if (planned.length >= params.maxPerRun || queue.length === 0) break;
    const dates = week.map((offset) => isoDay(params.today, offset));
    const free = dates.filter((date) => !occupied.has(date));
    if (free.length === 0) continue;
    const held: Partial<Record<TopicIntent, number>> = {};
    for (const date of dates) {
      if (!occupied.has(date)) continue;
      const intent = params.occupiedIntents?.get(date) ?? "product_adjacent";
      held[intent] = (held[intent] ?? 0) + 1;
    }
    const slots = Math.min(free.length, params.maxPerRun - planned.length);
    const chosen = takeWeek(queue, held, slots);
    chosen.forEach((keyword, i) => {
      planned.push({ keywordId: keyword.id, scheduledDate: free[i] });
      occupied.add(free[i]);
    });
  }

  // In date order, as the sweep has always written them.
  return planned.sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate));
}

/**
 * How many keywords to generate.
 *
 * Only below the floor, and only up to it: topping the pool to exactly the
 * floor keeps the cost proportional to the buffer rather than to how long the
 * customer has been away.
 */
export function keywordsToGenerate(params: {
  availableCount: number;
  floor: number;
  maxPerRun: number;
}): number {
  const missing = params.floor - params.availableCount;
  if (missing <= 0) return 0;
  return Math.min(missing, params.maxPerRun);
}

/** Keywords already known, so generation does not propose them again. */
export function dedupeAgainstKnown(
  suggestions: Array<{ keyword: string }>,
  known: Iterable<string>
): Array<{ keyword: string }> {
  const seen = new Set([...known].map((k) => k.trim().toLowerCase()));
  const out: Array<{ keyword: string }> = [];
  for (const suggestion of suggestions) {
    const key = suggestion.keyword.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(suggestion);
  }
  return out;
}

/**
 * The keywords Autopilot may schedule: the pool without the ones whose
 * near-duplicate is already scheduled, being written or published
 * (lib/keywords/duplicates.ts). Best score first, so of two duplicates in
 * the pool the better one is kept and the other is refused, with the reason.
 * Autopilot never overrides this: nobody is there to say "both".
 */
export function withoutOverlapping<T extends SchedulableKeyword>(
  topics: SiteTopics,
  available: readonly T[]
): { schedulable: T[]; refused: ScheduleRefusal[] } {
  return splitSchedulable(
    topics,
    [...available].sort((a, b) => b.score - a.score)
  );
}

/**
 * How many "Questions people ask" Autopilot adds to a site's pool in one UTC
 * day, at most. The cap counts every question added that day, by Autopilot
 * or by the person, so a second run on the same day adds nothing more.
 */
export const MAX_QUESTIONS_PER_DAY = 3;

/**
 * The questions Autopilot adds to the pool today: the ideas in their order
 * (most threads first, lib/keywords/questions.ts), without the ones that
 * overlap a keyword the site has, a published article or an earlier idea of
 * the same list (`findOverlaps`, the rule every add follows), up to what is
 * left of today's cap.
 *
 * Free by construction: the ideas are rows discovery already stored, the
 * check reads the site's own topics, and a topic in the pool costs nothing
 * until a day is scheduled for it, which Autopilot does one a day whatever
 * the pool holds. A bigger pool means fewer keywords bought.
 */
export function questionsToAdd<T extends { question: string }>(params: {
  topics: SiteTopics;
  ideas: readonly T[];
  /** Question topics the site already got today (UTC). */
  addedToday: number;
  cap?: number;
}): T[] {
  const room = Math.max(0, (params.cap ?? MAX_QUESTIONS_PER_DAY) - Math.max(0, params.addedToday));
  if (room === 0 || params.ideas.length === 0) return [];
  const stored = new Set(params.topics.keywords.map((k) => k.keyword.trim().toLowerCase()));
  const unseen = params.ideas.filter((idea) => !stored.has(idea.question.trim().toLowerCase()));
  const { overlaps } = findOverlaps(
    params.topics,
    unseen.map((idea) => idea.question)
  );
  const overlapping = new Set(overlaps.map((o) => o.keyword));
  return unseen.filter((idea) => !overlapping.has(idea.question.trim())).slice(0, room);
}

/**
 * Suggestions worth buying into the pool: not already known letter for
 * letter (`dedupeAgainstKnown`), and not a near-duplicate of a keyword the
 * site has, of a published article, or of an earlier suggestion.
 */
export function freshSuggestions<T extends { keyword: string }>(topics: SiteTopics, suggestions: readonly T[]): T[] {
  const unseen = dedupeAgainstKnown(
    [...suggestions],
    topics.keywords.map((k) => k.keyword)
  ) as T[];
  const { overlaps } = findOverlaps(
    topics,
    unseen.map((s) => s.keyword)
  );
  const overlapping = new Set(overlaps.map((o) => o.keyword));
  return unseen.filter((s) => !overlapping.has(s.keyword.trim()));
}
