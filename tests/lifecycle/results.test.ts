import { describe, expect, it } from "vitest";
import {
  describeRankSources,
  describeSearchConsoleTrafficEmpty,
  pulledOnPhrase,
  RANK_SOURCE_LABEL,
  searchConsoleCaption,
  summarizeCitations,
  summarizeDailyTraffic,
  summarizeRank,
  summarizeTotals,
  type ArticleResult,
  type SearchConsoleStatus,
} from "@/lib/lifecycle/results";

/**
 * These summaries are what a paying customer reads. Their contract is that a
 * missing measurement never renders as a zero: "we have not looked" and "we
 * looked and you are nowhere" are different sentences, and only one of them
 * is fair to show.
 */

describe("summarizeRank", () => {
  it("reports nothing measured rather than position zero", () => {
    const summary = summarizeRank([]);
    expect(summary).toEqual({
      current: null,
      previous: null,
      delta: null,
      measuredOn: null,
      samples: 0,
    });
  });

  it("has no trend from a single measurement", () => {
    const summary = summarizeRank([{ capturedOn: "2026-08-01", position: 7 }]);
    expect(summary.current).toBe(7);
    expect(summary.delta).toBeNull();
    expect(summary.samples).toBe(1);
  });

  it("hands out positions and changes to one decimal, never float dust", () => {
    // Search Console averages: 66.8 four weeks ago, 51.75 now. The raw
    // difference is 15.049999999999997, which the Results screen printed.
    const climb = summarizeRank([
      { capturedOn: "2026-10-20", position: 66.8 },
      { capturedOn: "2026-11-10", position: 51.75 },
    ]);
    expect(climb).toMatchObject({ current: 51.8, previous: 66.8, delta: 15 });

    const slip = summarizeRank([
      { capturedOn: "2026-10-20", position: 23.66 },
      { capturedOn: "2026-11-10", position: 37.33 },
    ]);
    // 23.66 → 23.7, 37.33 → 37.3: the change is the difference of what is shown.
    expect(slip).toMatchObject({ current: 37.3, previous: 23.7, delta: -13.6 });
    expect(String(slip.delta)).toBe("-13.6");
  });

  it("calls a move that rounds to nothing 0, not a tiny arrow", () => {
    const summary = summarizeRank([
      { capturedOn: "2026-10-20", position: 10.04 },
      { capturedOn: "2026-11-10", position: 9.98 },
    ]);
    expect(summary.current).toBe(10);
    expect(summary.delta).toBe(0);
    expect(Object.is(summary.delta, -0)).toBe(false);
  });

  it("reads a climb as a positive delta", () => {
    const summary = summarizeRank([
      { capturedOn: "2026-08-01", position: 12 },
      { capturedOn: "2026-08-20", position: 4 },
    ]);
    expect(summary.current).toBe(4);
    expect(summary.previous).toBe(12);
    expect(summary.delta).toBe(8);
  });

  it("reads a slip as a negative delta", () => {
    const summary = summarizeRank([
      { capturedOn: "2026-08-01", position: 3 },
      { capturedOn: "2026-08-20", position: 9 },
    ]);
    expect(summary.delta).toBe(-6);
  });

  it("ignores measurements older than the window", () => {
    const summary = summarizeRank([
      { capturedOn: "2026-01-01", position: 40 },
      { capturedOn: "2026-08-20", position: 5 },
    ]);
    // The January point describes a different article; comparing against it
    // would invent a spectacular improvement that nobody observed.
    expect(summary.previous).toBeNull();
    expect(summary.delta).toBeNull();
  });

  it("does not compute a trend against an absence", () => {
    const summary = summarizeRank([
      { capturedOn: "2026-08-01", position: null },
      { capturedOn: "2026-08-20", position: 6 },
    ]);
    expect(summary.current).toBe(6);
    expect(summary.delta).toBeNull();
  });
});

describe("summarizeCitations", () => {
  it("reports null, not zero, when nothing was probed", () => {
    expect(summarizeCitations([])).toEqual({
      rate: null,
      probes: 0,
      cited: 0,
      lastCheckedOn: null,
      byEngine: [],
    });
  });

  it("splits the rate per engine and keeps the latest check", () => {
    const summary = summarizeCitations([
      { checkedOn: "2026-08-01", engine: "perplexity", cited: true },
      { checkedOn: "2026-08-08", engine: "perplexity", cited: false },
      { checkedOn: "2026-08-15", engine: "other", cited: false },
    ]);

    expect(summary.probes).toBe(3);
    expect(summary.cited).toBe(1);
    expect(summary.lastCheckedOn).toBe("2026-08-15");
    expect(summary.byEngine).toEqual([
      { engine: "other", rate: 0, probes: 1 },
      { engine: "perplexity", rate: 0.5, probes: 2 },
    ]);
  });
});

describe("summarizeTotals", () => {
  const article = (over: Partial<ArticleResult> = {}): ArticleResult => ({
    articleId: "a",
    keyword: "k",
    publishedUrl: "https://example.com/a",
    rank: { current: null, previous: null, delta: null, measuredOn: null, samples: 0 },
    rankSource: null,
    traffic: { impressions: null, clicks: null, windowDays: 28 },
    citations: { rate: null, probes: 0, cited: 0, lastCheckedOn: null, byEngine: [] },
    ...over,
  });

  it("leaves the headline numbers empty when nothing was measured", () => {
    const totals = summarizeTotals([article(), article()]);
    expect(totals.published).toBe(2);
    expect(totals.rankMeasured).toBe(0);
    expect(totals.averagePosition).toBeNull();
    expect(totals.citationRate).toBeNull();
  });

  it("counts only what actually ranks, and the top ten inside it", () => {
    const totals = summarizeTotals([
      article({
        rank: { current: 3, previous: 5, delta: 2, measuredOn: "2026-08-20", samples: 4 },
      }),
      article({
        rank: { current: 24, previous: null, delta: null, measuredOn: "2026-08-20", samples: 2 },
      }),
      article({
        // Measured, and not ranking: it counts as measured, not as ranking.
        rank: { current: null, previous: null, delta: null, measuredOn: "2026-08-20", samples: 3 },
      }),
    ]);

    expect(totals.rankMeasured).toBe(3);
    expect(totals.ranking).toBe(2);
    expect(totals.topTen).toBe(1);
    expect(totals.averagePosition).toBeCloseTo(13.5);
  });

  it("averages positions to one decimal", () => {
    const totals = summarizeTotals([
      article({ rank: { current: 51.8, previous: null, delta: null, measuredOn: "2026-11-10", samples: 3 } }),
      article({ rank: { current: 37.3, previous: null, delta: null, measuredOn: "2026-11-10", samples: 3 } }),
      article({ rank: { current: 60.5, previous: null, delta: null, measuredOn: "2026-11-10", samples: 3 } }),
    ]);
    // (51.8 + 37.3 + 60.5) / 3 = 49.866666…
    expect(totals.averagePosition).toBe(49.9);
  });

  it("aggregates citation probes across articles", () => {
    const totals = summarizeTotals([
      article({
        citations: {
          rate: 0.5, probes: 2, cited: 1, lastCheckedOn: "2026-08-20",
          byEngine: [{ engine: "perplexity", rate: 0.5, probes: 2 }],
        },
      }),
      article({
        citations: {
          rate: 0, probes: 2, cited: 0, lastCheckedOn: "2026-08-20",
          byEngine: [{ engine: "perplexity", rate: 0, probes: 2 }],
        },
      }),
    ]);

    expect(totals.citationProbes).toBe(4);
    expect(totals.citationRate).toBe(0.25);
  });
});

describe("summarizeDailyTraffic", () => {
  const today = new Date("2026-08-29T12:00:00Z");

  it("has no series at all when nothing was ingested", () => {
    expect(summarizeDailyTraffic([], 28, today)).toEqual({
      days: [],
      settledThrough: null,
      windowDays: 28,
    });
  });

  it("sums the same day across articles", () => {
    const series = summarizeDailyTraffic(
      [
        { capturedOn: "2026-08-28", clicks: 2, impressions: 10 },
        { capturedOn: "2026-08-28", clicks: 3, impressions: 5 },
      ],
      28,
      today
    );
    expect(series.days.at(-1)).toEqual({ day: "2026-08-28", clicks: 5, impressions: 15 });
  });

  it("fills a day Google omitted with a true zero", () => {
    // Search Console leaves out days with nothing to report; inside the
    // ingested range that absence IS the number zero.
    const series = summarizeDailyTraffic(
      [
        { capturedOn: "2026-08-26", clicks: 1, impressions: 4 },
        { capturedOn: "2026-08-28", clicks: 2, impressions: 6 },
      ],
      28,
      today
    );
    expect(series.days.find((d) => d.day === "2026-08-27")).toEqual({
      day: "2026-08-27",
      clicks: 0,
      impressions: 0,
    });
  });

  it("stops at the last settled day instead of drawing a cliff", () => {
    // Days Google has not settled yet are absent, not zero: extending the
    // series to today would show traffic collapsing when it is merely late.
    const series = summarizeDailyTraffic(
      [{ capturedOn: "2026-08-26", clicks: 1, impressions: 4 }],
      28,
      today
    );
    expect(series.settledThrough).toBe("2026-08-26");
    expect(series.days.at(-1)?.day).toBe("2026-08-26");
  });

  it("starts at the window edge and drops older history", () => {
    const series = summarizeDailyTraffic(
      [
        { capturedOn: "2026-07-20", clicks: 9, impressions: 9 },
        { capturedOn: "2026-08-28", clicks: 1, impressions: 1 },
      ],
      28,
      today
    );
    expect(series.days[0]?.day).toBe("2026-08-01");
    expect(series.days).toHaveLength(28);
  });

  it("keeps settledThrough even when all data is older than the window", () => {
    const series = summarizeDailyTraffic(
      [{ capturedOn: "2026-07-20", clicks: 9, impressions: 9 }],
      28,
      today
    );
    expect(series.days).toEqual([]);
    expect(series.settledThrough).toBe("2026-07-20");
  });
});

describe("describeSearchConsoleTrafficEmpty", () => {
  const connected = (over: Partial<SearchConsoleStatus> = {}): SearchConsoleStatus => ({
    status: "connected",
    siteUrl: "sc-domain:example.com",
    lastSyncedOn: null,
    pulledAt: null,
    stale: false,
    lastError: null,
    syncing: false,
    ...over,
  });

  it("never tells a connected customer to wait until 07:00", () => {
    const variants: SearchConsoleStatus[] = [
      connected({ syncing: true }),
      connected({ lastSyncedOn: null, syncing: false }),
      connected({ lastSyncedOn: "2026-08-26" }),
      connected({ siteUrl: null }),
      { status: "absent", siteUrl: null, lastSyncedOn: null, pulledAt: null, stale: false, lastError: null, syncing: false },
      {
        status: "error",
        siteUrl: "sc-domain:example.com",
        lastSyncedOn: "2026-08-26",
        pulledAt: null,
        stale: false,
        lastError: "revoked",
        syncing: false,
      },
    ];
    for (const connection of variants) {
      const copy = describeSearchConsoleTrafficEmpty(connection) ?? "";
      expect(copy).not.toMatch(/07:00/);
    }
  });

  it("names the data day and the pull day separately", () => {
    const line = searchConsoleCaption({
      siteLabel: "gettrafficfa.st",
      through: "2026-10-06",
      pulledAt: "2026-10-08T07:00:37.000Z",
      syncing: false,
      now: new Date("2026-10-08T15:00:00.000Z"),
    });
    expect(line).toBe("gettrafficfa.st · data through Oct 6 · pulled today");
  });

  it("says which day the data runs through, not when the pull happened", () => {
    const copy = describeSearchConsoleTrafficEmpty(
      connected({ lastSyncedOn: "2026-08-26", pulledAt: "2026-08-28T07:00:00.000Z" }),
      new Date("2026-11-09T12:00:00.000Z")
    );
    expect(copy).toContain("Data through Aug 26, pulled Aug 28.");
    expect(copy).not.toMatch(/Last synced/);
  });

  it("writes both days as a person reads them, never as ISO, in English", () => {
    const now = new Date("2026-11-09T12:00:00.000Z");
    const copy =
      describeSearchConsoleTrafficEmpty(
        connected({ lastSyncedOn: "2025-12-30", pulledAt: "2026-01-02T07:00:00.000Z" }),
        now
      ) ?? "";
    expect(copy).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(copy).toContain("Data through Dec 30, 2025, pulled Jan 2.");
    expect(pulledOnPhrase("2026-10-28T07:00:00.000Z", now)).toBe("pulled Oct 28");
    expect(pulledOnPhrase("2026-11-08T07:00:00.000Z", now)).toBe("pulled yesterday");
  });

  it("says it is pulling while the first ingest job is running", () => {
    const copy = describeSearchConsoleTrafficEmpty(connected({ syncing: true }));
    expect(copy).toMatch(/Pulling traffic/);
  });

  it("does not pretend a pull is in flight when no watermark and no job", () => {
    const copy = describeSearchConsoleTrafficEmpty(connected({ lastSyncedOn: null, syncing: false }));
    expect(copy).toMatch(/Waiting for the first Search Console pull/);
    expect(copy).not.toMatch(/Pulling traffic/);
  });
});

describe("describeRankSources", () => {
  const row = (articleId: string, rankSource: ArticleResult["rankSource"]) => ({ articleId, rankSource });

  it("says the source once when every measured row shares it, and marks no row", () => {
    const sources = describeRankSources([
      row("a", "search_console"),
      row("b", "search_console"),
      row("c", null),
    ]);
    expect(sources.primary).toBe("search_console");
    expect(sources.exceptions).toEqual([]);
    expect(sources.note).toBe("Positions are Google's average from Search Console.");
  });

  it("marks only the rows from the other source when they mix", () => {
    const sources = describeRankSources([
      row("a", "search_console"),
      row("b", "serp"),
      row("c", "search_console"),
    ]);
    expect(sources.primary).toBe("search_console");
    expect(sources.exceptions).toEqual(["b"]);
    expect(sources.note).toContain(`except where a row says ${RANK_SOURCE_LABEL.serp}`);
  });

  it("names the snapshot when most rows have it, and gives a tie to Search Console", () => {
    const mostlySerp = describeRankSources([row("a", "serp"), row("b", "serp"), row("c", "search_console")]);
    expect(mostlySerp.primary).toBe("serp");
    expect(mostlySerp.exceptions).toEqual(["c"]);
    expect(mostlySerp.note).toMatch(/^Positions are from our own SERP snapshot/);
    expect(mostlySerp.note).toContain("except where a row says Search Console");

    const tie = describeRankSources([row("a", "serp"), row("b", "search_console")]);
    expect(tie.primary).toBe("search_console");
    expect(tie.exceptions).toEqual(["a"]);
  });

  it("says nothing when no article was measured, and never the stored identifiers", () => {
    expect(describeRankSources([row("a", null)])).toEqual({ primary: null, exceptions: [], note: null });
    for (const sources of [
      describeRankSources([row("a", "search_console")]),
      describeRankSources([row("a", "serp"), row("b", "search_console"), row("c", "serp")]),
    ]) {
      expect(sources.note).not.toMatch(/gsc|search_console|\bserp\b/);
    }
    expect(RANK_SOURCE_LABEL).toEqual({ search_console: "Search Console", serp: "SERP snapshot" });
  });
});
