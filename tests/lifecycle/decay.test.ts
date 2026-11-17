import { describe, expect, it } from "vitest";
import {
  detectDecay,
  REFRESH_COOLDOWN_DAYS,
  SLIP_THRESHOLD,
  STALE_AFTER_DAYS,
} from "@/lib/lifecycle/decay";
import { assessRefresh } from "@/lib/lifecycle/guard";
import { findOwnPosition } from "@/lib/lifecycle/rank";
import { CanonicalArticle } from "@/lib/content/types";

/**
 * Decay detection decides whether to spend money rewriting a page that
 * currently works. Its contract is conservatism: every test here is about
 * what must NOT trigger a refresh as much as what must.
 */

const NOW = new Date("2026-08-24T00:00:00Z");
const daysAgo = (n: number) =>
  new Date(NOW.getTime() - n * 86_400_000).toISOString();
const dateAgo = (n: number) => daysAgo(n).slice(0, 10);

describe("detectDecay", () => {
  it("leaves a freshly refreshed article alone, whatever the numbers say", () => {
    const verdict = detectDecay({
      points: [
        { capturedOn: dateAgo(60), position: 3 },
        { capturedOn: dateAgo(1), position: null },
      ],
      publishedAt: daysAgo(400),
      lastRefreshedAt: daysAgo(REFRESH_COOLDOWN_DAYS - 1),
      now: NOW,
    });
    expect(verdict.decaying).toBe(false);
    expect(verdict.detail).toContain("cooldown");
  });

  it("flags an article that fell out of the results", () => {
    const verdict = detectDecay({
      points: [
        { capturedOn: dateAgo(60), position: 4 },
        { capturedOn: dateAgo(2), position: null },
      ],
      publishedAt: daysAgo(200),
      lastRefreshedAt: null,
      now: NOW,
    });
    expect(verdict).toMatchObject({ decaying: true, reason: "lost_ranking", from: 4, to: null });
  });

  it("flags a real slip but not noise", () => {
    const points = (to: number) => [
      { capturedOn: dateAgo(60), position: 6 },
      { capturedOn: dateAgo(2), position: to },
    ];
    expect(
      detectDecay({ points: points(6 + SLIP_THRESHOLD), publishedAt: daysAgo(90), lastRefreshedAt: null, now: NOW })
    ).toMatchObject({ decaying: true, reason: "slipping" });
    expect(
      detectDecay({ points: points(8), publishedAt: daysAgo(90), lastRefreshedAt: null, now: NOW }).decaying
    ).toBe(false);
  });

  it("does not rewrite a page that still ranks near the top", () => {
    // #1 → #3 is six positions of nothing: it is still the answer.
    const verdict = detectDecay({
      points: [
        { capturedOn: dateAgo(60), position: 1 },
        { capturedOn: dateAgo(2), position: 3 },
      ],
      publishedAt: daysAgo(90),
      lastRefreshedAt: null,
      now: NOW,
    });
    expect(verdict.decaying).toBe(false);
  });

  it("ignores movement measured over too short a span", () => {
    const verdict = detectDecay({
      points: [
        { capturedOn: dateAgo(3), position: 4 },
        { capturedOn: dateAgo(1), position: 20 },
      ],
      publishedAt: daysAgo(30),
      lastRefreshedAt: null,
      now: NOW,
    });
    expect(verdict.decaying).toBe(false);
  });

  it("falls back to age when nothing has been measured", () => {
    expect(
      detectDecay({ points: [], publishedAt: daysAgo(STALE_AFTER_DAYS + 1), lastRefreshedAt: null, now: NOW })
    ).toMatchObject({ decaying: true, reason: "stale" });
    expect(
      detectDecay({ points: [], publishedAt: daysAgo(10), lastRefreshedAt: null, now: NOW }).decaying
    ).toBe(false);
  });
});

describe("findOwnPosition", () => {
  const results = [
    { position: 1, title: "a", url: "https://rival.com/x", domain: "rival.com", snippet: "" },
    { position: 4, title: "b", url: "https://blog.mine.com/other", domain: "blog.mine.com", snippet: "" },
    { position: 7, title: "c", url: "https://blog.mine.com/post/", domain: "blog.mine.com", snippet: "" },
  ];

  it("prefers the exact article URL, ignoring a trailing slash", () => {
    expect(findOwnPosition(results, "https://blog.mine.com/post")).toEqual({
      position: 7,
      exact: true,
    });
  });

  it("falls back to the best position the same domain reaches", () => {
    expect(findOwnPosition(results, "https://blog.mine.com/missing")).toEqual({
      position: 4,
      exact: false,
    });
  });

  it("returns null when the site does not appear at all", () => {
    expect(findOwnPosition(results, "https://absent.com/post")).toBeNull();
    expect(findOwnPosition(results, "")).toBeNull();
  });
});

describe("assessRefresh", () => {
  const article = (wordCount: number, sections: number): CanonicalArticle => ({
    schemaVersion: 1,
    articleId: "a",
    title: "T",
    bodyHtml: "<p>x</p>",
    headings: Array.from({ length: sections }, (_, i) => ({
      level: 2 as const,
      id: `s${i}`,
      text: `S${i}`,
    })),
    excerpt: "e",
    metaDescription: "m",
    wordCount,
    slug: "s",
    keyword: "k",
    language: "en",
    scheduledDate: null,
  });

  it("accepts a refresh that keeps the substance", () => {
    expect(assessRefresh(article(1000, 5), article(1100, 6)).safe).toBe(true);
  });

  it("rejects a refresh that guts the article", () => {
    const result = assessRefresh(article(1000, 5), article(500, 5));
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("50%");
  });

  it("rejects a refresh that drops sections wholesale", () => {
    expect(assessRefresh(article(1000, 6), article(980, 3)).safe).toBe(false);
  });

  it("tolerates two sections merging into one", () => {
    expect(assessRefresh(article(1000, 6), article(1000, 5)).safe).toBe(true);
  });
});
