import { DEFAULT_GROWTH_DAYS, type GrowthDays } from "./period";

/**
 * Where Growth lives, and the old addresses that lead there
 * (docs/LIFECYCLE.md, "Growth"). Results became `/growth` and Prompts
 * (AI Visibility) became `/growth/ai` on 2026-11-14; every old address
 * still answers, as a redirect in lib/legacy-redirects.ts that keeps its
 * query string.
 */

export const GROWTH_PATH = "/growth";
export const GROWTH_AI_PATH = "/growth/ai";
/** The question set and the visibility settings (engines, cadence, what counts as you). */
export const GROWTH_AI_SETTINGS_PATH = "/growth/ai/settings";
/** The public explanation of every number on Growth. */
export const HOW_WE_MEASURE_HREF = "/docs#how-we-measure";

export function questionPath(id: string): string {
  return `${GROWTH_AI_PATH}/queries/${encodeURIComponent(id)}`;
}

/** A page's `searchParams`, as Next.js hands them over. */
export type SearchParams = Record<string, string | string[] | undefined>;

/** A Growth address for a period: the default week needs no `days`. */
export function growthHref(path: string, days: GrowthDays, extra: Record<string, string | null | undefined> = {}): string {
  const query = new URLSearchParams();
  if (days !== DEFAULT_GROWTH_DAYS) query.set("days", String(days));
  for (const [key, value] of Object.entries(extra)) if (value) query.set(key, value);
  const qs = query.toString();
  return qs ? `${path}?${qs}` : path;
}
