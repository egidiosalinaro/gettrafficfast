import { domainOf } from "@/lib/providers/serp/types";

/**
 * Reading a cited source back to the page it stands for.
 *
 * One engine does not return the page it cited: a grounded Gemini answer
 * returns a Google redirect (vertexaisearch.cloud.google.com/
 * grounding-api-redirect/...) with the site's domain as the title (see
 * ./gemini.ts). The domain is enough to judge "were we cited"; it is not
 * enough to act on a source, because "reddit.com" is not a thread.
 *
 * `resolveSourceUrl` asks the redirect where it points and returns that
 * address, without ever fetching the page itself. It is a plain HTTP request
 * to the vendor's own redirector: no model, no key, nothing billed. The
 * redirects expire, so an old run's sources may no longer resolve; that
 * comes back as null, and null is "could not be read back", never a guess.
 */

/** Wall clock for one redirect lookup. */
export const RESOLVE_TIMEOUT_MS = 4_000;

/**
 * True when `host` is Google's own: google.com, googleapis.com or a
 * subdomain of either. Matched on the label boundary, never as a plain
 * suffix: `evilgoogle.com` ends with "google.com" and is not Google.
 */
export function isGoogleHost(host: string): boolean {
  const h = host.toLowerCase();
  return ["google.com", "googleapis.com"].some((domain) => h === domain || h.endsWith(`.${domain}`));
}

/** True when `url` is a vendor redirect standing in for the cited page. */
export function isSourceRedirect(url: string): boolean {
  const host = domainOf(url);
  if (!host) return false;
  return isGoogleHost(host) && /\/grounding-api-redirect\//.test(url);
}

export type SourceResolver = (url: string, signal?: AbortSignal) => Promise<string | null>;

/**
 * The address a source redirect points at, or null when it no longer says
 * (expired, unreachable, not a redirect response). One hop only: the answer
 * is the `Location` the vendor returns, and the page behind it is not
 * requested.
 */
export const resolveSourceUrl: SourceResolver = async (url, signal) => {
  if (!isSourceRedirect(url)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RESOLVE_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetch(url, { method: "GET", redirect: "manual", signal: controller.signal });
    if (response.status < 300 || response.status >= 400) return null;
    const location = response.headers.get("location");
    if (!location) return null;
    let target: URL;
    try {
      target = new URL(location, url);
    } catch {
      return null;
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") return null;
    // A redirect to another redirect of the same vendor is not a page.
    if (isSourceRedirect(target.toString())) return null;
    return target.toString();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
};

/**
 * Resolves `urls` a few at a time, stopping when `deadline` (epoch ms) is
 * near. Returns only the ones that resolved; the caller counts the rest as
 * unread.
 */
export async function resolveSourceUrls(
  urls: readonly string[],
  options: { resolve?: SourceResolver; concurrency?: number; deadline?: number; signal?: AbortSignal } = {}
): Promise<Map<string, string>> {
  const resolve = options.resolve ?? resolveSourceUrl;
  const out = new Map<string, string>();
  const queue = [...new Set(urls)];
  let cursor = 0;
  const worker = async () => {
    while (cursor < queue.length) {
      if (options.deadline !== undefined && options.deadline - Date.now() < RESOLVE_TIMEOUT_MS + 1_000) return;
      if (options.signal?.aborted) return;
      const url = queue[cursor];
      cursor += 1;
      const resolved = await resolve(url, options.signal).catch(() => null);
      if (resolved) out.set(url, resolved);
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency ?? 6, queue.length) }, worker));
  return out;
}
