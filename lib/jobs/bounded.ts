/**
 * Runs `run` over `items` with at most `limit` calls in flight, and hands the
 * results back by index, so whoever writes them can write them in the order
 * a sequential loop would have (2026-11-12: the qualify step judged its
 * batches one after the other, about 30 s each, and a run spent six minutes
 * there).
 *
 * Before each start it asks `admit(inFlight)`:
 *   - "start": start the next item;
 *   - "wait":  not now (a budget that cannot cover one more call in flight);
 *              tried again when a running call ends. With nothing in flight
 *              the item starts anyway, so the call itself refuses, exactly
 *              as it would have in the sequential loop;
 *   - "stop":  start nothing more (out of time). The calls in flight finish.
 *
 * The first failure, by index, stops new starts; the calls already in flight
 * finish and their results are kept (they were paid for). Never throws: the
 * failure is returned beside the results, for the caller to write what
 * finished and then rethrow it.
 */

export type Admission = "start" | "wait" | "stop";

export interface BoundedOutcome<R> {
  /** By index; undefined for an item that failed or never started. */
  results: Array<R | undefined>;
  /** The failure with the lowest index, or null. */
  error: unknown;
  errorIndex: number;
  /** Items started, from the first: the rest were never asked. */
  started: number;
}

export async function runBounded<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T, index: number) => Promise<R>,
  options: { admit?: (inFlight: number) => Admission; onSettled?: (index: number, result: R | undefined) => void | Promise<void> } = {}
): Promise<BoundedOutcome<R>> {
  const width = Math.max(1, Math.floor(limit));
  const results: Array<R | undefined> = new Array(items.length).fill(undefined);
  const inFlight = new Map<number, Promise<void>>();
  let next = 0;
  let error: unknown = null;
  let errorIndex = -1;
  let stopped = false;

  for (;;) {
    while (!stopped && errorIndex < 0 && next < items.length && inFlight.size < width) {
      const verdict = options.admit ? options.admit(inFlight.size) : "start";
      if (verdict === "stop") {
        stopped = true;
        break;
      }
      if (verdict === "wait" && inFlight.size > 0) break;
      const index = next++;
      const settled = Promise.resolve()
        .then(() => run(items[index], index))
        .then(async (value) => {
          results[index] = value;
          await options.onSettled?.(index, value);
        })
        .catch((err) => {
          if (errorIndex < 0 || index < errorIndex) {
            error = err;
            errorIndex = index;
          }
        })
        .finally(() => {
          inFlight.delete(index);
        });
      inFlight.set(index, settled);
    }
    if (inFlight.size === 0) break;
    await Promise.race(inFlight.values());
  }

  return { results, error, errorIndex, started: next };
}
