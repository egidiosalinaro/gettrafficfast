/**
 * Time limits for a model call.
 *
 * A vendor that never answers used to hold the function until the platform
 * killed it. The kill skips every cleanup, so the job stayed locked and the
 * person who clicked saw a spinner die into silence. A call now ends on its
 * own: the caller's abort (the job's deadline) or this timeout, whichever
 * comes first.
 */

/** One generation. Long enough for a quality draft, short enough to try the next model. */
export const LLM_CALL_TIMEOUT_MS = 40_000;

/** ListModels is a catalogue, not the answer. A hang here must not be the draft. */
export const LIST_MODELS_TIMEOUT_MS = 8_000;

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

export function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && err.name === "TimeoutError";
}

export function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  return new DOMException("The operation was aborted", "AbortError");
}

function timeoutError(): Error {
  const error = new Error("The model did not answer in time");
  error.name = "TimeoutError";
  return error;
}

/**
 * Runs `work` with a signal that aborts when `caller` aborts or when
 * `timeoutMs` passes. A caller abort rejects with that abort. A timeout
 * rejects with TimeoutError, which is a failure of this call, so the caller
 * can try another model.
 */
export async function withDeadline<T>(
  caller: AbortSignal | undefined,
  timeoutMs: number,
  work: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  if (caller?.aborted) throw abortError(caller);

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onCaller = () => controller.abort();
  caller?.addEventListener("abort", onCaller);

  try {
    return await work(controller.signal);
  } catch (err) {
    if (caller?.aborted) throw abortError(caller);
    if (timedOut) throw timeoutError();
    throw err;
  } finally {
    clearTimeout(timer);
    caller?.removeEventListener("abort", onCaller);
  }
}

/**
 * An abort that fires `marginMs` before `deadline`, and also when `parent`
 * aborts. `cancel` stops the timer once the work has finished.
 */
export function abortAt(
  deadline: number,
  marginMs: number,
  parent?: AbortSignal
): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  if (parent?.aborted) {
    controller.abort(parent.reason);
    return { signal: controller.signal, cancel: () => {} };
  }

  const delay = Math.max(0, deadline - marginMs - Date.now());
  const timer = setTimeout(() => controller.abort(abortError()), delay);
  const onParent = () => controller.abort(abortError(parent));
  parent?.addEventListener("abort", onParent);

  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParent);
    },
  };
}
