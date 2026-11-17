/**
 * When discovery runs on its own, as `vercel.json` schedules it, and the
 * next time it will (the ⋯ menu beside "Run discovery", `list_reply_inbox`).
 * A test holds these to `vercel.json`, so the two cannot drift apart.
 *
 * Web discovery ran once a week (Wednesday) until 2026-11-12, and the inbox
 * filled with threads weeks old by the time anyone saw them; it runs three
 * times a week now. What that costs is in docs/PLACEMENTS.md.
 */

export interface UtcSchedule {
  /** The cron line, exactly as vercel.json has it. */
  cron: string;
  /** Days of the week it runs (0 Sunday … 6 Saturday, UTC); null: every day. */
  days: number[] | null;
  hour: number;
  minute: number;
}

/** `/api/cron/discover-placements`: Monday, Wednesday and Friday at 10:00 UTC. */
export const WEB_DISCOVERY_SCHEDULE: UtcSchedule = { cron: "0 10 * * 1,3,5", days: [1, 3, 5], hour: 10, minute: 0 };

/** `/api/cron/x-posts`: the daily X search, 13:20 UTC. */
export const X_SEARCH_SCHEDULE: UtcSchedule = { cron: "20 13 * * *", days: null, hour: 13, minute: 20 };

/** The first scheduled instant strictly after `now`. */
export function nextScheduledRun(schedule: UtcSchedule, now: Date): Date {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), schedule.hour, schedule.minute));
  for (let i = 0; i < 8; i += 1) {
    const at = new Date(day.getTime() + i * 86_400_000);
    if (at.getTime() <= now.getTime()) continue;
    if (!schedule.days || schedule.days.includes(at.getUTCDay())) return at;
  }
  // Unreachable for a schedule with at least one day; a week on is the honest bound.
  return new Date(day.getTime() + 7 * 86_400_000);
}
