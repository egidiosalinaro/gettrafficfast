import { describe, expect, it } from "vitest";
import {
  compareProviders,
  ComparisonInput,
  ComparisonJob,
  ComparisonRun,
  MIN_SAMPLES,
} from "@/lib/content/provider-comparison";

/**
 * The comparison's arithmetic. What it must never do: turn "not measured"
 * into 0, average a run the fallback answered into the arm it ran under,
 * call a handful of articles enough, count search traffic before 28 days of
 * it exist, or name a winner.
 */

const EMPTY: ComparisonInput = { jobs: [], runs: [], publications: [], metrics: [], syncedThrough: null };

function job(over: Partial<ComparisonJob> & { jobId: string; arm: string | null }): ComparisonJob {
  return {
    articleId: `article-${over.jobId}`,
    createdAt: "2026-11-10T08:00:00.000Z",
    outcome: "settled",
    settledAs: "generated",
    gateIssuesBeforeRevision: 0,
    revisionNeeded: false,
    wordCount: 1500,
    auditScore: 80,
    ...over,
  };
}

function run(jobId: string, agent: string, provider: string | null, over: Partial<ComparisonRun> = {}): ComparisonRun {
  return {
    jobId,
    agent,
    status: "completed",
    costUsd: 0.01,
    latencyMs: 1000,
    calls: provider === null ? null : [{ provider, model: `${provider}-model`, fallback: false }],
    ...over,
  };
}

describe("compareProviders", () => {
  it("answers no arm, and not enough samples, for nothing", () => {
    const out = compareProviders(EMPTY);
    expect(out.arms).toEqual([]);
    expect(out.enoughSamples).toBe(false);
    expect(out.auditJudgedBySameProvider).toBe(true);
    expect(out.minSamples).toBe(10);
  });

  it("averages cost and duration over the runs the arm's own provider answered", () => {
    const out = compareProviders({
      ...EMPTY,
      jobs: [job({ jobId: "a", arm: "anthropic" }), job({ jobId: "b", arm: "anthropic" })],
      runs: [
        run("a", "outline", "anthropic", { costUsd: 0.002, latencyMs: 4000 }),
        run("b", "outline", "anthropic", { costUsd: 0.004, latencyMs: 6000 }),
        run("a", "writing", "anthropic", { costUsd: 0.05, latencyMs: 30_000 }),
      ],
    });
    const arm = out.arms[0];
    expect(arm.provider).toBe("anthropic");
    expect(arm.agents.map((a) => a.agent)).toEqual(["outline", "writing"]);
    expect(arm.agents[0]).toMatchObject({
      samples: 2,
      fallbackRuns: 0,
      failedRuns: 0,
      unattributedRuns: 0,
      avgCostUsd: 0.003,
      avgDurationMs: 5000,
      models: [{ model: "anthropic-model", runs: 2 }],
      enoughSamples: false,
    });
    expect(arm.agents[1]).toMatchObject({ samples: 1, avgCostUsd: 0.05, avgDurationMs: 30_000 });
  });

  it("counts a run the fallback answered apart and keeps it out of every average", () => {
    // An Anthropic day on which the account refused for billing: Gemini wrote.
    const out = compareProviders({
      ...EMPTY,
      jobs: [job({ jobId: "a", arm: "anthropic" }), job({ jobId: "b", arm: "anthropic" })],
      runs: [
        run("a", "writing", "anthropic", { costUsd: 0.05, latencyMs: 30_000 }),
        run("b", "writing", "gemini", {
          costUsd: 0.5,
          latencyMs: 90_000,
          calls: [{ provider: "gemini", model: "gemini-2.5-pro", fallback: true }],
        }),
      ],
    });
    const writing = out.arms[0].agents[0];
    expect(writing).toMatchObject({ samples: 1, fallbackRuns: 1, avgCostUsd: 0.05, avgDurationMs: 30_000 });
    expect(writing.models).toEqual([{ model: "anthropic-model", runs: 1 }]);
    // The fallback's runs are not credited to the other arm either: there is no Gemini job here.
    expect(out.arms.map((a) => a.provider)).toEqual(["anthropic"]);
  });

  it("treats a run partly answered by the fallback as a fallback run", () => {
    const out = compareProviders({
      ...EMPTY,
      jobs: [job({ jobId: "a", arm: "gemini" })],
      runs: [
        run("a", "image-brief", "gemini", {
          calls: [
            { provider: "gemini", model: "gemini-2.5-flash", fallback: false },
            { provider: "anthropic", model: "claude-haiku-5-5", fallback: true },
          ],
        }),
      ],
    });
    expect(out.arms[0].agents[0]).toMatchObject({ samples: 0, fallbackRuns: 1, avgCostUsd: null, avgDurationMs: null });
  });

  it("answers null, never 0, for an agent with no sampled run", () => {
    const out = compareProviders({
      ...EMPTY,
      jobs: [job({ jobId: "a", arm: "gemini" })],
      runs: [
        run("a", "outline", null, { status: "failed", costUsd: null }),
        run("a", "aeo-audit", null),
      ],
    });
    const [audit, outline] = out.arms[0].agents;
    expect(outline).toMatchObject({ samples: 0, failedRuns: 1, avgCostUsd: null, avgDurationMs: null, models: [] });
    expect(audit).toMatchObject({ samples: 0, unattributedRuns: 1, avgCostUsd: null, avgDurationMs: null });
  });

  it("says when the provider stepped down its own chain, and still counts the run as its own", () => {
    const out = compareProviders({
      ...EMPTY,
      jobs: [job({ jobId: "a", arm: "gemini" })],
      runs: [run("a", "writing", "gemini", { calls: [{ provider: "gemini", model: "gemini-2.5-flash", fallback: true }] })],
    });
    expect(out.arms[0].agents[0]).toMatchObject({ samples: 1, fallbackRuns: 0, steppedDownRuns: 1 });
  });

  it("leaves a sampled run with no recorded cost out of the cost average only", () => {
    const out = compareProviders({
      ...EMPTY,
      jobs: [job({ jobId: "a", arm: "gemini" })],
      runs: [
        run("a", "outline", "gemini", { costUsd: null, latencyMs: 2000 }),
        run("a", "outline", "gemini", { costUsd: 0.004, latencyMs: 4000 }),
      ],
    });
    expect(out.arms[0].agents[0]).toMatchObject({ samples: 2, avgCostUsd: 0.004, avgDurationMs: 3000 });
  });

  it("summarises the articles of an arm, with each rate over what it can be said of", () => {
    const out = compareProviders({
      ...EMPTY,
      jobs: [
        job({ jobId: "1", arm: "gemini", gateIssuesBeforeRevision: 2, revisionNeeded: true, wordCount: 1400, auditScore: 70 }),
        job({ jobId: "2", arm: "gemini", settledAs: "needs_review", gateIssuesBeforeRevision: 4, revisionNeeded: true, wordCount: 1600, auditScore: 60 }),
        job({ jobId: "3", arm: "gemini", gateIssuesBeforeRevision: 0, revisionNeeded: false, wordCount: 1500, auditScore: 90 }),
        // Settled by a hold, outside the settle step: a draft exists, how it was judged is not known.
        job({ jobId: "4", arm: "gemini", settledAs: null, gateIssuesBeforeRevision: null, revisionNeeded: null, wordCount: null, auditScore: null }),
        job({ jobId: "5", arm: "gemini", outcome: "skipped", settledAs: null, gateIssuesBeforeRevision: null, revisionNeeded: null, wordCount: null, auditScore: null }),
        job({ jobId: "6", arm: "gemini", outcome: "failed", settledAs: null, gateIssuesBeforeRevision: null, revisionNeeded: null, wordCount: null, auditScore: null }),
        job({ jobId: "7", arm: "gemini", outcome: "unfinished", settledAs: null, gateIssuesBeforeRevision: null, revisionNeeded: null, wordCount: null, auditScore: null }),
      ],
      runs: ["1", "2", "3"].map((id) => run(id, "aeo-audit", "gemini")),
    });
    expect(out.arms[0].articles).toEqual({
      count: 6,
      settled: 4,
      skipped: 1,
      failed: 1,
      skippedOrFailedRate: 0.3333,
      neededRevisionRate: 0.6667,
      needsReviewRate: 0.3333,
      avgGateIssuesBeforeRevision: 2,
      avgWordCount: 1500,
      auditScore: 73.3,
      auditScoreSamples: 3,
      auditJudgedBySameProvider: true,
    });
  });

  it("answers null rates for an arm whose jobs never got far enough", () => {
    const out = compareProviders({
      ...EMPTY,
      jobs: [job({ jobId: "1", arm: "gemini", outcome: "unfinished", settledAs: null, gateIssuesBeforeRevision: null, revisionNeeded: null, wordCount: null, auditScore: null })],
    });
    expect(out.arms[0].articles).toMatchObject({
      count: 0,
      skippedOrFailedRate: null,
      neededRevisionRate: null,
      needsReviewRate: null,
      avgGateIssuesBeforeRevision: null,
      avgWordCount: null,
      auditScore: null,
      auditScoreSamples: 0,
    });
  });

  it("keeps an audit score the fallback gave out of the arm's average: it is the other provider's opinion", () => {
    const out = compareProviders({
      ...EMPTY,
      jobs: [job({ jobId: "1", arm: "anthropic", auditScore: 95 }), job({ jobId: "2", arm: "anthropic", auditScore: 55 })],
      runs: [run("1", "aeo-audit", "anthropic"), run("2", "aeo-audit", "gemini")],
    });
    expect(out.arms[0].articles).toMatchObject({ auditScore: 95, auditScoreSamples: 1, auditJudgedBySameProvider: true });
  });

  it("says enoughSamples only from 10 articles per arm, on at least two arms", () => {
    const many = (arm: string, n: number) =>
      Array.from({ length: n }, (_, i) => job({ jobId: `${arm}-${i}`, arm }));
    const runsFor = (jobs: ComparisonJob[]) => jobs.map((j) => run(j.jobId, "writing", j.arm));

    const lopsided = [...many("gemini", MIN_SAMPLES), ...many("anthropic", MIN_SAMPLES - 1)];
    let out = compareProviders({ ...EMPTY, jobs: lopsided, runs: runsFor(lopsided) });
    expect(out.arms.map((a) => [a.provider, a.enoughSamples])).toEqual([
      ["anthropic", false],
      ["gemini", true],
    ]);
    expect(out.enoughSamples).toBe(false);
    expect(out.arms[1].agents[0].enoughSamples).toBe(true);
    expect(out.arms[0].agents[0].enoughSamples).toBe(false);

    const even = [...many("gemini", MIN_SAMPLES), ...many("anthropic", MIN_SAMPLES)];
    out = compareProviders({ ...EMPTY, jobs: even, runs: runsFor(even) });
    expect(out.enoughSamples).toBe(true);

    // One arm alone compares with nothing.
    const alone = many("gemini", 30);
    expect(compareProviders({ ...EMPTY, jobs: alone }).enoughSamples).toBe(false);
  });

  it("ignores jobs that ran without a rotation", () => {
    const out = compareProviders({
      ...EMPTY,
      jobs: [job({ jobId: "1", arm: null }), job({ jobId: "2", arm: "gemini" })],
      runs: [run("1", "writing", "anthropic"), run("2", "writing", "gemini")],
    });
    expect(out.arms.map((a) => a.provider)).toEqual(["gemini"]);
    expect(out.arms[0].articles.count).toBe(1);
  });

  it("declares no winner anywhere in the answer", () => {
    const out = compareProviders({
      ...EMPTY,
      jobs: [job({ jobId: "1", arm: "gemini" }), job({ jobId: "2", arm: "anthropic" })],
    });
    const keys = JSON.stringify(out).match(/"[a-zA-Z]+":/g) ?? [];
    expect(keys.filter((key) => /winner|best|better|recommend/i.test(key))).toEqual([]);
    expect(out.notes.join(" ")).toMatch(/No winner is declared/);
    expect(out.notes.join(" ")).toMatch(/not a neutral measure/);
  });
});

describe("compareProviders: search traffic after publication", () => {
  const base = (over: Partial<ComparisonInput>): ComparisonInput => ({
    ...EMPTY,
    jobs: [job({ jobId: "1", arm: "gemini", articleId: "art-1", createdAt: "2026-10-01T06:00:00.000Z" })],
    publications: [{ articleId: "art-1", publishedOn: "2026-10-01", refreshedOn: null }],
    ...over,
  });
  const day = (capturedOn: string, impressions: number, clicks: number, position: number | null = 10) => ({
    articleId: "art-1",
    capturedOn,
    impressions,
    clicks,
    position,
  });

  it("measures an article only once its first 28 days are ingested", () => {
    // Published 1 October: the window is 1 to 28 October.
    const waiting = compareProviders(base({ syncedThrough: "2026-10-27", metrics: [day("2026-10-05", 100, 4)] }));
    expect(waiting.arms[0].downstream).toEqual({
      windowDays: 28,
      measuredArticles: 0,
      waitingArticles: 1,
      excludedArticles: 0,
      impressions: null,
      clicks: null,
      impressionsPerArticle: null,
      clicksPerArticle: null,
      averagePosition: null,
    });

    const measured = compareProviders(
      base({
        syncedThrough: "2026-10-28",
        metrics: [
          day("2026-09-30", 999, 99), // before publication
          day("2026-10-01", 100, 4, 12),
          day("2026-10-28", 300, 6, 8),
          day("2026-10-29", 999, 99), // day 29
        ],
      })
    );
    expect(measured.arms[0].downstream).toMatchObject({
      measuredArticles: 1,
      waitingArticles: 0,
      impressions: 400,
      clicks: 10,
      impressionsPerArticle: 400,
      clicksPerArticle: 10,
      // (12 * 100 + 8 * 300) / 400
      averagePosition: 9,
    });
  });

  it("answers null without Search Console, and 0 for an article measured and never shown", () => {
    expect(compareProviders(base({ syncedThrough: null })).arms[0].downstream).toMatchObject({
      measuredArticles: 0,
      waitingArticles: 1,
      impressions: null,
      averagePosition: null,
    });
    // 28 days ingested and not one row: asked, and not shown. A stored zero, not a gap.
    expect(compareProviders(base({ syncedThrough: "2026-11-05" })).arms[0].downstream).toMatchObject({
      measuredArticles: 1,
      impressions: 0,
      clicks: 0,
      impressionsPerArticle: 0,
      averagePosition: null,
    });
  });

  it("leaves out a page that is not the arm's draft: regenerated after publication, or refreshed inside the window", () => {
    const refreshed = compareProviders(
      base({
        syncedThrough: "2026-11-05",
        publications: [{ articleId: "art-1", publishedOn: "2026-10-01", refreshedOn: "2026-10-20" }],
        metrics: [day("2026-10-05", 100, 4)],
      })
    );
    expect(refreshed.arms[0].downstream).toMatchObject({ measuredArticles: 0, excludedArticles: 1, impressions: null });

    const regenerated = compareProviders(
      base({
        syncedThrough: "2026-11-05",
        jobs: [job({ jobId: "1", arm: "gemini", articleId: "art-1", createdAt: "2026-10-03T06:00:00.000Z" })],
      })
    );
    expect(regenerated.arms[0].downstream).toMatchObject({ measuredArticles: 0, excludedArticles: 1 });
  });

  it("credits a published article to the arm of its latest settled job only", () => {
    const out = compareProviders({
      ...EMPTY,
      syncedThrough: "2026-11-05",
      jobs: [
        job({ jobId: "old", arm: "anthropic", articleId: "art-1", createdAt: "2026-09-28T06:00:00.000Z" }),
        job({ jobId: "new", arm: "gemini", articleId: "art-1", createdAt: "2026-09-30T06:00:00.000Z" }),
        // Written last without a rotation: belongs to no arm.
        job({ jobId: "x", arm: "anthropic", articleId: "art-2", createdAt: "2026-09-28T06:00:00.000Z" }),
        job({ jobId: "y", arm: null, articleId: "art-2", createdAt: "2026-09-30T06:00:00.000Z" }),
      ],
      publications: [
        { articleId: "art-1", publishedOn: "2026-10-01", refreshedOn: null },
        { articleId: "art-2", publishedOn: "2026-10-01", refreshedOn: null },
      ],
      metrics: [day("2026-10-05", 50, 2)],
    });
    const byArm = Object.fromEntries(out.arms.map((a) => [a.provider, a.downstream]));
    expect(byArm.gemini).toMatchObject({ measuredArticles: 1, impressions: 50, clicks: 2 });
    expect(byArm.anthropic).toMatchObject({ measuredArticles: 0, impressions: null, clicks: null });
  });
});
