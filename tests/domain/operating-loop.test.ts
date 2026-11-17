import { describe, expect, it } from "vitest";
import { EMPTY_ONBOARDING_STATUS, buildOnboardingStatus } from "@/lib/onboarding";
import {
  citationRatesByEngine,
  describeOperatingLoop,
  describeReplies,
  emptyOperatingFacts,
  engineLabel,
  pickNextAction,
  type OperatingFacts,
} from "@/lib/domain/operating-loop";

function facts(over: Partial<OperatingFacts> = {}): OperatingFacts {
  return { ...emptyOperatingFacts(), ...over };
}

const ready = buildOnboardingStatus({
  hasBusiness: true,
  aboutYou: "I use it to write our weekly posts.",
  keywordCount: 8,
  articleCount: 4,
  integrationCount: 1,
  manualPostCount: 1,
  autopilotEnabled: true,
  imagesEnabled: true,
});

describe("pickNextAction", () => {
  it("asks for keywords before it asks anyone to look at the calendar", () => {
    const status = buildOnboardingStatus({
      hasBusiness: true,
      aboutYou: "I use it to write our weekly posts.",
      keywordCount: 0,
      articleCount: 0,
      integrationCount: 0,
      manualPostCount: 1,
      autopilotEnabled: false,
      imagesEnabled: false,
    });
    const action = pickNextAction(status, facts());
    expect(action?.id).toBe("hasKeywords");
    expect(action?.href).toBe("/content/topics");
  });

  it("puts failed articles ahead of the setup checklist", () => {
    const action = pickNextAction(ready, facts({ failedCount: 2 }));
    expect(action?.kind).toBe("attention");
    expect(action?.id).toBe("failed");
    expect(action?.href).toBe("/content/articles");
  });

  it("puts a quality-gate hold ahead of Autopilot", () => {
    const status = buildOnboardingStatus({
      hasBusiness: true,
      aboutYou: "I use it to write our weekly posts.",
      keywordCount: 4,
      articleCount: 1,
      integrationCount: 1,
      manualPostCount: 1,
      autopilotEnabled: false,
      imagesEnabled: false,
    });
    const action = pickNextAction(status, facts({ needsReviewCount: 1 }));
    expect(action?.id).toBe("needs_review");
  });

  it("is null when the site is set up and nothing needs a person", () => {
    expect(pickNextAction(ready, facts({ publishedCount: 3 }))).toBeNull();
  });

  it("asks for About you before keywords, with its own copy", () => {
    const status = buildOnboardingStatus({
      hasBusiness: true,
      aboutYou: "",
      keywordCount: 0,
      articleCount: 0,
      integrationCount: 0,
      manualPostCount: 0,
      autopilotEnabled: false,
      imagesEnabled: false,
    });
    const action = pickNextAction(status, facts());
    expect(action).toMatchObject({ kind: "onboarding", id: "hasAboutYou", href: "/settings/voice", cta: "Tell us about you" });
    expect(action?.title).toBeTruthy();
  });

  it("asks for the first post from X with its own copy", () => {
    const status = buildOnboardingStatus({
      hasBusiness: true,
      aboutYou: "I use it for our blog.",
      keywordCount: 3,
      articleCount: 1,
      integrationCount: 1,
      manualPostCount: 0,
      autopilotEnabled: false,
      imagesEnabled: false,
    });
    const action = pickNextAction(status, facts());
    expect(action).toMatchObject({ kind: "onboarding", id: "hasManualPost", href: "/today", title: "Add your first post from X" });
  });

  it("still names the business when the account has no site", () => {
    const action = pickNextAction(EMPTY_ONBOARDING_STATUS, facts());
    expect(action?.id).toBe("hasBusiness");
  });
});

describe("describeOperatingLoop", () => {
  it("does not treat an empty site as a 0% citation rate", () => {
    const loop = describeOperatingLoop(EMPTY_ONBOARDING_STATUS, facts());
    const measure = loop.stages.find((s) => s.id === "measure");
    expect(measure?.metric).toBe("not measured yet");
    expect(measure?.status).toBe("todo");
    expect(measure?.metric).not.toMatch(/0%/);
  });

  it("keeps a missing probe as not measured, even after publish", () => {
    const loop = describeOperatingLoop(
      ready,
      facts({
        publishedCount: 4,
        citationsByEngine: [],
        rankMeasured: 0,
      })
    );
    const measure = loop.stages.find((s) => s.id === "measure");
    expect(measure?.status).toBe("pending");
    expect(measure?.metric).toBe("not measured yet");
  });

  it("says 0% only when probes actually came back empty, and names the engine", () => {
    const loop = describeOperatingLoop(
      ready,
      facts({
        publishedCount: 4,
        citationsByEngine: [{ engine: "gemini", rate: 0, probes: 12, cited: 0 }],
        rankMeasured: 3,
        ranking: 2,
      })
    );
    const measure = loop.stages.find((s) => s.id === "measure");
    expect(measure?.status).toBe("active");
    expect(measure?.metric).toBe("Gemini 0%");
    expect(measure?.detail).toMatch(/12 probes/);
    expect(measure?.detail).toMatch(/sampled/);
  });

  it("shows one rate per engine and never their average", () => {
    const loop = describeOperatingLoop(
      ready,
      facts({
        publishedCount: 4,
        // Gemini 2 of 10, Perplexity 6 of 12: pooled would be 36%, the
        // mean of the two rates 35%. Neither number describes anything.
        citationsByEngine: [
          { engine: "gemini", rate: 0.2, probes: 10, cited: 2 },
          { engine: "perplexity", rate: 0.5, probes: 12, cited: 6 },
        ],
        rankMeasured: 2,
        ranking: 1,
      })
    );
    const measure = loop.stages.find((s) => s.id === "measure");
    expect(measure?.metric).toBe("Gemini 20% · Perplexity 50%");
    expect(measure?.metric).not.toMatch(/36%|35%/);
    expect(measure?.metric).not.toMatch(/gemini|perplexity/);
  });

  it("reads an engine with no samples as not measured, never 0%", () => {
    const loop = describeOperatingLoop(
      ready,
      facts({
        publishedCount: 2,
        citationsByEngine: [
          { engine: "gemini", rate: 0.25, probes: 4, cited: 1 },
          { engine: "perplexity", rate: null, probes: 0, cited: 0 },
        ],
        rankMeasured: 1,
      })
    );
    const measure = loop.stages.find((s) => s.id === "measure");
    // 4 probes are too few for a percent: the count, never "25%".
    expect(measure?.metric).toBe("Gemini 1 of 4 · Perplexity not measured");
  });

  it("shows a count below 10 probes and a percent from 10, engine by engine", () => {
    const loop = describeOperatingLoop(
      ready,
      facts({
        publishedCount: 2,
        citationsByEngine: [
          { engine: "gemini", rate: 0, probes: 3, cited: 0 },
          { engine: "perplexity", rate: 0.3, probes: 10, cited: 3 },
        ],
        rankMeasured: 1,
      })
    );
    const measure = loop.stages.find((s) => s.id === "measure");
    expect(measure?.metric).toBe("Gemini 0 of 3 · Perplexity 30%");
    expect(measure?.metric).not.toContain("Gemini 0%");
  });

  it("does not call unused keywords a ranking of zero", () => {
    const loop = describeOperatingLoop(
      ready,
      facts({
        keywordCount: 10,
        unusedKeywordCount: 10,
      })
    );
    const research = loop.stages.find((s) => s.id === "research");
    expect(research?.status).toBe("active");
    expect(research?.metric).toBe("10 keywords");
    expect(research?.detail).toMatch(/10 still unused/);
  });

  it("blocks publish when articles are written and nothing is connected", () => {
    const loop = describeOperatingLoop(
      buildOnboardingStatus({
        hasBusiness: true,
        aboutYou: "I use it to write our weekly posts.",
        keywordCount: 5,
        articleCount: 2,
        integrationCount: 0,
        manualPostCount: 1,
        autopilotEnabled: false,
        imagesEnabled: false,
      }),
      facts({
        keywordCount: 5,
        unusedKeywordCount: 3,
        generatedCount: 2,
        hasIntegration: false,
      })
    );
    const publish = loop.stages.find((s) => s.id === "publish");
    expect(publish?.status).toBe("blocked");
    expect(publish?.href).toBe("/settings/integrations");
    expect(loop.nextAction?.id).toBe("hasIntegration");
  });

  it("walks the five stages in product order", () => {
    const loop = describeOperatingLoop(ready, facts({ publishedCount: 1 }));
    expect(loop.stages.map((s) => s.id)).toEqual([
      "research",
      "plan",
      "produce",
      "publish",
      "measure",
    ]);
  });
});

describe("citationRatesByEngine", () => {
  it("pools probes per engine across articles, never across engines", () => {
    const rates = citationRatesByEngine([
      {
        citations: {
          byEngine: [
            { engine: "perplexity", rate: 1 / 3, probes: 3 },
            { engine: "gemini", rate: 0, probes: 2 },
          ],
        },
      },
      { citations: { byEngine: [{ engine: "perplexity", rate: 0.5, probes: 2 }] } },
      { citations: { byEngine: [] } },
    ]);
    expect(rates).toEqual([
      { engine: "gemini", rate: 0, probes: 2, cited: 0 },
      { engine: "perplexity", rate: 2 / 5, probes: 5, cited: 2 },
    ]);
  });

  it("is empty, not a zero, when nothing was probed", () => {
    expect(citationRatesByEngine([])).toEqual([]);
    expect(citationRatesByEngine([{ citations: { byEngine: [] } }])).toEqual([]);
  });
});

describe("engineLabel", () => {
  it("names the engine instead of printing its identifier", () => {
    expect(engineLabel("gemini")).toBe("Gemini");
    expect(engineLabel("perplexity")).toBe("Perplexity");
    expect(engineLabel("bing_copilot")).toBe("Bing copilot");
    expect(engineLabel("")).toBe("Unknown engine");
  });
});

describe("describeReplies", () => {
  it("puts waiting replies in front of the person, with the week's posted count", () => {
    const replies = describeReplies({ repliesWaiting: 2, repliesPostedLast7Days: 1 });
    expect(replies).toMatchObject({
      href: "/today",
      title: "Replies",
      status: "blocked",
      waiting: 2,
      postedLast7Days: 1,
      metric: "2 waiting",
    });
    expect(replies.detail).toMatch(/1 posted in the last 7 days/);
  });

  it("says nothing is waiting when nothing is, and counts what went out", () => {
    const quiet = describeReplies({ repliesWaiting: 0, repliesPostedLast7Days: 0 });
    expect(quiet.metric).toBe("nothing waiting");
    expect(quiet.status).toBe("todo");
    expect(quiet.detail).toBe("None posted in the last 7 days.");

    const busy = describeReplies({ repliesWaiting: 0, repliesPostedLast7Days: 3 });
    expect(busy.status).toBe("active");
    expect(busy.detail).toBe("3 posted in the last 7 days.");
  });

  it("does not turn an unreadable inbox into zero waiting", () => {
    const replies = describeReplies({ repliesWaiting: null, repliesPostedLast7Days: null });
    expect(replies.metric).toBe("not available");
    expect(replies.waiting).toBeNull();
    expect(replies.metric).not.toMatch(/0/);
  });

  it("rides along with the article stages, as its own row", () => {
    const loop = describeOperatingLoop(ready, facts({ repliesWaiting: 1, repliesPostedLast7Days: 0 }));
    expect(loop.replies?.metric).toBe("1 waiting");
    expect(loop.stages.map((s) => s.id)).not.toContain("replies");
  });
});
