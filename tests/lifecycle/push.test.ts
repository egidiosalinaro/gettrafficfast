import { describe, expect, it } from "vitest";
import {
  afterWindow,
  anchorFitsQuery,
  baselineWindow,
  checkMetaDescription,
  checkMetaTitle,
  chooseMainQuery,
  chooseSourcePages,
  measurementDue,
  pushEligibility,
  pushLine,
  selectPushCandidates,
  windowStats,
  type MetricDay,
  type PushCandidateInput,
  type SourcePageInput,
} from "@/lib/lifecycle/push";

/**
 * Push page 3, the rules (docs/LIFECYCLE.md): which articles, which query,
 * which pages, which titles, which windows, and the line Growth prints.
 */

const WATERMARK = "2026-11-12";
const NOW = new Date("2026-11-15T09:40:00Z");

/** 28 days ending on the watermark, `impressions` a day at `position`. */
function days(impressions: number, position: number, clicks = 0): MetricDay[] {
  const out: MetricDay[] = [];
  for (let i = 0; i < 28; i += 1) {
    const day = new Date(Date.UTC(2026, 10, 12) - i * 86_400_000).toISOString().slice(0, 10);
    out.push({ capturedOn: day, impressions, clicks, position });
  }
  return out;
}

const article = (id: string, metrics: MetricDay[], over: Partial<PushCandidateInput> = {}): PushCandidateInput => ({
  articleId: id,
  publishedUrl: `https://acme.test/blog/${id}`,
  metrics,
  lastPushAt: null,
  lastEditedAt: "2026-09-01T00:00:00Z",
  ...over,
});

describe("windows", () => {
  it("sums clicks and impressions and weights the position by impressions", () => {
    const stats = windowStats(
      [
        { capturedOn: "2026-11-01", impressions: 10, clicks: 1, position: 30 },
        { capturedOn: "2026-11-02", impressions: 30, clicks: 2, position: 20 },
        { capturedOn: "2026-10-01", impressions: 999, clicks: 9, position: 1 },
      ],
      "2026-11-01",
      "2026-11-02"
    );
    expect(stats).toMatchObject({ impressions: 40, clicks: 3, position: 22.5, days: 2 });
  });

  it("has no position without an impression: null, never 0", () => {
    expect(windowStats([{ capturedOn: "2026-11-01", impressions: 0, clicks: 0, position: 0 }], "2026-11-01", "2026-11-01").position).toBeNull();
  });

  it("the baseline is the 28 days ending on the watermark", () => {
    expect(baselineWindow(WATERMARK)).toEqual({ start: "2026-10-16", end: WATERMARK });
  });
});

describe("candidates", () => {
  it("takes positions 11 to 40 with at least 50 impressions, most impressions first, at most 3", () => {
    const { candidates, excluded } = selectPushCandidates({
      articles: [
        article("top", days(10, 4)),
        article("deep", days(10, 55)),
        article("thin", days(1, 30)),
        article("a", days(5, 30)),
        article("b", days(9, 25)),
        article("c", days(3, 12)),
        article("d", days(2, 33)),
      ],
      watermark: WATERMARK,
      now: NOW,
    });
    expect(candidates.map((c) => c.articleId)).toEqual(["b", "a", "c"]);
    expect(candidates[0].before).toMatchObject({ position: 25, impressions: 252, start: "2026-10-16", end: WATERMARK });
    expect(Object.fromEntries(excluded.map((e) => [e.articleId, e.reason]))).toEqual({
      top: "outside_band",
      deep: "outside_band",
      thin: "too_few_impressions",
      d: "over_weekly_cap",
    });
  });

  it("leaves out an article pushed in the last 28 days, changed in the last 14, busy, or not live", () => {
    const rule = (over: Partial<PushCandidateInput>) => pushEligibility(article("x", days(5, 30), over), { watermark: WATERMARK, now: NOW });
    expect(rule({ lastPushAt: "2026-10-25T00:00:00Z" })).toEqual({ ok: false, reason: "pushed_recently" });
    expect(rule({ lastPushAt: "2026-10-10T00:00:00Z" }).ok).toBe(true);
    expect(rule({ lastEditedAt: "2026-11-05T00:00:00Z" })).toEqual({ ok: false, reason: "edited_recently" });
    expect(rule({ busy: true })).toEqual({ ok: false, reason: "busy" });
    expect(rule({ publishedUrl: null })).toEqual({ ok: false, reason: "not_live" });
    expect(rule({ metrics: [] })).toEqual({ ok: false, reason: "no_impressions" });
  });

  it("on demand skips the band and the minimum, never the measurement rules", () => {
    const top = article("top", days(1, 4));
    expect(pushEligibility(top, { watermark: WATERMARK, now: NOW }).ok).toBe(false);
    expect(pushEligibility(top, { watermark: WATERMARK, now: NOW, ignoreBand: true }).ok).toBe(true);
    expect(pushEligibility({ ...top, lastPushAt: "2026-11-01T00:00:00Z" }, { watermark: WATERMARK, now: NOW, ignoreBand: true }).ok).toBe(false);
  });
});

describe("the main query", () => {
  it("is the query with the most impressions, clicks breaking a tie", () => {
    expect(
      chooseMainQuery([
        { query: "x growth tools", impressions: 40, clicks: 0, position: 31.24 },
        { query: "grow on x", impressions: 80, clicks: 1, position: 28 },
        { query: "grow x account", impressions: 80, clicks: 3, position: 27 },
      ])
    ).toEqual({ ok: true, query: "grow x account", impressions: 80, clicks: 3, position: 27 });
  });

  it("is no clear query when there is none, it is too thin, or two tie: a skip with its reason", () => {
    expect(chooseMainQuery([])).toMatchObject({ ok: false });
    expect(chooseMainQuery([{ query: "rare", impressions: 6, clicks: 0, position: 20 }])).toMatchObject({ ok: false, reason: expect.stringContaining("10 impressions") });
    expect(
      chooseMainQuery([
        { query: "a b", impressions: 20, clicks: 1, position: 20 },
        { query: "c d", impressions: 20, clicks: 1, position: 22 },
      ])
    ).toMatchObject({ ok: false, reason: expect.stringContaining("tie") });
  });
});

describe("source pages", () => {
  const page = (id: string, over: Partial<SourcePageInput> = {}): SourcePageInput => ({
    articleId: id,
    title: `Abandoned cart emails: ${id}`,
    keyword: "abandoned cart email",
    publishedUrl: `https://acme.test/blog/${id}`,
    clicks: 0,
    impressions: 100,
    graphScore: 0,
    linksToTarget: false,
    ...over,
  });
  const target = { articleId: "t", title: "Abandoned cart email subject lines", keyword: "abandoned cart subject line", mainQuery: "abandoned cart email subject lines" };

  it("picks the related pages with the most clicks, then impressions, at most 3", () => {
    const chosen = chooseSourcePages({
      target,
      pages: [
        page("low", { clicks: 1 }),
        page("best", { clicks: 40 }),
        page("second", { clicks: 12, impressions: 900 }),
        page("third", { clicks: 12, impressions: 300 }),
        page("unrelated", { clicks: 500, title: "Pricing for agencies", keyword: "agency pricing" }),
        page("graph", { clicks: 2, title: "Pricing for agencies", keyword: "agency pricing", graphScore: 3 }),
      ],
    });
    expect(chosen.map((c) => c.articleId)).toEqual(["best", "second", "third"]);
  });

  it("never the article itself, one that already links to it, one Google never showed, or one twice", () => {
    const chosen = chooseSourcePages({
      target,
      pages: [page("t", { clicks: 99 }), page("linked", { clicks: 50, linksToTarget: true }), page("unseen", { clicks: 0, impressions: 0 }), page("ok"), page("ok", { clicks: 99 })],
    });
    expect(chosen.map((c) => c.articleId)).toEqual(["ok"]);
  });
});

describe("anchors", () => {
  it("is the query or a natural variant, 2 to 10 words", () => {
    expect(anchorFitsQuery("abandoned cart email subject lines", "abandoned cart email subject lines")).toBe(true);
    expect(anchorFitsQuery("subject lines for abandoned cart emails", "abandoned cart email subject lines")).toBe(true);
    expect(anchorFitsQuery("this guide", "abandoned cart email subject lines")).toBe(false);
    expect(anchorFitsQuery("cart", "abandoned cart email subject lines")).toBe(false);
  });
});

describe("title and description", () => {
  const context = { mainQuery: "x growth tools", articleText: "We compared 7 X growth tools over 30 days.", current: "Growing on X" };

  it("accepts a title of 20 to 60 characters holding the query", () => {
    expect(checkMetaTitle("X Growth Tools: 7 Options Compared", context)).toEqual({ ok: true, text: "X Growth Tools: 7 Options Compared" });
  });

  it("refuses a title without the query, too long, clickbait, a figure the article lacks, or unchanged", () => {
    expect(checkMetaTitle("Seven ways to grow your account fast", context)).toMatchObject({ ok: false, reason: expect.stringContaining("main query") });
    expect(checkMetaTitle(`X growth tools ${"really ".repeat(10)}compared`, context)).toMatchObject({ ok: false, reason: expect.stringContaining("longer") });
    expect(checkMetaTitle("Shocking X growth tools nobody uses", context)).toMatchObject({ ok: false, reason: expect.stringContaining("clickbait") });
    expect(checkMetaTitle("X growth tools that work!", context)).toMatchObject({ ok: false, reason: expect.stringContaining("clickbait") });
    expect(checkMetaTitle("12 X growth tools compared", context)).toMatchObject({ ok: false, reason: expect.stringContaining("figure") });
    expect(checkMetaTitle("x growth tools", { ...context, current: "X growth tools" })).toMatchObject({ ok: false });
  });

  it("holds the description to 70 to 155 characters with the query", () => {
    expect(checkMetaDescription("X growth tools compared.", context)).toMatchObject({ ok: false, reason: expect.stringContaining("shorter") });
    const good = "We compared 7 X growth tools over 30 days: what each one does, what it costs you in time, and which fits.";
    expect(checkMetaDescription(good, context)).toEqual({ ok: true, text: good });
  });
});

describe("measuring", () => {
  it("measures the 14 and 28 days after the day it went live, once the data covers them", () => {
    expect(afterWindow("2026-11-16T10:00:00Z", 14)).toEqual({ start: "2026-11-17", end: "2026-11-30" });
    expect(measurementDue("2026-11-16T10:00:00Z", 14, "2026-11-29")).toBe(false);
    expect(measurementDue("2026-11-16T10:00:00Z", 14, "2026-11-30")).toBe(true);
    expect(measurementDue(null, 14, "2026-12-30")).toBe(false);
    expect(measurementDue("2026-11-16T10:00:00Z", 28, null)).toBe(false);
  });

  it("prints what Growth shows, never an invented number", () => {
    const base = { status: "applied", createdAt: "2026-11-16T09:00:00Z", appliedAt: "2026-11-16T09:05:00Z", beforePosition: 37.2, after14: null, after28: null };
    expect(pushLine(base, NOW)).toBe("Pushed Nov 16: not measured yet");
    expect(pushLine({ ...base, after14: { position: 29.4 } }, NOW)).toBe("Pushed Nov 16: 37 → 29");
    expect(pushLine({ ...base, after14: { position: 29.4 }, after28: { position: 24 } }, NOW)).toBe("Pushed Nov 16: 37 → 24");
    expect(pushLine({ ...base, after14: { position: 36.8 } }, NOW)).toBe("Pushed Nov 16: no change yet");
    expect(pushLine({ ...base, after14: { position: null } }, NOW)).toBe("Pushed Nov 16: no impressions since");
    expect(pushLine({ ...base, status: "proposed", appliedAt: null }, NOW)).toBe("Proposed Nov 16: not applied yet");
    expect(pushLine({ ...base, status: "skipped" }, NOW)).toBeNull();
  });
});
