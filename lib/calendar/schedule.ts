import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Where a keyword lands when someone adds it to the calendar by hand.
 *
 * One rule, shared by "Add to calendar" and the bulk add: the first days after
 * today that the SITE has no article on. One article per site per day is the
 * `articles_business_id_scheduled_date_key` unique index, so two sites of the
 * same account each keep their own calendar and can publish on the same date.
 *
 * Never today or the past: the generation cron has already run for today, so
 * an article placed there would sit unproduced until the next run.
 *
 * Days are UTC calendar days (YYYY-MM-DD), the same days the generation cron
 * means by "due" (`new Date().toISOString().slice(0, 10)`).
 *
 * Autopilot fills a bounded window with its own `planSchedule`
 * (`lib/automation/autopilot.ts`): a different rule (a buffer, a per-run cap,
 * best keyword first), not a copy of this one.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** The UTC calendar day of an instant, as `articles.scheduled_date` stores it. */
export function utcDay(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

/**
 * The first `count` days after `today` that are not in `taken`, in order.
 * Pure: the calendar read is the caller's, so the rule is testable alone.
 */
export function firstFreeDays(taken: Iterable<string>, count: number, today: Date): string[] {
  const used = new Set(taken);
  const midnight = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const days: string[] = [];
  // Terminates: `used` is finite, so free days keep coming after it runs out.
  for (let offset = 1; days.length < count; offset += 1) {
    const day = utcDay(new Date(midnight + offset * DAY_MS));
    if (used.has(day)) continue;
    days.push(day);
  }
  return days;
}

/**
 * Reads the days this site already has an article on, from today on, and
 * returns the first `count` free ones after today.
 *
 * Throws when the calendar cannot be read: an unreadable calendar read as an
 * empty one would hand out days that are taken.
 */
export async function nextFreeDays(
  supabase: SupabaseClient,
  businessId: string,
  count: number,
  now: Date = new Date()
): Promise<string[]> {
  if (count <= 0) return [];

  const { data, error } = await supabase
    .from("articles")
    .select("scheduled_date")
    .eq("business_id", businessId)
    .gte("scheduled_date", utcDay(now));

  if (error) throw new Error(`Could not read the calendar: ${error.message}`);

  const taken = (data ?? []).map((row) => row.scheduled_date as string);
  return firstFreeDays(taken, count, now);
}
