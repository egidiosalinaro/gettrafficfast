import { describe, expect, it } from "vitest";
import { runBounded } from "@/lib/jobs/bounded";

/**
 * The pool the qualify step and the web search run their calls through
 * (2026-11-12): results come back by index whatever order the calls end in,
 * never more than the limit in flight, and the first failure stops new
 * starts while what was already paid for is kept.
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("runBounded", () => {
  it("hands the results back in the items' order, whatever order the calls end in", async () => {
    const items = [40, 5, 30, 1, 20, 10, 0];
    const sequential: number[] = [];
    for (const item of items) sequential.push(item * 2);

    const outcome = await runBounded(items, 3, async (item) => {
      await sleep(item);
      return item * 2;
    });
    expect(outcome.results).toEqual(sequential);
    expect(outcome.errorIndex).toBe(-1);
    expect(outcome.started).toBe(items.length);
  });

  it("never has more than the limit in flight, and does use it", async () => {
    let inFlight = 0;
    let most = 0;
    await runBounded(Array.from({ length: 12 }, (_, i) => i), 4, async (i) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await sleep(3 + (i % 3));
      inFlight -= 1;
      return i;
    });
    expect(most).toBe(4);
  });

  it("stops starting on the first failure, keeps what finished beside it, and reports the lowest index", async () => {
    const started: number[] = [];
    const outcome = await runBounded([0, 1, 2, 3, 4, 5, 6, 7], 2, async (i) => {
      started.push(i);
      await sleep(i === 2 ? 1 : 5);
      if (i === 2) throw new Error("refused");
      return i;
    });
    expect(outcome.errorIndex).toBe(2);
    expect((outcome.error as Error).message).toBe("refused");
    // 3 was started beside 2 and finished: paid for, so kept.
    expect(outcome.results.slice(0, 4)).toEqual([0, 1, undefined, 3]);
    expect(started).not.toContain(5);
    expect(outcome.started).toBeLessThan(8);
  });

  it("waits when admission says so, starts alone anyway, and stops when told", async () => {
    let calls = 0;
    const waitOutcome = await runBounded([1, 2, 3], 3, async (i) => {
      calls += 1;
      return i;
    }, { admit: (inFlight) => (inFlight === 0 ? "start" : "wait") });
    // "wait" with nothing in flight starts: one at a time, all of them.
    expect(waitOutcome.results).toEqual([1, 2, 3]);
    expect(calls).toBe(3);

    let asked = 0;
    const stopOutcome = await runBounded([1, 2, 3], 3, async (i) => i, {
      admit: () => (++asked > 1 ? "stop" : "start"),
    });
    expect(stopOutcome.started).toBe(1);
    expect(stopOutcome.results).toEqual([1, undefined, undefined]);
  });
});
