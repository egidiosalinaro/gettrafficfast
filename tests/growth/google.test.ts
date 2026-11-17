import { describe, expect, it } from "vitest";
import { coverageStart, summarizeSearchGrowth, type SearchDay } from "@/lib/growth/google";

/**
 * Growth → Google. Pinned: nothing ingested is null, never 0; the windows
 * end on the newest day ingested (the watermark), not on today; a day with
 * no row inside the data is a real zero; a window before the data starts
 * is "no comparison", not growth from zero; the average position is
 * weighted by impressions, one decimal, and its change is positive up the
 * page.
 */

const day = (d: string, impressions: number, clicks: number, position: number | null = 10): SearchDay => ({ day: d, impressions, clicks, position });

describe("summarizeSearchGrowth", () => {
  it("is null over nothing, never 0", () => {
    const none = summarizeSearchGrowth([], { days: 7 });
    expect(none.current).toBeNull();
    expect(none.previous).toBeNull();
    expect(none.change).toEqual({ impressions: null, clicks: null, averagePosition: null });
  });

  it("compares the 7 days ending on the watermark with the 7 before", () => {
    const g = summarizeSearchGrowth(
      [day("2026-11-01", 50, 1, 20), day("2026-11-03", 50, 0, 20), day("2026-11-08", 100, 2, 12), day("2026-11-10", 100, 1, 8)],
      { days: 7, through: "2026-11-11", coveredFrom: "2026-08-01" }
    );
    expect(g.settledThrough).toBe("2026-11-11");
    expect(g.current).toEqual({ from: "2026-11-05", to: "2026-11-11", impressions: 200, clicks: 3, averagePosition: 10 });
    expect(g.previous).toEqual({ from: "2026-10-29", to: "2026-11-04", impressions: 100, clicks: 1, averagePosition: 20 });
    expect(g.change).toEqual({ impressions: 100, clicks: 2, averagePosition: 10 });
  });

  it("weights the position by impressions, to one decimal", () => {
    // 1 impression at 90 and 99 at 5: Google's average is near 5.9, not 47.5.
    const g = summarizeSearchGrowth([day("2026-11-10", 1, 0, 90), day("2026-11-10", 99, 0, 5)], { days: 7, coveredFrom: "2026-01-01" });
    expect(g.current?.averagePosition).toBe(5.9);
  });

  it("counts a week inside the data with no row as a real zero, with no position", () => {
    const g = summarizeSearchGrowth([day("2026-10-20", 30, 1), day("2026-11-10", 5, 0)], { days: 7, coveredFrom: "2026-09-01" });
    expect(g.previous).toMatchObject({ impressions: 0, clicks: 0, averagePosition: null });
    expect(g.change.impressions).toBe(5);
    expect(g.change.averagePosition).toBeNull();
  });

  it("says no comparison when the week before is older than the data", () => {
    const g = summarizeSearchGrowth([day("2026-11-08", 30, 1), day("2026-11-10", 5, 0)], { days: 7, coveredFrom: "2026-11-06" });
    expect(g.current?.impressions).toBe(35);
    expect(g.previous).toBeNull();
    expect(g.change).toEqual({ impressions: null, clicks: null, averagePosition: null });
  });

  it("takes the oldest row as the start of the data when the connection does not say", () => {
    const g = summarizeSearchGrowth([day("2026-11-02", 30, 1), day("2026-11-10", 5, 0)], { days: 7 });
    expect(g.coveredFrom).toBe("2026-11-02");
    expect(g.previous).toBeNull();
  });

  it("reads a slip down the page as a negative change, rounded, never -0", () => {
    const g = summarizeSearchGrowth([day("2026-11-01", 10, 0, 28.44), day("2026-11-10", 10, 0, 41.43)], { days: 7, coveredFrom: "2026-01-01" });
    expect(g.change.averagePosition).toBe(-13);
    const same = summarizeSearchGrowth([day("2026-11-01", 10, 0, 8.04), day("2026-11-10", 10, 0, 8.01)], { days: 7, coveredFrom: "2026-01-01" });
    expect(Object.is(same.change.averagePosition, -0)).toBe(false);
  });
});

describe("coverageStart", () => {
  it("is the connection's day minus the first pull's reach", () => {
    expect(coverageStart("2026-09-22T12:15:30.086Z", 90)).toBe("2026-06-24");
    expect(coverageStart(null, 90)).toBeNull();
    expect(coverageStart("not a date", 90)).toBeNull();
  });
});
