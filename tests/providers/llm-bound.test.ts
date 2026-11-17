import { describe, expect, it, vi } from "vitest";
import { abortAt, isTimeoutError, withDeadline } from "@/lib/providers/llm/bound";

describe("withDeadline", () => {
  it("returns the work's result and cancels the timer", async () => {
    const result = await withDeadline(undefined, 5_000, async () => "ok");
    expect(result).toBe("ok");
  });

  it("rejects with TimeoutError when the work outlives the limit, so another model can be tried", async () => {
    vi.useFakeTimers();
    const pending = withDeadline(
      undefined,
      40,
      (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        })
    );
    const assertion = expect(pending).rejects.toSatisfy(isTimeoutError);
    await vi.advanceTimersByTimeAsync(40);
    await assertion;
    vi.useRealTimers();
  });

  it("a caller's abort is not a timeout", async () => {
    const caller = new AbortController();
    const pending = withDeadline(
      caller.signal,
      5_000,
      (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        })
    );
    caller.abort();
    const error = await pending.catch((err) => err);
    expect(isTimeoutError(error)).toBe(false);
    expect(error).toMatchObject({ name: "AbortError" });
  });
});

describe("abortAt", () => {
  it("aborts margin before the deadline", async () => {
    vi.useFakeTimers();
    const timed = abortAt(Date.now() + 5_000, 1_000);
    expect(timed.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(timed.signal.aborted).toBe(true);
    expect(timed.signal.reason).toMatchObject({ name: "AbortError" });
    timed.cancel();
    vi.useRealTimers();
  });

  it("cancel stops the abort", async () => {
    vi.useFakeTimers();
    const timed = abortAt(Date.now() + 5_000, 1_000);
    timed.cancel();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(timed.signal.aborted).toBe(false);
    vi.useRealTimers();
  });
});
