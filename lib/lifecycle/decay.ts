import { RankPoint } from "./rank";

/**
 * Decay detection — pure, and deliberately conservative.
 *
 * Rewriting an article costs money and risks replacing something that works,
 * so the default answer is "leave it alone". A refresh needs either evidence
 * that the article lost ground, or an age at which any article deserves a look.
 */

/** A freshly rewritten article is left alone, whatever the numbers say. */
export const REFRESH_COOLDOWN_DAYS = 30;

/** Age at which an article is worth revisiting even with no rank evidence. */
export const STALE_AFTER_DAYS = 120;

/** Two measurements a day apart say nothing; a trend needs a real span. */
export const MIN_TREND_SPAN_DAYS = 14;

/** Positions lost before "slipping" is more than noise. */
export const SLIP_THRESHOLD = 5;

/** Ranking this well is defended, not rewritten, on a few positions of noise. */
const SAFE_POSITION = 3;

export type DecayReason = "lost_ranking" | "slipping" | "stale";

export interface DecayVerdict {
  decaying: boolean;
  reason: DecayReason | null;
  /** Human-readable evidence — travels into the refresh plan and the logs. */
  detail: string;
  from?: number | null;
  to?: number | null;
}

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}

export function detectDecay(input: {
  /** Measurements oldest-first. */
  points: RankPoint[];
  publishedAt: string | null;
  lastRefreshedAt: string | null;
  now: Date;
}): DecayVerdict {
  const { points, now } = input;

  if (input.lastRefreshedAt) {
    const since = daysBetween(new Date(input.lastRefreshedAt), now);
    if (since < REFRESH_COOLDOWN_DAYS) {
      return {
        decaying: false,
        reason: null,
        detail: `refreshed ${since} day(s) ago — inside the ${REFRESH_COOLDOWN_DAYS}-day cooldown`,
      };
    }
  }

  // ── Rank evidence, when there is enough of it to mean something ───────────
  const measured = points.filter((p) => p.capturedOn);
  if (measured.length >= 2) {
    const first = measured[0];
    const last = measured[measured.length - 1];
    const span = daysBetween(new Date(first.capturedOn), new Date(last.capturedOn));

    if (span >= MIN_TREND_SPAN_DAYS) {
      if (first.position !== null && last.position === null) {
        return {
          decaying: true,
          reason: "lost_ranking",
          detail: `ranked #${first.position} on ${first.capturedOn}, absent from the results on ${last.capturedOn}`,
          from: first.position,
          to: null,
        };
      }
      if (
        first.position !== null &&
        last.position !== null &&
        last.position - first.position >= SLIP_THRESHOLD &&
        last.position > SAFE_POSITION
      ) {
        return {
          decaying: true,
          reason: "slipping",
          detail: `slipped from #${first.position} to #${last.position} between ${first.capturedOn} and ${last.capturedOn}`,
          from: first.position,
          to: last.position,
        };
      }
    }
  }

  // ── Age, the fallback signal when nothing has been measured yet ───────────
  const anchor = input.lastRefreshedAt ?? input.publishedAt;
  if (anchor) {
    const age = daysBetween(new Date(anchor), now);
    if (age >= STALE_AFTER_DAYS) {
      return {
        decaying: true,
        reason: "stale",
        detail: `last updated ${age} days ago, with no sign it still competes`,
      };
    }
  }

  return {
    decaying: false,
    reason: null,
    detail:
      measured.length >= 2
        ? "holding its position"
        : "not enough measurements yet, and not old enough to be stale",
  };
}
