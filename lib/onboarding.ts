/**
 * Getting started checklist.
 *
 * The widget hides only when every step for the SELECTED site is done.
 * About you comes straight after the business: every reply is written as
 * someone who uses the product, and with nothing recorded there the drafter
 * refuses to write (lib/placements/workflow.ts, draftPrerequisite). The first
 * post from X is the placements loop's first step, done by a person.
 * Two of those steps spend money and stay off until someone switches them
 * on: Autopilot, and article images. Images come after Autopilot on
 * purpose — turning the calendar on without Images & video leaves a week of
 * text-only posts, which is what the last step exists to prevent.
 */

export type OnboardingStatus = {
  hasBusiness: boolean;
  hasAboutYou: boolean;
  hasKeywords: boolean;
  hasArticles: boolean;
  hasIntegration: boolean;
  hasManualPost: boolean;
  hasAutomation: boolean;
  hasImages: boolean;
};

export const EMPTY_ONBOARDING_STATUS: OnboardingStatus = {
  hasBusiness: false,
  hasAboutYou: false,
  hasKeywords: false,
  hasArticles: false,
  hasIntegration: false,
  hasManualPost: false,
  hasAutomation: false,
  hasImages: false,
};

export function buildOnboardingStatus(input: {
  hasBusiness: boolean;
  /** `parseVoiceSettings(business.voice_settings).aboutYou`. */
  aboutYou: string;
  keywordCount: number;
  articleCount: number;
  integrationCount: number;
  /** `placement_targets` rows of the site with `found_via` = MANUAL_SOURCE. */
  manualPostCount: number;
  autopilotEnabled: boolean;
  imagesEnabled: boolean;
}): OnboardingStatus {
  if (!input.hasBusiness) return { ...EMPTY_ONBOARDING_STATUS };
  return {
    hasBusiness: true,
    hasAboutYou: input.aboutYou.trim().length > 0,
    hasKeywords: input.keywordCount > 0,
    hasArticles: input.articleCount > 0,
    hasIntegration: input.integrationCount > 0,
    hasManualPost: input.manualPostCount > 0,
    hasAutomation: input.autopilotEnabled,
    hasImages: input.imagesEnabled,
  };
}

/**
 * The checklist the product walks a new site through. Home and the widget
 * share this list so "what to do next" cannot disagree with the corner card.
 *
 * Scheduling goes to Keywords, not the calendar: empty days are not a
 * picker. Keywords are added to the next free day from that list.
 */
export const ONBOARDING_STEPS = [
  {
    key: "hasBusiness" as const,
    label: "Set up your business",
    description: "We analyze your website to understand your niche.",
    href: "/settings/business",
  },
  {
    key: "hasAboutYou" as const,
    label: "Tell us about you",
    description: "One true sentence on how you use your product. Replies speak only from it.",
    href: "/settings/voice",
  },
  {
    key: "hasKeywords" as const,
    label: "Generate keywords",
    description: "AI proposes what your customers search for, from your site.",
    href: "/content/topics",
  },
  {
    key: "hasArticles" as const,
    label: "Schedule your first article",
    description: "Add a keyword to the calendar. It gets written automatically.",
    href: "/content/topics",
  },
  {
    key: "hasIntegration" as const,
    label: "Connect your website",
    description: "WordPress or webhook, so articles go live on your site.",
    href: "/settings/integrations",
  },
  {
    key: "hasManualPost" as const,
    label: "Add your first post from X",
    description: "Paste the link of a post worth answering. A reply is drafted; you post it.",
    href: "/today",
  },
  {
    key: "hasAutomation" as const,
    label: "Turn on Autopilot",
    description: "Keeps the calendar filled so publishing does not stop.",
    href: "/settings/automation",
  },
  {
    key: "hasImages" as const,
    label: "Turn on article images",
    description:
      "Otherwise every article goes out as plain text. Pick a look in Autopilot, under Images and video.",
    href: "/settings/automation#images",
  },
] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/**
 * Steps shown under the checklist, marked optional: they never count toward
 * "done" and never keep the widget open. Connecting Claude is a choice; the
 * app does everything on its own.
 */
export const OPTIONAL_ONBOARDING_STEPS = [
  {
    key: "hasClaude" as const,
    label: "Connect Claude",
    description: "Optional. Then ask Claude to \"Run my day\" or \"Review my week\".",
    href: "/settings/api-keys",
  },
] as const;

export type OptionalOnboardingStatus = Record<(typeof OPTIONAL_ONBOARDING_STEPS)[number]["key"], boolean>;

export function nextOnboardingStep(
  status: OnboardingStatus
): OnboardingStep | null {
  return ONBOARDING_STEPS.find((step) => !status[step.key]) ?? null;
}

// Lightweight cross-component signal so the "Getting started" checklist can
// refresh its status the moment an onboarding step is completed (keywords
// generated, article scheduled, ...) instead of only on a full page reload.

export const ONBOARDING_REFRESH_EVENT = "gtf:onboarding-refresh";

export function refreshOnboarding() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(ONBOARDING_REFRESH_EVENT));
  }
}
