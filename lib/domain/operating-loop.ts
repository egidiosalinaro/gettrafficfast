/**
 * The content operating loop as a customer sees it after login.
 *
 * The calendar is one board in this loop, not the product. Home is assembled
 * here so the dashboard, the API and the tests cannot drift into three
 * different stories about what the platform is doing.
 *
 * Measurements stay honest: a citation rate with no samples is null, never 0,
 * and rates are per engine. Engines disagree, so a rate averaged across them
 * describes nothing; the only cross-engine number here is a probe count.
 */

import { formatRate } from "@/lib/format";
import {
  nextOnboardingStep,
  type OnboardingStatus,
  type OnboardingStep,
} from "@/lib/onboarding";

export const LOOP_STAGES = [
  "research",
  "plan",
  "produce",
  "publish",
  "measure",
] as const;

export type LoopStageId = (typeof LOOP_STAGES)[number];

/** What the stage is doing, not a traffic-light of success. */
export type LoopStageStatus = "todo" | "active" | "pending" | "blocked";

/**
 * Display names for the answer engines `ai_citations.engine` records. The
 * stored value is an identifier; a customer reads "Gemini", not "gemini".
 * An engine added later still reads as a name, capitalised, until it gets an
 * entry here.
 */
const ENGINE_LABELS: Record<string, string> = {
  gemini: "Gemini",
  perplexity: "Perplexity",
};

export function engineLabel(engine: string): string {
  const known = ENGINE_LABELS[engine.trim().toLowerCase()];
  if (known) return known;
  const words = engine.trim().replaceAll("_", " ");
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Unknown engine";
}

/** One engine's citation rate across every probe of every article. */
export interface EngineCitationRate {
  engine: string;
  /** cited / probes for this engine, or null when it was never probed. */
  rate: number | null;
  probes: number;
  cited: number;
}

/**
 * Per-engine citation rates across articles, from each article's per-engine
 * summary (`summarizeCitations(...).byEngine`). Probes are pooled per engine,
 * never across engines: there is deliberately no overall rate here.
 *
 * `byEngine` carries the rate and the probe count; the cited count is that
 * product, rounded back to the integer it was divided from.
 */
export function citationRatesByEngine(
  articles: ReadonlyArray<{
    citations: { byEngine: ReadonlyArray<{ engine: string; rate: number; probes: number }> };
  }>
): EngineCitationRate[] {
  const pooled = new Map<string, { probes: number; cited: number }>();
  for (const article of articles) {
    for (const entry of article.citations.byEngine) {
      const bucket = pooled.get(entry.engine) ?? { probes: 0, cited: 0 };
      bucket.probes += entry.probes;
      bucket.cited += Math.round(entry.rate * entry.probes);
      pooled.set(entry.engine, bucket);
    }
  }
  return [...pooled.entries()]
    .map(([engine, b]) => ({
      engine,
      rate: b.probes === 0 ? null : b.cited / b.probes,
      probes: b.probes,
      cited: b.cited,
    }))
    .sort((a, b) => a.engine.localeCompare(b.engine));
}

export interface OperatingFacts {
  keywordCount: number;
  unusedKeywordCount: number;
  queuedCount: number;
  generatingCount: number;
  generatedCount: number;
  needsReviewCount: number;
  failedCount: number;
  publishedCount: number;
  hasIntegration: boolean;
  autopilotEnabled: boolean;
  /**
   * One entry per engine that was probed. Empty when nothing was probed; an
   * entry's rate of 0 means we asked and were not cited. Never averaged.
   */
  citationsByEngine: EngineCitationRate[];
  /** Articles with at least one rank sample. Zero means we have not looked. */
  rankMeasured: number;
  ranking: number;
  searchConsole: "absent" | "connected" | "error";
  /**
   * Replies drafted or held for review, waiting for the person to post them.
   * Null when the inbox could not be read: that is not "nothing waiting".
   */
  repliesWaiting: number | null;
  /** Replies marked as posted in the last 7 days. Null when not read. */
  repliesPostedLast7Days: number | null;
}

export interface LoopStageView {
  id: LoopStageId;
  status: LoopStageStatus;
  href: string;
  title: string;
  metric: string;
  detail: string;
}

export type NextActionKind = "onboarding" | "attention";

export interface NextAction {
  kind: NextActionKind;
  id: string;
  title: string;
  description: string;
  href: string;
  cta: string;
}

/**
 * The off-site half of the loop: answers to other people's posts, drafted
 * here and posted by the person. Its own row, not a sixth article stage.
 */
export interface RepliesView {
  status: LoopStageStatus;
  href: string;
  title: string;
  waiting: number | null;
  postedLast7Days: number | null;
  metric: string;
  detail: string;
}

export interface OperatingLoop {
  stages: LoopStageView[];
  /** Absent on a payload from a server older than the Replies row. */
  replies?: RepliesView;
  nextAction: NextAction | null;
}

const EMPTY_FACTS: OperatingFacts = {
  keywordCount: 0,
  unusedKeywordCount: 0,
  queuedCount: 0,
  generatingCount: 0,
  generatedCount: 0,
  needsReviewCount: 0,
  failedCount: 0,
  publishedCount: 0,
  hasIntegration: false,
  autopilotEnabled: false,
  citationsByEngine: [],
  rankMeasured: 0,
  ranking: 0,
  searchConsole: "absent",
  repliesWaiting: 0,
  repliesPostedLast7Days: 0,
};

export function emptyOperatingFacts(): OperatingFacts {
  return { ...EMPTY_FACTS, citationsByEngine: [] };
}

function measuredEngines(facts: OperatingFacts): EngineCitationRate[] {
  return facts.citationsByEngine.filter((e) => e.probes > 0);
}

/**
 * "Gemini 20% · Perplexity 1 of 4": one rate per engine, side by side, a
 * count below `MIN_PROBES_FOR_PERCENT` probes (lib/format.ts).
 */
function citationMetric(facts: OperatingFacts): string {
  if (measuredEngines(facts).length === 0) return "not measured yet";
  return facts.citationsByEngine
    .map((e) => {
      const shown = e.rate === null ? null : formatRate(e.cited, e.probes);
      return shown === null ? `${engineLabel(e.engine)} not measured` : `${engineLabel(e.engine)} ${shown}`;
    })
    .join(" · ");
}

function describeResearch(facts: OperatingFacts): LoopStageView {
  if (facts.keywordCount === 0) {
    return {
      id: "research",
      status: "todo",
      href: "/content/topics",
      title: "Research",
      metric: "no keywords yet",
      detail:
        "The agent reads the site and proposes queries. An article is an output of that list, never the starting point.",
    };
  }

  const unused =
    facts.unusedKeywordCount === 1
      ? "1 still unused"
      : `${facts.unusedKeywordCount} still unused`;

  return {
    id: "research",
    status: "active",
    href: "/content/topics",
    title: "Research",
    metric:
      facts.keywordCount === 1 ? "1 keyword" : `${facts.keywordCount} keywords`,
    detail: `${unused}. Volumes and difficulty are model estimates, labelled as such in the list.`,
  };
}

function describePlan(facts: OperatingFacts): LoopStageView {
  const onCalendar =
    facts.queuedCount +
    facts.generatingCount +
    facts.generatedCount +
    facts.needsReviewCount +
    facts.failedCount +
    facts.publishedCount;

  if (onCalendar === 0) {
    return {
      id: "plan",
      status: "todo",
      href: "/content",
      title: "Plan",
      metric: "calendar empty",
      detail: facts.autopilotEnabled
        ? "Autopilot is on, so empty days ahead will be filled from the keyword pool."
        : "Keywords become one article a day on the calendar. Autopilot, if you turn it on, keeps that filled.",
    };
  }

  return {
    id: "plan",
    status: "active",
    href: "/content",
    title: "Plan",
    metric: onCalendar === 1 ? "1 on the calendar" : `${onCalendar} on the calendar`,
    detail: facts.autopilotEnabled
      ? "Autopilot keeps empty days ahead filled from the pool."
      : "The calendar is the production board: one keyword a day, written then published.",
  };
}

function describeProduce(facts: OperatingFacts): LoopStageView {
  if (facts.failedCount > 0) {
    return {
      id: "produce",
      status: "blocked",
      href: "/content",
      title: "Produce",
      metric:
        facts.failedCount === 1
          ? "1 article failed"
          : `${facts.failedCount} articles failed`,
      detail: "Open the card and re-queue it. Nothing is published from a failed run.",
    };
  }

  if (facts.needsReviewCount > 0) {
    return {
      id: "produce",
      status: "blocked",
      href: "/content",
      title: "Produce",
      metric:
        facts.needsReviewCount === 1
          ? "1 needs review"
          : `${facts.needsReviewCount} need review`,
      detail:
        "A quality gate held the document back. Read it, then publish or send it back.",
    };
  }

  if (facts.generatingCount > 0) {
    return {
      id: "produce",
      status: "active",
      href: "/content",
      title: "Produce",
      metric:
        facts.generatingCount === 1
          ? "1 writing now"
          : `${facts.generatingCount} writing now`,
      detail: "Outline, research, writing and gates run as a job, not as a single prompt.",
    };
  }

  if (facts.generatedCount > 0) {
    return {
      id: "produce",
      status: "active",
      href: "/content",
      title: "Produce",
      metric:
        facts.generatedCount === 1
          ? "1 ready to publish"
          : `${facts.generatedCount} ready to publish`,
      detail: facts.hasIntegration
        ? "Written and through the gates. Publishing is the next hop."
        : "Written, but nothing is connected to receive them yet.",
    };
  }

  if (facts.queuedCount > 0) {
    return {
      id: "produce",
      status: "pending",
      href: "/content",
      title: "Produce",
      metric:
        facts.queuedCount === 1
          ? "1 queued"
          : `${facts.queuedCount} queued`,
      detail: "The daily run picks the next queued day at 08:00 UTC.",
    };
  }

  if (facts.publishedCount > 0) {
    return {
      id: "produce",
      status: "active",
      href: "/content",
      title: "Produce",
      metric: "caught up",
      detail: "Nothing is in the writer right now. New days land as keywords are scheduled.",
    };
  }

  return {
    id: "produce",
    status: "todo",
    href: "/content",
    title: "Produce",
    metric: "not writing yet",
    detail: "Schedule a keyword and the daily job researches, writes and gates the article.",
  };
}

function describePublish(facts: OperatingFacts): LoopStageView {
  const waitingToGoLive = facts.generatedCount + facts.needsReviewCount;

  if (!facts.hasIntegration && waitingToGoLive > 0) {
    return {
      id: "publish",
      status: "blocked",
      href: "/settings/integrations",
      title: "Publish",
      metric: "site not connected",
      detail:
        "Articles are written. Connect WordPress or a webhook so they can go live on your site.",
    };
  }

  if (facts.publishedCount > 0) {
    return {
      id: "publish",
      status: "active",
      href: "/settings/integrations",
      title: "Publish",
      metric:
        facts.publishedCount === 1
          ? "1 live"
          : `${facts.publishedCount} live`,
      detail: facts.hasIntegration
        ? "Live articles went through the same adapters as every other destination."
        : "Some articles are marked live. A connected destination is what keeps that automatic.",
    };
  }

  if (!facts.hasIntegration) {
    return {
      id: "publish",
      status: "todo",
      href: "/settings/integrations",
      title: "Publish",
      metric: "site not connected",
      detail: "WordPress or a webhook. Webflow and Shopify are listed as coming soon and are not connected.",
    };
  }

  return {
    id: "publish",
    status: "pending",
    href: "/settings/integrations",
    title: "Publish",
    metric: "connected, nothing live yet",
    detail: "The destination is ready. Publishing starts when an article passes the gates.",
  };
}

function describeMeasure(facts: OperatingFacts): LoopStageView {
  if (facts.publishedCount === 0) {
    return {
      id: "measure",
      status: "todo",
      href: "/growth",
      title: "Measure",
      metric: "not measured yet",
      detail:
        "Rank and citation probes start after something is live. A missing number is not a zero.",
    };
  }

  const rankLine =
    facts.rankMeasured === 0
      ? "Rank has not been sampled yet."
      : facts.ranking === 0
        ? `Rank sampled on ${facts.rankMeasured}, none currently holding a position.`
        : `${facts.ranking} currently ranking` +
          (facts.rankMeasured === facts.ranking
            ? "."
            : ` of ${facts.rankMeasured} sampled.`);

  const consoleLine =
    facts.searchConsole === "absent"
      ? " Search Console is not connected, so clicks are not counted here."
      : facts.searchConsole === "error"
        ? " The Search Console connection needs attention."
        : "";

  const engines = measuredEngines(facts);

  if (engines.length === 0 && facts.rankMeasured === 0) {
    return {
      id: "measure",
      status: "pending",
      href: "/growth",
      title: "Measure",
      metric: "not measured yet",
      detail: `Articles are live, and no probe or rank sample has landed yet.${consoleLine}`,
    };
  }

  const probes = engines.reduce((sum, e) => sum + e.probes, 0);
  const probeLine =
    engines.length === 0
      ? "Citation probes have not run yet; that is not a 0% rate."
      : `Cited share per engine, from ${probes} ${probes === 1 ? "probe" : "probes"}, sampled, not ground truth.`;

  return {
    id: "measure",
    status: "active",
    href: "/growth",
    title: "Measure",
    metric: citationMetric(facts),
    detail: `${rankLine} ${probeLine}${consoleLine}`.trim(),
  };
}

export function describeReplies(
  facts: Pick<OperatingFacts, "repliesWaiting" | "repliesPostedLast7Days">
): RepliesView {
  const base = {
    href: "/today",
    title: "Replies",
    waiting: facts.repliesWaiting,
    postedLast7Days: facts.repliesPostedLast7Days,
  };

  if (facts.repliesWaiting === null) {
    return {
      ...base,
      status: "pending",
      metric: "not available",
      detail: "The reply inbox could not be read just now. Open it to see what is waiting.",
    };
  }

  const posted =
    facts.repliesPostedLast7Days === null
      ? "Posted replies could not be counted."
      : facts.repliesPostedLast7Days === 0
        ? "None posted in the last 7 days."
        : `${facts.repliesPostedLast7Days} posted in the last 7 days.`;

  if (facts.repliesWaiting > 0) {
    return {
      ...base,
      status: "blocked",
      metric: `${facts.repliesWaiting} waiting`,
      detail: `Drafted and ready for you to post. ${posted}`,
    };
  }

  return {
    ...base,
    status: (facts.repliesPostedLast7Days ?? 0) > 0 ? "active" : "todo",
    metric: "nothing waiting",
    detail: posted,
  };
}

function onboardingAction(step: OnboardingStep): NextAction {
  const copy: Record<
    OnboardingStep["key"],
    { title: string; description: string; cta: string }
  > = {
    hasBusiness: {
      title: "Set up the site this loop is for",
      description:
        "Paste the website URL. The agent reads it and writes from that description, not from a blank page.",
      cta: "Set up business",
    },
    hasAboutYou: {
      title: "Tell us how you use the product",
      description:
        "One true sentence in Settings, Voice, About you. Replies are written as someone who uses it, and speak only from what is recorded there.",
      cta: "Tell us about you",
    },
    hasImageStyle: {
      title: "Choose how your article images look",
      description:
        "Articles get a featured image, included in your plan, once you pick a style. Until then they go out without images.",
      cta: "Choose a style",
    },
    hasKeywords: {
      title: "Propose keywords for this site",
      description:
        "The agent reads the business profile and suggests queries. Volumes are model estimates, labelled as such.",
      cta: "Generate keywords",
    },
    hasArticles: {
      title: "Put a keyword on the calendar",
      description:
        "That is what turns the list into one article a day. The calendar is the production board, not the strategy.",
      cta: "Schedule an article",
    },
    hasIntegration: {
      title: "Connect the site that should receive articles",
      description:
        "WordPress or a webhook. Without a destination, articles stay on the calendar after they are written.",
      cta: "Connect your site",
    },
    hasXAccount: {
      title: "Connect the X account GTF posts from",
      description:
        "Sign in on X once. A reply to a post that mentions or quotes you then posts with one press; replies to everyone else still open in X for you. GTF never posts on its own.",
      cta: "Connect X",
    },
    hasManualPost: {
      title: "Add your first post from X",
      description:
        "Paste the link of a fresh post worth answering. A reply is drafted from it; nothing goes out until you post it yourself.",
      cta: "Add a post",
    },
  };

  const text = copy[step.key];
  return {
    kind: "onboarding",
    id: step.key,
    title: text.title,
    description: text.description,
    href: step.href,
    cta: text.cta,
  };
}

export function pickNextAction(
  onboarding: OnboardingStatus,
  facts: Pick<OperatingFacts, "needsReviewCount" | "failedCount">
): NextAction | null {
  if (facts.failedCount > 0) {
    return {
      kind: "attention",
      id: "failed",
      title:
        facts.failedCount === 1
          ? "An article failed to generate"
          : `${facts.failedCount} articles failed to generate`,
      description:
        "Open the calendar card and re-queue it. A failed run is never published.",
      href: "/content",
      cta: "Open the calendar",
    };
  }

  if (facts.needsReviewCount > 0) {
    return {
      kind: "attention",
      id: "needs_review",
      title:
        facts.needsReviewCount === 1
          ? "An article is waiting for review"
          : `${facts.needsReviewCount} articles are waiting for review`,
      description:
        "A quality gate held it back. Read it, then publish it or send it back. Losing a publication beats publishing a broken document.",
      href: "/content",
      cta: "Open the calendar",
    };
  }

  const step = nextOnboardingStep(onboarding);
  if (step) return onboardingAction(step);
  return null;
}

export function describeOperatingLoop(
  onboarding: OnboardingStatus,
  facts: OperatingFacts
): OperatingLoop {
  return {
    stages: [
      describeResearch(facts),
      describePlan(facts),
      describeProduce(facts),
      describePublish(facts),
      describeMeasure(facts),
    ],
    replies: describeReplies(facts),
    nextAction: pickNextAction(onboarding, facts),
  };
}
