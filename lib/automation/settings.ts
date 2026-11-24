import { z } from "zod";

/**
 * Per-business autopilot preferences, stored in `businesses.automation_settings`.
 *
 * Two numbers do the work. `bufferDays` is how far ahead the calendar is kept
 * filled, and it doubles as the review window: an article scheduled two weeks
 * out is visible on the calendar for two weeks before anything is generated,
 * so it can be removed. `keywordFloor` is when the pool is topped up.
 *
 * Thresholds rather than a fixed daily quota on purpose. A quota keeps
 * producing for someone who is away for a month, and they come back to thirty
 * articles nobody asked for; a threshold produces only what the buffer needs.
 */

export const AutomationSettings = z.object({
  /**
   * On by default since 2026-11-24 (the owner: product features are on, the
   * person does not have to enable them). It fills the calendar the person
   * already had written and delivered on each article's day: publishing of
   * scheduled articles was already automatic, and nothing is delivered
   * without a destination the person connected. Every article sits on the
   * calendar `bufferDays` ahead and can be removed. The platform pays for the
   * writing, within the owner's paid access and AI limit. False is the
   * person's opt-out and is kept.
   */
  enabled: z.boolean().default(true),
  /** Days of calendar kept filled ahead. Also the window to cancel an article. */
  bufferDays: z.number().int().min(1).max(60).default(14),
  /** Below this many available keywords, generate more. */
  keywordFloor: z.number().int().min(0).max(200).default(10),
  /** Hard ceiling per run, so a bug cannot drain the budget. */
  maxKeywordsPerRun: z.number().int().min(1).max(25).default(10),
  /** Hard ceiling on articles scheduled per run, for the same reason. */
  maxSchedulesPerRun: z.number().int().min(1).max(30).default(14),
  /**
   * The back-link pass (docs/KNOWLEDGE.md): when an article is published, up
   * to 3 older published articles of the site that share its topics get ONE
   * link to it and are delivered again. Independent of `enabled`: it runs
   * for every published article, Autopilot or not.
   *
   * On by default because it costs pennies at most: no model call when the
   * older article already writes the new one's keyword, otherwise one
   * fast-tier call per older article (three at most, about $0.004 each).
   * False stops it for the site.
   */
  backLinks: z.boolean().default(true),
  /**
   * Push page 3 (docs/LIFECYCLE.md): once a week, up to 3 published
   * articles Google shows at positions 11 to 40 get a link from the site's
   * best related pages and a meta title and description that hold the
   * search they are shown for. Independent of `enabled`.
   *
   * On by default since 2026-11-24: one fast-tier model call per pushed
   * article, paid by the platform, and its changes go through the same
   * update path the back-link pass already uses on published articles. False
   * is the person's opt-out and is kept.
   */
  pushPage3: z.boolean().default(true),
});

export type AutomationSettings = z.infer<typeof AutomationSettings>;

export const DEFAULT_AUTOMATION_SETTINGS: AutomationSettings =
  AutomationSettings.parse({});

/**
 * Tolerant read: an unknown or malformed column must never break a page or a
 * sweep, it falls back to the defaults. A stored `false` is kept: it is the
 * person's opt-out.
 */
export function parseAutomationSettings(value: unknown): AutomationSettings {
  const parsed = AutomationSettings.safeParse(value ?? {});
  return parsed.success ? parsed.data : DEFAULT_AUTOMATION_SETTINGS;
}
