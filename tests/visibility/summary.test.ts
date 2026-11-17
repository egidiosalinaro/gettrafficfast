import { describe, expect, it } from "vitest";
import { newQueries, normalizeQuery, queryFingerprint } from "@/lib/visibility/queries";
import {
  changeBetween,
  compareRuns,
  describeVisibility,
  queryHistory,
  queryRows,
  recurringCompetitors,
  recurringSources,
  summarizeRun,
  type ProbeRecord,
  type RunRecord,
} from "@/lib/visibility/summary";

/**
 * The dashboard's numbers. The contract is the one every measurement in this
 * codebase shares: an unmeasured thing is null, not zero; rates are per engine;
 * two runs are only a trend when they asked the same questions of the same
 * engines, and the UI is told when they did not.
 */

const probe = (over: Partial<ProbeRecord> = {}): ProbeRecord => ({
  id: "p",
  runId: "run-2",
  queryId: "q1",
  query: "best ai seo tool",
  cluster: "tools",
  engine: "gemini",
  model: "gemini-2.5-flash",
  status: "not_cited",
  cited: false,
  sourceUrl: null,
  position: null,
  mentioned: false,
  answerExcerpt: "…",
  sources: [],
  competitors: [],
  error: null,
  latencyMs: 1200,
  probeVersion: 1,
  checkedAt: "2026-09-21T06:00:00Z",
  ...over,
});

const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  id: "run-2",
  status: "completed",
  trigger: "manual",
  engines: ["gemini"],
  queryCount: 2,
  queryFingerprint: "abc",
  plannedProbes: 2,
  startedAt: "2026-09-21T06:00:00Z",
  finishedAt: "2026-09-21T06:05:00Z",
  error: null,
  ...over,
});

describe("summarizeRun", () => {
  it("reports null rates over an empty run, never 0%", () => {
    const summary = summarizeRun({ id: "run-2" }, []);
    expect(summary.engines).toEqual([]);
    expect(summary.planned).toBe(0);
  });

  it("excludes invalid and errored probes from the rate but counts them in coverage", () => {
    const summary = summarizeRun({ id: "run-2" }, [
      probe({ id: "a", status: "cited", cited: true }),
      probe({ id: "b", query: "q2", status: "not_cited" }),
      probe({ id: "c", query: "q3", status: "invalid", cited: null }),
      probe({ id: "d", query: "q4", status: "error", cited: null }),
    ]);
    const gemini = summary.engines[0];
    expect(gemini.valid).toBe(2);
    expect(gemini.rate).toBeCloseTo(0.5);
    expect(gemini.coverage).toBeCloseTo(0.5);
    expect(gemini.invalid).toBe(1);
    expect(gemini.errors).toBe(1);
    expect(summary.queriesMeasured).toBe(2);
    expect(summary.queriesCited).toBe(1);
  });

  it("reports a null rate for an engine whose probes all failed", () => {
    const summary = summarizeRun({ id: "run-2" }, [
      probe({ status: "error", cited: null }),
    ]);
    expect(summary.engines[0].rate).toBeNull();
    expect(summary.engines[0].coverage).toBe(0);
  });

  it("keeps engines apart instead of averaging them", () => {
    const summary = summarizeRun({ id: "run-2" }, [
      probe({ id: "a", engine: "gemini", status: "cited", cited: true }),
      probe({ id: "b", engine: "perplexity", status: "not_cited" }),
    ]);
    expect(summary.engines.map((e) => [e.engine, e.rate])).toEqual([
      ["gemini", 1],
      ["perplexity", 0],
    ]);
  });
});

describe("compareRuns", () => {
  const current = { run: run(), summary: summarizeRun({ id: "run-2" }, [probe({ status: "cited", cited: true })]) };

  it("has nothing to compare with on the first run", () => {
    const comparison = compareRuns(current, null);
    expect(comparison.comparable).toBe(false);
    expect(comparison.byEngine[0].delta).toBeNull();
  });

  it("computes a delta only over the same query set and engines", () => {
    const previous = {
      run: run({ id: "run-1", startedAt: "2026-09-14T06:00:00Z" }),
      summary: summarizeRun({ id: "run-1" }, [probe({ runId: "run-1", status: "not_cited" })]),
    };
    const comparison = compareRuns(current, previous);
    expect(comparison.comparable).toBe(true);
    expect(comparison.byEngine[0]).toMatchObject({ rate: 1, previousRate: 0, delta: 100 });
  });

  it("refuses a delta when the query set changed, and says so", () => {
    const previous = {
      run: run({ id: "run-1", queryFingerprint: "different" }),
      summary: summarizeRun({ id: "run-1" }, [probe({ runId: "run-1" })]),
    };
    const comparison = compareRuns(current, previous);
    expect(comparison.comparable).toBe(false);
    expect(comparison.reasons.join(" ")).toMatch(/query set changed/i);
    // The previous rate is still shown; only the arrow is withheld.
    expect(comparison.byEngine[0].previousRate).toBe(0);
    expect(comparison.byEngine[0].delta).toBeNull();
  });

  it("leads with the per-engine answer, and names who was cited when you were not", () => {
    const summary = summarizeRun({ id: "run-2" }, [
      probe({ status: "not_cited" }),
      probe({ id: "b", query: "second prompt", status: "not_cited" }),
    ]);
    const comparison = compareRuns(
      { run: run(), summary },
      {
        run: run({ id: "run-1", queryFingerprint: "different" }),
        summary: summarizeRun({ id: "run-1" }, [probe({ runId: "run-1", status: "not_cited" })]),
      }
    );
    const lead = describeVisibility({
      subject: "gettrafficfa.st",
      summary,
      comparison,
      competitors: [
        { domain: "reddit.com", name: null, count: 10, asSource: 10, asMention: 0 },
        { domain: "eesel.ai", name: null, count: 8, asSource: 8, asMention: 0 },
        { domain: "hubspot.com", name: null, count: 6, asSource: 6, asMention: 0 },
        { domain: "semrush.com", name: null, count: 5, asSource: 5, asMention: 0 },
      ],
    });
    expect(lead.answer).toBe("Gemini did not cite gettrafficfa.st on any of the 2 prompts it answered.");
    expect(lead.instead).toBe("Cited instead, most often: reddit.com, eesel.ai and hubspot.com.");
    expect(lead.note).toMatch(/prompt list changed/);
    expect(lead.answer).not.toMatch(/50%|average/);
  });

  it("keeps two engines as two sentences and draws no note when the runs match", () => {
    const summary = summarizeRun({ id: "run-2" }, [
      probe({ status: "cited", cited: true }),
      probe({ id: "p", engine: "perplexity", status: "not_cited" }),
    ]);
    const previous = summarizeRun({ id: "run-1" }, [
      probe({ runId: "run-1", status: "not_cited" }),
      probe({ id: "p", runId: "run-1", engine: "perplexity", status: "not_cited" }),
    ]);
    const lead = describeVisibility({
      subject: "you",
      summary,
      comparison: compareRuns({ run: run({ engines: ["gemini", "perplexity"] }), summary }, {
        run: run({ id: "run-1", engines: ["gemini", "perplexity"] }),
        summary: previous,
      }),
      competitors: [{ domain: "jasper.ai", name: null, count: 1, asSource: 1, asMention: 0 }],
    });
    expect(lead.answer).toBe(
      "Gemini cited you on the one prompt it answered. Perplexity did not cite you on the one prompt it answered."
    );
    expect(lead.instead).toBe("Cited instead, most often: jasper.ai.");
    expect(lead.note).toBeNull();
  });

  it("does not invent a citation or a trend when nothing readable came back", () => {
    const summary = summarizeRun({ id: "run-2" }, [probe({ status: "invalid", cited: null })]);
    const lead = describeVisibility({
      subject: "you",
      summary,
      comparison: compareRuns({ run: run(), summary }, null),
      competitors: [],
    });
    expect(lead.answer).toMatch(/no readable answer/);
    expect(lead.answer).not.toMatch(/0%/);
    expect(lead.instead).toBeNull();
    expect(lead.note).toBeNull();
  });

  it("says a name in the prose is not a citation", () => {
    const summary = summarizeRun({ id: "run-2" }, [probe({ status: "not_cited", mentioned: true })]);
    const lead = describeVisibility({
      subject: "you",
      summary,
      comparison: compareRuns({ run: run(), summary }, null),
      competitors: [],
    });
    expect(lead.answer).toMatch(/without citing a page/);
  });

  it("refuses a delta when the engines changed or the previous run was partial", () => {
    const engines = compareRuns(current, {
      run: run({ id: "run-1", engines: ["gemini", "perplexity"] }),
      summary: summarizeRun({ id: "run-1" }, [probe({ runId: "run-1" })]),
    });
    expect(engines.reasons.join(" ")).toMatch(/engines/i);

    const partial = compareRuns(current, {
      run: run({ id: "run-1", status: "failed" }),
      summary: summarizeRun({ id: "run-1" }, [probe({ runId: "run-1" })]),
    });
    expect(partial.reasons.join(" ")).toMatch(/did not finish/i);
  });
});

describe("queryRows and changeBetween", () => {
  it("marks gains and losses only between two readable answers", () => {
    expect(changeBetween(null, "cited")).toBe("new");
    expect(changeBetween("not_cited", "cited")).toBe("gained");
    expect(changeBetween("cited", "not_cited")).toBe("lost");
    expect(changeBetween("cited", "cited")).toBe("same");
    expect(changeBetween("error", "cited")).toBe("unknown");
    expect(changeBetween("cited", "invalid")).toBe("unknown");
  });

  it("pairs each probe with the same question on the same engine in the previous run", () => {
    const rows = queryRows(
      [probe({ status: "cited", cited: true }), probe({ id: "x", query: "new q" })],
      [probe({ runId: "run-1", status: "not_cited" }), probe({ runId: "run-1", engine: "perplexity", status: "cited" })]
    );
    const first = rows.find((r) => r.query === "best ai seo tool");
    expect(first?.previousStatus).toBe("not_cited");
    expect(first?.change).toBe("gained");
    expect(rows.find((r) => r.query === "new q")?.change).toBe("new");
  });
});

describe("recurring competitors and sources", () => {
  const probes = [
    probe({
      id: "a",
      sources: [
        { url: "https://rival.test/a", domain: "rival.test", title: "Rival" },
        { url: "https://rival.test/b", domain: "rival.test", title: "Rival 2" },
      ],
      competitors: [
        { domain: "rival.test", name: "Rival", via: "source" },
        { domain: "rival.test", name: "Rival", via: "source" },
      ],
    }),
    probe({
      id: "b",
      checkedAt: "2026-09-22T06:00:00Z",
      sources: [{ url: "https://rival.test/c", domain: "rival.test", title: "" }],
      competitors: [{ domain: "rival.test", name: null, via: "mention" }],
    }),
    probe({ id: "c", status: "error", cited: null, competitors: [{ domain: "ghost.test", name: null, via: "source" }] }),
  ];

  it("counts a domain once per probe and ignores unreadable probes", () => {
    const list = recurringCompetitors(probes);
    expect(list).toEqual([{ domain: "rival.test", name: "Rival", count: 2, asSource: 1, asMention: 1 }]);
  });

  it("keeps the most recent example URL and the last non-empty title", () => {
    const list = recurringSources(probes);
    expect(list[0]).toMatchObject({ domain: "rival.test", count: 2, url: "https://rival.test/c", title: "Rival" });
  });
});

describe("queryHistory", () => {
  it("orders per engine oldest first and reports a null rate when nothing was readable", () => {
    const history = queryHistory([
      probe({ id: "b", checkedAt: "2026-09-21T06:00:00Z", status: "cited", cited: true }),
      probe({ id: "a", checkedAt: "2026-09-14T06:00:00Z", status: "not_cited" }),
      probe({ id: "c", engine: "perplexity", status: "error", cited: null }),
    ]);
    expect(history[0].engine).toBe("gemini");
    expect(history[0].points.map((p) => p.status)).toEqual(["not_cited", "cited"]);
    expect(history[0].rate).toBeCloseTo(0.5);
    expect(history[1].rate).toBeNull();
  });
});

describe("query set helpers", () => {
  it("fingerprints the same set regardless of order, case and spacing", () => {
    expect(queryFingerprint(["Best  AI SEO tool", "how to rank"])).toBe(
      queryFingerprint(["how to rank", "best ai seo tool"])
    );
    expect(queryFingerprint(["a"])).not.toBe(queryFingerprint(["a", "b"]));
  });

  it("normalises whitespace and caps length", () => {
    expect(normalizeQuery("  what   is   aeo ")).toBe("what is aeo");
    expect(normalizeQuery("x".repeat(500)).length).toBe(200);
  });

  it("drops duplicates within the batch and against the existing set, case-insensitively", () => {
    const { fresh, duplicates } = newQueries(
      [{ query: "What is AEO" }, { query: "what is aeo" }, { query: "new one" }],
      ["WHAT IS AEO"]
    );
    expect(fresh.map((q) => q.query)).toEqual(["new one"]);
    expect(duplicates).toBe(2);
  });
});
