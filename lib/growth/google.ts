import { roundPosition } from "@/lib/format";
import { inWindow, periodWindows, shiftDay, type DayWindow, type GrowthDays } from "./period";

/**
 * Growth → Google: the site's Search Console numbers over a period against
 * the period before (docs/LIFECYCLE.md, "Growth"). Pure.
 *
 * The rows are `content_metrics` with source `search_console`: one per
 * published article and day, with Google's impressions, clicks and average
 * position for that page. Search Console omits a day with nothing to report,
 * so inside the ingested range a missing day is a real zero, and the windows
 * end on the newest day ingested (`settledThrough`: the connection's
 * watermark, or the newest row when that is later), never on today: Google
 * settles its last days over about three, and a window ending today would
 * compare a half-counted week with a whole one.
 *
 * Honest numbers:
 * - nothing ingested at all is null, never 0 (the screen says "no data yet"
 *   or "not connected");
 * - a previous window that starts before the data covers (the first pull
 *   reads about 90 days back) is null, "no comparison yet", not a zero that
 *   would read as growth from nothing;
 * - the average position is weighted by impressions, as Search Console
 *   computes a property's average, over the article-days that had any; with
 *   no impression it is null. Rounded to one decimal (`roundPosition`), and
 *   its change is previous minus current: positive is up the page.
 */

export interface SearchDay {
  /** `YYYY-MM-DD`, the day Google counted. */
  day: string;
  impressions: number;
  clicks: number;
  /** Google's average position for the page that day; null when not recorded. */
  position: number | null;
}

export interface SearchTotals extends DayWindow {
  impressions: number;
  clicks: number;
  /** Impression-weighted average position, one decimal; null with no impression. */
  averagePosition: number | null;
}

export interface SearchGrowth {
  days: GrowthDays;
  /** The newest day ingested; the current window ends on it. Null when nothing was ever ingested. */
  settledThrough: string | null;
  /** The first day the ingested data covers. */
  coveredFrom: string | null;
  current: SearchTotals | null;
  /** Null when nothing is ingested or the window starts before `coveredFrom`. */
  previous: SearchTotals | null;
  change: {
    impressions: number | null;
    clicks: number | null;
    /** previous − current, one decimal: positive moved up the page. */
    averagePosition: number | null;
  };
}

function totals(points: readonly SearchDay[], window: DayWindow): SearchTotals {
  let impressions = 0;
  let clicks = 0;
  let weighted = 0;
  let weight = 0;
  for (const p of points) {
    if (!inWindow(p.day, window)) continue;
    impressions += p.impressions;
    clicks += p.clicks;
    if (p.position !== null && Number.isFinite(p.position) && p.impressions > 0) {
      weighted += p.position * p.impressions;
      weight += p.impressions;
    }
  }
  return {
    ...window,
    impressions,
    clicks,
    averagePosition: weight > 0 ? roundPosition(weighted / weight) : null,
  };
}

/**
 * The period and the one before. `coveredFrom` is the first day the
 * connection's data covers (its first pull reads `FIRST_SYNC_DAYS` back);
 * without one, the oldest row stands in for it.
 */
export function summarizeSearchGrowth(
  points: readonly SearchDay[],
  options: {
    days: GrowthDays;
    coveredFrom?: string | null;
    /** The newest day fetched (the connection's watermark): a day after the last row can be a real zero. */
    through?: string | null;
  }
): SearchGrowth {
  const none: SearchGrowth = {
    days: options.days,
    settledThrough: null,
    coveredFrom: options.coveredFrom ?? null,
    current: null,
    previous: null,
    change: { impressions: null, clicks: null, averagePosition: null },
  };
  if (points.length === 0) return none;

  let settledThrough = options.through && options.through > points[0].day ? options.through : points[0].day;
  let oldest = points[0].day;
  for (const p of points) {
    if (p.day > settledThrough) settledThrough = p.day;
    if (p.day < oldest) oldest = p.day;
  }
  const coveredFrom = options.coveredFrom && options.coveredFrom < oldest ? options.coveredFrom : oldest;
  const windows = periodWindows(options.days, settledThrough);
  const current = totals(points, windows.current);
  const previous = windows.previous.from >= coveredFrom ? totals(points, windows.previous) : null;

  return {
    days: options.days,
    settledThrough,
    coveredFrom,
    current,
    previous,
    change: {
      impressions: previous ? current.impressions - previous.impressions : null,
      clicks: previous ? current.clicks - previous.clicks : null,
      averagePosition:
        previous && previous.averagePosition !== null && current.averagePosition !== null
          ? roundPosition(previous.averagePosition - current.averagePosition)
          : null,
    },
  };
}

/** The first day a connection created on `createdAt` covers: its first pull reads `firstSyncDays` back. */
export function coverageStart(createdAt: string | null | undefined, firstSyncDays: number): string | null {
  if (!createdAt) return null;
  const day = createdAt.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  return shiftDay(day, -firstSyncDays);
}
