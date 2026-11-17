/**
 * What an agent run costs when its cost was not recorded.
 *
 * `agent_runs.cost_usd` is null when nobody knows what the run cost: the
 * agent threw before it could report its usage (a provider error, a cut-off
 * call, a refusal), so the call may or may not have been billed. Counting
 * that as $0 would be the invented zero AGENTS.md §11 forbids, and for a
 * spending ceiling the wrong way round: a run that keeps failing would never
 * count against it. So the daily ceiling (lib/limits/spend.ts) counts each
 * such run at the conservative figure below, and every surface that shows
 * the total says that part is an estimate.
 *
 * The figures are per call, by agent, at about two to three times the
 * dearest run measured in production over the 60 days to 2026-11-10 (for
 * example `writing` on Claude Sonnet peaked at $0.059, `refresh-write` at
 * $0.081). `fast` applies when the row names a model of a cheap family
 * (Gemini Flash, Claude Haiku); anything else, an unknown model included,
 * gets `quality`, the dearer figure. An agent missing from the table gets
 * the dearest figure of all.
 */

export interface RunEstimate {
  /** A Flash or Haiku model answered. */
  fast: number;
  /** Any other model, or the model is not known. */
  quality: number;
}

export const UNMEASURED_RUN_ESTIMATES: Readonly<Record<string, RunEstimate>> = {
  writing: { fast: 0.03, quality: 0.15 },
  "refresh-write": { fast: 0.04, quality: 0.15 },
  outline: { fast: 0.02, quality: 0.06 },
  "placement-draft": { fast: 0.02, quality: 0.06 },
  "draft-correct": { fast: 0.02, quality: 0.05 },
  "propose-prompts": { fast: 0.02, quality: 0.05 },
  "aeo-audit": { fast: 0.02, quality: 0.04 },
  "placement-qualify": { fast: 0.01, quality: 0.03 },
  "knowledge-extract": { fast: 0.01, quality: 0.03 },
  "refresh-plan": { fast: 0.01, quality: 0.03 },
  "image-brief": { fast: 0.01, quality: 0.02 },
  "internal-links": { fast: 0.01, quality: 0.02 },
  "serp-analysis": { fast: 0.01, quality: 0.02 },
  "video-select": { fast: 0.01, quality: 0.02 },
};

/** For an agent the table does not list: the dearest figure in it. */
export const UNKNOWN_AGENT_ESTIMATE_USD = Math.max(
  ...Object.values(UNMEASURED_RUN_ESTIMATES).map((estimate) => estimate.quality)
);

/** Gemini Flash and Claude Haiku: the cheap families. */
function isFastModel(model: string | null | undefined): boolean {
  return /flash|haiku/i.test(model ?? "");
}

/** The conservative cost of one run whose cost was not recorded. */
export function estimateUnmeasuredRunUsd(agent: string | null | undefined, model: string | null | undefined): number {
  const estimate = agent ? UNMEASURED_RUN_ESTIMATES[agent] : undefined;
  if (!estimate) return UNKNOWN_AGENT_ESTIMATE_USD;
  return isFastModel(model) ? estimate.fast : estimate.quality;
}
