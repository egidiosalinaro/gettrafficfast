/**
 * The periods Growth compares (docs/LIFECYCLE.md, "Growth"): the last 7 or
 * 28 days against the same length just before. Pure: the page, the route,
 * `get_growth` and `list_ai_answers` read the same windows.
 *
 * A window is a run of whole UTC days, `from` and `to` inclusive
 * (`YYYY-MM-DD`). The current one ends on its anchor day: today for the AI
 * answers, the newest day Search Console has settled for Google (whose last
 * three days arrive late, so "the last 7 days" ending today would compare a
 * half-counted week with a whole one). Replies on X keep their own rolling
 * windows (lib/placements/reply-stats.ts), read as of each window's last day.
 */

export const GROWTH_DAYS = [7, 28] as const;
export type GrowthDays = (typeof GROWTH_DAYS)[number];

export const DEFAULT_GROWTH_DAYS: GrowthDays = 7;

/** `?days=28` (or "28d") is 28; anything else is the default week. */
export function parseGrowthDays(value: unknown): GrowthDays {
  const raw = Array.isArray(value) ? value[0] : value;
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  return n === 28 ? 28 : DEFAULT_GROWTH_DAYS;
}

export interface DayWindow {
  /** First day, inclusive. */
  from: string;
  /** Last day, inclusive. */
  to: string;
}

export interface PeriodWindows {
  days: GrowthDays;
  current: DayWindow;
  previous: DayWindow;
}

const DAY_MS = 86_400_000;

export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

export function shiftDay(day: string, days: number): string {
  return utcDay(new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS));
}

/** The window of `days` days ending on `anchor`, and the one just before it. */
export function periodWindows(days: GrowthDays, anchor: string): PeriodWindows {
  return {
    days,
    current: { from: shiftDay(anchor, -(days - 1)), to: anchor },
    previous: { from: shiftDay(anchor, -(2 * days - 1)), to: shiftDay(anchor, -days) },
  };
}

/** Whether a day (`YYYY-MM-DD`, or an ISO timestamp read as its UTC day) falls in the window. */
export function inWindow(day: string | null | undefined, window: DayWindow): boolean {
  if (!day) return false;
  const d = day.slice(0, 10);
  return d >= window.from && d <= window.to;
}
