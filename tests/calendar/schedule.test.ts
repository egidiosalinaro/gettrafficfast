import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { FakeSupabase } from "../support/fake-supabase";
import { firstFreeDays, nextFreeDays, utcDay } from "@/lib/calendar/schedule";

/**
 * The one rule "Add to calendar" and the bulk add share: the first days after
 * today that the site has no article on. It used to be written out twice in
 * the routes; the reference below is that inline loop as it ran on the server
 * (UTC), kept here to pin that the extraction changed nothing.
 */

function inlineReference(taken: string[], count: number, now: Date): string[] {
  const today = new Date(now);
  today.setUTCHours(0, 0, 0, 0);
  const usedDates = new Set(taken);
  const candidate = new Date(today);
  return Array.from({ length: count }, () => {
    candidate.setUTCDate(candidate.getUTCDate() + 1);
    let dateStr = candidate.toISOString().slice(0, 10);
    while (usedDates.has(dateStr)) {
      candidate.setUTCDate(candidate.getUTCDate() + 1);
      dateStr = candidate.toISOString().slice(0, 10);
    }
    usedDates.add(dateStr);
    return dateStr;
  });
}

const now = new Date("2026-11-09T15:30:00Z");

describe("firstFreeDays", () => {
  it("starts tomorrow, never today or the past", () => {
    expect(firstFreeDays([], 1, now)).toEqual(["2026-11-10"]);
    expect(firstFreeDays(["2026-11-09"], 1, now)).toEqual(["2026-11-10"]);
  });

  it("skips taken days and hands out consecutive free ones in order", () => {
    expect(firstFreeDays(["2026-11-10", "2026-11-12"], 3, now)).toEqual([
      "2026-11-11",
      "2026-11-13",
      "2026-11-14",
    ]);
  });

  it("crosses month and year ends on UTC days", () => {
    expect(firstFreeDays(["2027-01-01"], 2, new Date("2026-12-31T23:59:59Z"))).toEqual([
      "2027-01-02",
      "2027-01-03",
    ]);
  });

  it("returns nothing for nothing asked", () => {
    expect(firstFreeDays(["2026-11-10"], 0, now)).toEqual([]);
  });

  it("matches the inline loop the two routes used to carry", () => {
    let seed = 7;
    const random = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
    for (let run = 0; run < 200; run++) {
      const at = new Date(Date.UTC(2026, 0, 1) + Math.floor(random() * 730) * 86_400_000 + Math.floor(random() * 86_400_000));
      const taken = Array.from({ length: Math.floor(random() * 15) }, () =>
        utcDay(new Date(at.getTime() + Math.floor(random() * 20) * 86_400_000))
      );
      const count = 1 + Math.floor(random() * 8);
      expect(firstFreeDays(taken, count, at)).toEqual(inlineReference(taken, count, at));
    }
  });
});

describe("nextFreeDays", () => {
  const client = (db: FakeSupabase) => db as unknown as SupabaseClient;

  it("reads only this site's calendar from today on", async () => {
    const db = new FakeSupabase({
      articles: [
        { id: "a-1", business_id: "biz-1", scheduled_date: "2026-11-10" },
        { id: "a-2", business_id: "biz-1", scheduled_date: "2026-11-11" },
        // Another site of the same account: same day is fine.
        { id: "a-3", business_id: "biz-2", scheduled_date: "2026-11-12" },
      ],
    });
    expect(await nextFreeDays(client(db), "biz-1", 2, now)).toEqual(["2026-11-12", "2026-11-13"]);
    expect(await nextFreeDays(client(db), "biz-2", 1, now)).toEqual(["2026-11-10"]);
  });

  it("does not read at all for nothing asked", async () => {
    const db = new FakeSupabase();
    expect(await nextFreeDays(client(db), "biz-1", 0, now)).toEqual([]);
    expect(db.calls).toEqual([]);
  });

  it("throws rather than read an unreadable calendar as an empty one", async () => {
    const failing = {
      from: () => {
        const query = {
          select: () => query,
          eq: () => query,
          gte: async () => ({ data: null, error: { message: "boom" } }),
        };
        return query;
      },
    } as unknown as SupabaseClient;
    await expect(nextFreeDays(failing, "biz-1", 1, now)).rejects.toThrow(/calendar/);
  });
});
