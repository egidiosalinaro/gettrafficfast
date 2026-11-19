import { describe, expect, it } from "vitest";
import { COUNT_PAGE, readAllCountRows } from "@/lib/placements/read";

/**
 * Regression, 2026-11-11: the inbox counted views from one select, which the
 * API cuts at 1,000 rows. A site with 2,313 rows lost its posted replies past
 * the cap, so "Posted" left the filter and "N today" read 0.
 */
function fakeClient(total: number, withCount = false) {
  const calls: [number, number][] = [];
  let counting = false;
  let inFlight = 0;
  let maxInFlight = 0;
  const rows = Array.from({ length: total }, (_, i) => ({ id: String(i).padStart(6, "0"), status: i % 100 === 0 ? "published_manually" : "rejected" }));
  const builder = {
    select: (_columns: string, options?: { count?: string }) => {
      counting = withCount && options?.count === "exact";
      return builder;
    },
    eq: () => builder,
    order: () => builder,
    range: async (from: number, to: number) => {
      const count = counting ? total : null;
      calls.push([from, to]);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return { data: rows.slice(from, Math.min(to + 1, from + COUNT_PAGE)), error: null, count };
    },
  };
  return { client: { from: () => builder } as never, calls, maxInFlight: () => maxInFlight };
}

describe("readAllCountRows", () => {
  it("reads every row past the 1,000-row cap, page by page", async () => {
    const { client, calls } = fakeClient(2313);
    const { data, error } = await readAllCountRows(client, "b1");
    expect(error).toBeNull();
    expect(data).toHaveLength(2313);
    expect(data.filter((row) => row.status === "published_manually")).toHaveLength(24);
    expect(calls).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
  });

  it("with the total known, reads the pages after the first side by side (2026-11-19)", async () => {
    const { client, calls, maxInFlight } = fakeClient(3514, true);
    const { data, error } = await readAllCountRows(client, "b1");
    expect(error).toBeNull();
    expect(data).toHaveLength(3514);
    expect(calls).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
      [3000, 3999],
    ]);
    expect(maxInFlight()).toBe(3);
  });

  it("with the total known and one full page, asks no more", async () => {
    const { client, calls } = fakeClient(1000, true);
    expect((await readAllCountRows(client, "b1")).data).toHaveLength(1000);
    expect(calls).toHaveLength(1);
  });

  it("stops after one page when the site has fewer rows", async () => {
    const { client, calls } = fakeClient(12);
    const { data } = await readAllCountRows(client, "b1");
    expect(data).toHaveLength(12);
    expect(calls).toHaveLength(1);
  });

  it("asks once more when the last page is exactly full", async () => {
    const { client, calls } = fakeClient(1000);
    const { data } = await readAllCountRows(client, "b1");
    expect(data).toHaveLength(1000);
    expect(calls).toHaveLength(2);
  });
});
