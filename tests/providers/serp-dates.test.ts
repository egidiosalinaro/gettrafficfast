import { describe, expect, it } from "vitest";
import { parseEngineDate } from "@/lib/providers/serp/dates";
import {
  REDDIT_SEED_ANCHORS,
  redditArchivedBelow,
  redditIdAtOrBelow,
  redditIdValue,
} from "@/lib/providers/discovery/reddit-ids";

/**
 * The date a search engine shows beside a result, read as the bound it is;
 * and the two facts about Reddit that let an undated thread be aged from
 * its id. Neither invents a moment: a distance becomes its latest instant
 * plus a width, an anchor only ever says "older than".
 */

const now = new Date("2026-09-29T12:00:00Z");

describe("parseEngineDate", () => {
  it("reads a calendar day in the languages the engine is asked in", () => {
    for (const [raw, day] of [
      ["Jun 6, 2025", "2025-06-06"],
      ["June 6, 2025", "2025-06-06"],
      ["6 Jun 2025", "2025-06-06"],
      ["Sept 12, 2026", "2026-09-12"],
      ["6 giu 2025", "2025-06-06"],
      ["6 giugno 2025", "2025-06-06"],
      ["6 jun 2025", "2025-06-06"],
      ["6 de junio de 2025", "2025-06-06"],
      ["6 juin 2025", "2025-06-06"],
      ["6. Juni 2025", "2025-06-06"],
      ["06.06.2025", "2025-06-06"],
      ["2025-06-06", "2025-06-06"],
    ] as const) {
      const parsed = parseEngineDate(raw, now);
      expect(parsed?.at.slice(0, 10), raw).toBe(day);
      expect(parsed?.precision, raw).toBe("day");
    }
  });

  it("reads a distance as its latest instant and its width", () => {
    expect(parseEngineDate("4 months ago", now)).toEqual({ at: "2026-05-29T12:00:00.000Z", precision: "month" });
    expect(parseEngineDate("4 mesi fa", now)).toEqual({ at: "2026-05-29T12:00:00.000Z", precision: "month" });
    expect(parseEngineDate("hace 4 meses", now)).toEqual({ at: "2026-05-29T12:00:00.000Z", precision: "month" });
    expect(parseEngineDate("il y a 4 mois", now)).toEqual({ at: "2026-05-29T12:00:00.000Z", precision: "month" });
    expect(parseEngineDate("vor 4 Monaten", now)).toEqual({ at: "2026-05-29T12:00:00.000Z", precision: "month" });
    expect(parseEngineDate("1 year ago", now)).toEqual({ at: "2025-09-29T12:00:00.000Z", precision: "year" });
    expect(parseEngineDate("2 years ago", now)).toEqual({ at: "2024-09-29T12:00:00.000Z", precision: "year" });
    expect(parseEngineDate("1 anno fa", now)).toEqual({ at: "2025-09-29T12:00:00.000Z", precision: "year" });
    expect(parseEngineDate("il y a 1 an", now)).toEqual({ at: "2025-09-29T12:00:00.000Z", precision: "year" });
    expect(parseEngineDate("vor 1 Jahr", now)).toEqual({ at: "2025-09-29T12:00:00.000Z", precision: "year" });
    expect(parseEngineDate("3 weeks ago", now)).toEqual({ at: "2026-09-08T12:00:00.000Z", precision: "week" });
    expect(parseEngineDate("2 settimane fa", now)).toEqual({ at: "2026-09-15T12:00:00.000Z", precision: "week" });
    expect(parseEngineDate("hace 2 días", now)).toEqual({ at: "2026-09-27T12:00:00.000Z", precision: "day" });
    expect(parseEngineDate("5 hours ago", now)).toEqual({ at: "2026-09-29T07:00:00.000Z", precision: "day" });
    expect(parseEngineDate("yesterday", now)).toEqual({ at: "2026-09-28T12:00:00.000Z", precision: "day" });
    expect(parseEngineDate("a month ago", now)).toEqual({ at: "2026-08-29T12:00:00.000Z", precision: "month" });
  });

  it("leaves anything else null rather than 'today'", () => {
    for (const raw of ["", "   ", null, undefined, "Best AI tools", "I keep losing rankings", "13/40/2025", "32.13.2025", "soon"]) {
      expect(parseEngineDate(raw, now), String(raw)).toBeNull();
    }
  });
});

describe("Reddit post ids", () => {
  it("orders ids as Reddit does: base 36, a longer id is always later", () => {
    expect(redditIdValue("1abc2d")).toBe(parseInt("1abc2d", 36));
    expect(redditIdAtOrBelow("pnlmdv", "1qtonc8")).toBe(true);
    expect(redditIdAtOrBelow("1l4x1q0", "1qtonc8")).toBe(true);
    expect(redditIdAtOrBelow("1qtonc8", "1qtonc8")).toBe(true);
    expect(redditIdAtOrBelow("1wdgutr", "1qtonc8")).toBe(false);
    // Not an id on either side: no opinion.
    expect(redditIdAtOrBelow("c51d61284b4f47ba0c4803bfc8bb2585", "1qtonc8")).toBe(false);
    expect(redditIdAtOrBelow("1abc2d", null)).toBe(false);
    expect(redditIdValue("owner/repo#12")).toBeNull();
  });

  it("takes the newest anchor already older than the window, and none when nothing is", () => {
    // 29 September 2026: "1qtonc8" was posted by 28 February (213 days),
    // "1rsqq3t" by 28 March (185 days), "1snu2bf" by 26 April (156 days).
    expect(redditArchivedBelow(REDDIT_SEED_ANCHORS, now)).toBe("1rsqq3t");
    // A month on, the two late-April anchors are old enough; the newer id wins.
    expect(redditArchivedBelow(REDDIT_SEED_ANCHORS, new Date("2026-10-29T00:00:00Z"))).toBe("1snu2bf");
    // Back in time, before any anchor is six months old: cannot tell.
    expect(redditArchivedBelow(REDDIT_SEED_ANCHORS, new Date("2024-01-01T00:00:00Z"))).toBeNull();
    // A stored, dated thread newer than every seed moves the bound up.
    expect(
      redditArchivedBelow([...REDDIT_SEED_ANCHORS, { id: "1t0000a", postedBefore: "2026-03-01T00:00:00Z" }], now)
    ).toBe("1t0000a");
    // An anchor that is not yet old enough does not, however new its id.
    expect(
      redditArchivedBelow([...REDDIT_SEED_ANCHORS, { id: "1wzzzzz", postedBefore: "2026-09-01T00:00:00Z" }], now)
    ).toBe("1rsqq3t");
  });
});
