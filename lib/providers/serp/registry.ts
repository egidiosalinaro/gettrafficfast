import { SerpProvider } from "./types";
import { SerperProvider } from "./serper";

/**
 * Resolves the SERP provider, or null when none is configured — SERP research
 * degrades to "skipped", never to a failure. Additional vendors slot in here
 * behind the same interface; nothing above this file names one.
 */

let cached: SerpProvider | null | undefined;

export function getSerpProvider(): SerpProvider | null {
  if (cached !== undefined) return cached;
  const key = process.env.SERPER_API_KEY;
  cached = key ? new SerperProvider(key) : null;
  return cached;
}

/** Test seam. */
export function setSerpProvider(provider: SerpProvider | null | undefined): void {
  cached = provider;
}
