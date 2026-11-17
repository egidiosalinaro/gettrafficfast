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
  /** Off unless explicitly turned on: this spends money and publishes. */
  enabled: z.boolean().default(false),
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
   * Off by default: it calls a model (one fast-tier call per pushed article)
   * and changes published pages, and cost never switches itself on.
   */
  pushPage3: z.boolean().default(false),
});

export type AutomationSettings = z.infer<typeof AutomationSettings>;

export const DEFAULT_AUTOMATION_SETTINGS: AutomationSettings =
  AutomationSettings.parse({});

/**
 * Tolerant read: an unknown or malformed column must never break a page or a
 * sweep, it falls back to the defaults, which are "off".
 */
export function parseAutomationSettings(value: unknown): AutomationSettings {
  const parsed = AutomationSettings.safeParse(value ?? {});
  return parsed.success ? parsed.data : DEFAULT_AUTOMATION_SETTINGS;
}
