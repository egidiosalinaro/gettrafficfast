import { describe, expect, it } from "vitest";
import { inWindow, parseGrowthDays, periodWindows } from "@/lib/growth/period";
import { growthHref } from "@/lib/growth/routes";

/**
 * The periods Growth compares, and the addresses that carry them: 7 days
 * unless the address says 28, whole UTC days, the window before of the same
 * length and touching.
 */

describe("periods", () => {
  it("reads 28 from the address and falls back to the week", () => {
    expect(parseGrowthDays("28")).toBe(28);
    expect(parseGrowthDays(["28", "7"])).toBe(28);
    expect(parseGrowthDays("28d")).toBe(28);
    expect(parseGrowthDays("30")).toBe(7);
    expect(parseGrowthDays(undefined)).toBe(7);
    expect(parseGrowthDays("x")).toBe(7);
  });

  it("ends the current window on its anchor and puts the same length just before", () => {
    expect(periodWindows(7, "2026-11-14")).toEqual({
      days: 7,
      current: { from: "2026-11-08", to: "2026-11-14" },
      previous: { from: "2026-11-01", to: "2026-11-07" },
    });
    expect(periodWindows(28, "2026-11-11")).toEqual({
      days: 28,
      current: { from: "2026-10-15", to: "2026-11-11" },
      previous: { from: "2026-09-17", to: "2026-10-14" },
    });
  });

  it("reads a timestamp as its UTC day, both ends included", () => {
    const w = { from: "2026-11-08", to: "2026-11-14" };
    expect(inWindow("2026-11-08", w)).toBe(true);
    expect(inWindow("2026-11-14T23:59:59.000Z", w)).toBe(true);
    expect(inWindow("2026-11-07T23:59:59.000Z", w)).toBe(false);
    expect(inWindow(null, w)).toBe(false);
  });
});

describe("addresses", () => {
  it("needs no days for the default week", () => {
    expect(growthHref("/growth", 7)).toBe("/growth");
    expect(growthHref("/growth/ai", 28, { engine: "gemini" })).toBe("/growth/ai?days=28&engine=gemini");
    expect(growthHref("/growth/ai", 7, { engine: null })).toBe("/growth/ai");
  });
});
