/**
 * The one HTTP detail every vendor shares: how it asks to be called again.
 * Kept here so no provider imports another provider to read a header.
 */

/** Reads a Retry-After header as seconds, whichever of the two forms it took. */
export function retryAfterSecondsFrom(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const at = Date.parse(header);
  if (Number.isFinite(at)) return Math.max(0, Math.ceil((at - Date.now()) / 1000));
  return undefined;
}
