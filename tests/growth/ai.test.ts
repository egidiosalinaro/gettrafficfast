import { describe, expect, it } from "vitest";
import { markSources, summarizeAsks, type Ask, type OpenPlace } from "@/lib/growth/ai";
import { periodWindows } from "@/lib/growth/period";

/**
 * Growth → AI answers, the count and the evidence's marks. Pinned: one row
 * per engine, never a rate across engines; no ask is null ("not asked"),
 * never 0; a negative is counted; an unreadable prompt answer is not an ask
 * and not "not cited"; both families count, split for whoever wants to tell
 * them apart; a configured engine nobody asked reads "not asked"; a source
 * is "in Today" only when the page is known to be the place.
 */

const windows = periodWindows(7, "2026-11-14");
const ask = (engine: string, kind: Ask["kind"], askedAt: string, status: Ask["status"]): Ask => ({ engine, kind, askedAt, status });

describe("summarizeAsks", () => {
  it("counts per engine, both families, this week and the week before", () => {
    const rows = summarizeAsks(
      [
        ask("gemini", "article", "2026-11-10", "not_cited"),
        ask("gemini", "article", "2026-11-10", "cited"),
        ask("gemini", "prompt", "2026-11-12T09:00:00Z", "not_cited"),
        ask("gemini", "prompt", "2026-11-12T09:00:00Z", "invalid"),
        ask("perplexity", "prompt", "2026-11-12T09:00:00Z", "cited"),
        ask("perplexity", "prompt", "2026-11-03T09:00:00Z", "not_cited"),
        ask("perplexity", "prompt", "2026-11-03T09:00:00Z", "error"),
        ask("gemini", "article", "2026-10-20", "cited"), // older than both windows
      ],
      windows
    );
    expect(rows).toEqual([
      {
        engine: "gemini",
        current: { asks: 3, cited: 1, rate: 1 / 3 },
        previous: { asks: 0, cited: 0, rate: null },
        byKind: { prompts: { asks: 1, cited: 0, rate: 0 }, articles: { asks: 2, cited: 1, rate: 0.5 } },
        unreadable: 1,
      },
      {
        engine: "perplexity",
        current: { asks: 1, cited: 1, rate: 1 },
        previous: { asks: 1, cited: 0, rate: 0 },
        byKind: { prompts: { asks: 1, cited: 1, rate: 1 }, articles: { asks: 0, cited: 0, rate: null } },
        unreadable: 0,
      },
    ]);
    // No pooled number anywhere.
    expect(JSON.stringify(rows)).not.toMatch(/"engine":"all"|averag/);
  });

  it("keeps a negative as a measurement: asked and not cited is 0, not null", () => {
    const [row] = summarizeAsks([ask("gemini", "article", "2026-11-10", "not_cited")], windows);
    expect(row.current).toEqual({ asks: 1, cited: 0, rate: 0 });
  });

  it("shows a configured engine nobody asked as not asked, never 0", () => {
    const rows = summarizeAsks([], windows, ["perplexity", "gemini"]);
    expect(rows.map((r) => r.engine)).toEqual(["gemini", "perplexity"]);
    for (const row of rows) {
      expect(row.current.rate).toBeNull();
      expect(row.previous.rate).toBeNull();
    }
  });

  it("does not turn an unreadable answer into a not cited", () => {
    const [row] = summarizeAsks([ask("gemini", "prompt", "2026-11-12T00:00:00Z", "invalid"), ask("gemini", "prompt", "2026-11-12T00:00:00Z", "error")], windows);
    expect(row.current).toEqual({ asks: 0, cited: 0, rate: null });
    expect(row.unreadable).toBe(2);
  });
});

describe("markSources", () => {
  const isRedirect = (url: string) => url.includes("grounding-api-redirect");
  const keyOf = (url: string) => (url.includes("reddit.com/r/seo/comments/abc") ? "reddit:abc" : null);
  const isOurs = (domain: string) => domain === "acme.test" || domain.endsWith(".acme.test");
  const place = (over: Partial<OpenPlace>): OpenPlace => ({ id: "p1", key: "reddit:abc", domain: "reddit.com", sighting: null, ...over });

  it("marks the site's own source and a page that is a place, by its identity", () => {
    const { sources, placesInToday } = markSources(
      {
        runId: "r1",
        question: "best seo tool",
        engine: "perplexity",
        sources: [
          { url: "https://blog.acme.test/post", domain: "blog.acme.test", title: "Acme" },
          { url: "https://www.reddit.com/r/seo/comments/abc/x/", domain: "reddit.com", title: "Thread" },
          { url: "https://rival.test/", domain: "rival.test", title: "" },
        ],
      },
      { isOurs, keyOf, isRedirect, places: [place({})] }
    );
    expect(sources.map((s) => [s.position, s.ours, s.inToday, s.opensPage, s.title])).toEqual([
      [1, true, false, true, "Acme"],
      [2, false, true, true, "Thread"],
      [3, false, false, true, null],
    ]);
    expect(placesInToday).toBe(1);
  });

  it("marks a redirect only when this answer sent one place on its domain and the domain is there once", () => {
    const sighting = { runId: "r1", prompts: [{ query: "best seo tool", engines: ["gemini"] }] };
    const answer = (sources: Array<{ domain: string }>) => ({
      runId: "r1",
      question: "best seo tool",
      engine: "gemini",
      sources: sources.map((s, i) => ({ url: `https://x.google.com/grounding-api-redirect/${i}`, domain: s.domain, title: s.domain })),
    });
    const ctx = { isOurs, keyOf, isRedirect, places: [place({ sighting })] };

    const one = markSources(answer([{ domain: "neilpatel.com" }, { domain: "reddit.com" }]), ctx);
    expect(one.sources.map((s) => s.inToday)).toEqual([false, true]);
    expect(one.sources.every((s) => !s.opensPage)).toBe(true);
    expect(one.placesInToday).toBe(1);

    // Two reddit sources: which one is the place cannot be told, so neither is marked; the count still says one.
    const two = markSources(answer([{ domain: "reddit.com" }, { domain: "reddit.com" }]), ctx);
    expect(two.sources.map((s) => s.inToday)).toEqual([false, false]);
    expect(two.placesInToday).toBe(1);

    // Another engine's answer to the same prompt did not send it.
    const other = markSources({ ...answer([{ domain: "reddit.com" }]), engine: "perplexity" }, ctx);
    expect(other.placesInToday).toBe(0);
    expect(other.sources[0].inToday).toBe(false);
  });
});
