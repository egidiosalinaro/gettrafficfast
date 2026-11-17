import { describe, expect, it } from "vitest";
import { parseSearchAnalyticsResponse } from "@/lib/providers/analytics/search-console";
import {
  groupRowsByArticle,
  nextSyncWindow,
  searchConsoleNeedsPull,
  normalizeUrl,
  RESETTLE_DAYS,
} from "@/lib/analytics/search-console";

/**
 * Search Console is the only ground truth in the platform, so the two things
 * that must not go wrong are attribution (a click credited to the wrong
 * article is worse than a missing one) and the sync window (a gap in the
 * series cannot be reconstructed later).
 */

describe("parseSearchAnalyticsResponse", () => {
  it("maps date and page out of the dimension keys", () => {
    const rows = parseSearchAnalyticsResponse({
      rows: [
        {
          keys: ["2026-08-20", "https://example.com/post"],
          clicks: 4,
          impressions: 120,
          position: 7.4,
        },
      ],
    });
    expect(rows).toEqual([
      { date: "2026-08-20", page: "https://example.com/post", clicks: 4, impressions: 120, position: 7.4 },
    ]);
  });

  it("drops rows that cannot be attributed to a page", () => {
    const rows = parseSearchAnalyticsResponse({
      rows: [{ keys: ["2026-08-20"], clicks: 9, impressions: 9 }, { clicks: 1 }],
    });
    expect(rows).toEqual([]);
  });

  it("treats missing counters as zero, not as absent", () => {
    const rows = parseSearchAnalyticsResponse({
      rows: [{ keys: ["2026-08-20", "https://example.com/a"] }],
    });
    expect(rows[0]).toMatchObject({ clicks: 0, impressions: 0, position: 0 });
  });
});

describe("normalizeUrl", () => {
  it("ignores the differences that do not change the page", () => {
    const canonical = normalizeUrl("https://example.com/post");
    expect(normalizeUrl("https://www.example.com/post/")).toBe(canonical);
    expect(normalizeUrl("HTTPS://Example.com/POST")).toBe(canonical);
    expect(normalizeUrl("https://example.com/post?utm_source=x")).toBe(canonical);
  });

  it("keeps different pages different", () => {
    expect(normalizeUrl("https://example.com/a")).not.toBe(normalizeUrl("https://example.com/b"));
  });
});

describe("groupRowsByArticle", () => {
  const articles = [
    { id: "art-1", publishedUrl: "https://example.com/first" },
    { id: "art-2", publishedUrl: "https://example.com/second" },
  ];

  it("never credits a page it cannot attribute", () => {
    const grouped = groupRowsByArticle(
      [{ date: "2026-08-20", page: "https://example.com/unknown", clicks: 99, impressions: 99, position: 1 }],
      articles
    );
    expect(grouped).toEqual([]);
  });

  it("sums variants of the same page and weights position by impressions", () => {
    const grouped = groupRowsByArticle(
      [
        { date: "2026-08-20", page: "https://example.com/first", clicks: 1, impressions: 100, position: 10 },
        { date: "2026-08-20", page: "https://www.example.com/first/", clicks: 3, impressions: 300, position: 2 },
      ],
      articles
    );

    expect(grouped).toHaveLength(1);
    expect(grouped[0].clicks).toBe(4);
    expect(grouped[0].impressions).toBe(400);
    // A position seen by 300 people weighs three times one seen by 100:
    // (10*100 + 2*300) / 400 = 4. A plain average would have said 6.
    expect(grouped[0].position).toBeCloseTo(4);
  });

  it("keeps days separate", () => {
    const grouped = groupRowsByArticle(
      [
        { date: "2026-08-20", page: "https://example.com/first", clicks: 1, impressions: 10, position: 5 },
        { date: "2026-08-21", page: "https://example.com/first", clicks: 2, impressions: 20, position: 4 },
      ],
      articles
    );
    expect(grouped.map((g) => g.date).sort()).toEqual(["2026-08-20", "2026-08-21"]);
  });
});

describe("nextSyncWindow", () => {
  const today = new Date("2026-08-28T00:00:00Z");

  it("reaches back on a first sync", () => {
    const window = nextSyncWindow(null, today, 90);
    expect(window.startDate).toBe("2026-05-30");
    expect(window.endDate).toBe("2026-08-26");
  });

  it("never asks for days Google has not settled yet", () => {
    const window = nextSyncWindow(null, today, 90);
    const lag = (new Date("2026-08-28").getTime() - new Date(window.endDate).getTime()) / 86_400_000;
    expect(lag).toBe(RESETTLE_DAYS - 1);
  });

  it("resumes with an overlap instead of from the watermark", () => {
    // Re-reading the tail is what stops a number being frozen while Search
    // Console was still revising it.
    const window = nextSyncWindow("2026-08-20", today, 90);
    expect(window.startDate).toBe("2026-08-17");
    expect(window.endDate).toBe("2026-08-26");
  });
});

describe("searchConsoleNeedsPull", () => {
  const today = new Date("2026-10-08T12:00:00Z");

  it("is due when nothing has been pulled, and when the watermark is behind the settled day", () => {
    expect(searchConsoleNeedsPull(null, today)).toBe(true);
    expect(searchConsoleNeedsPull("2026-10-05", today)).toBe(true);
  });

  it("is not due when the watermark is already the newest settled day", () => {
    expect(nextSyncWindow("2026-10-01", today).endDate).toBe("2026-10-06");
    expect(searchConsoleNeedsPull("2026-10-06", today)).toBe(false);
  });
});
