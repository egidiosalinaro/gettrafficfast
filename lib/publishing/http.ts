/**
 * Shared HTTP transport for publisher adapters: one timeout policy, one set of
 * network-error messages. Adapters differ in the API they speak, not in how
 * they make requests.
 */

import { BlockedAddressError, safeFetch } from "@/lib/providers/safe-fetch";
import { SITE_URL } from "@/lib/site";

export const USER_AGENT = `gettrafficfast/1.0 (+${SITE_URL})`;
export const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Every adapter request goes through `safeFetch`: the URL is the customer's,
 * so it must resolve to a public address, at every redirect hop
 * (lib/providers/safe-fetch.ts).
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number = REQUEST_TIMEOUT_MS
): Promise<Response> {
  return safeFetch(url, init, { timeoutMs });
}

/** Turns an opaque fetch/undici failure into something a customer can act on. */
export function wrapFetchError(err: unknown, target: string): Error {
  const e = err instanceof Error ? err : new Error(String(err));
  if (e instanceof BlockedAddressError) {
    return new Error(`Cannot reach ${target}: it is not a public http(s) address.`);
  }
  if (e.name === "AbortError") {
    return new Error(
      `Timeout reaching ${target} after ${REQUEST_TIMEOUT_MS / 1000}s — the endpoint did not respond.`
    );
  }
  const cause = (e as { cause?: { code?: string; message?: string } }).cause;
  const code = cause?.code;
  const detail = cause?.message || e.message;
  if (code === "ENOTFOUND") return new Error(`Cannot resolve ${target}: domain not found (${code})`);
  if (code === "ECONNREFUSED" || code === "ECONNRESET") {
    return new Error(`Cannot reach ${target}: connection refused (${code})`);
  }
  if (code === "CERT_HAS_EXPIRED" || code?.startsWith("UNABLE_TO_VERIFY")) {
    return new Error(`TLS error for ${target}: ${code}`);
  }
  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") {
    return new Error(`Timeout reaching ${target}`);
  }
  return new Error(`Network error for ${target}: ${detail}${code ? ` (${code})` : ""}`);
}

/** Best-effort extraction of a human-readable API error message. */
export async function readErrorBody(res: Response): Promise<string> {
  try {
    const data = await res.json();
    return (data as { message?: string })?.message || `${res.status} ${res.statusText}`;
  } catch {
    return `${res.status} ${res.statusText}`;
  }
}

export function normalizeHttpUrl(input: string, label: string): string {
  const trimmed = input.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`${label} is not a valid URL`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${label} must use http:// or https://`);
  }
  return parsed.toString();
}
