import { parse } from "node-html-parser";
import { safeFetch } from "@/lib/providers/safe-fetch";
import { isXShortLink } from "./links";
import { SITE_URL } from "@/lib/site";

export { isXShortLink };

/**
 * Where one of X's short links (`https://t.co/…`) points, without going there.
 *
 * X's oEmbed hands over a post that quotes another with the quoted post as a
 * t.co link in its text, never the quoted post itself. Reading where that
 * link points is one free request to t.co: its answer is a redirect (or, for
 * a browser, a page whose refresh names the address). The link is never
 * followed: the address is handed back and the caller decides what it is
 * (lib/placements/referenced.ts reads a post on X from it, through oEmbed).
 *
 * Through `safeFetch`, as every address read out of someone else's content:
 * only t.co is ever asked, with a short deadline and a small body. Null for
 * anything that is not an answer naming an http(s) address: a timeout, a
 * refusal, an unknown link. Never throws.
 */

export const SHORT_LINK_TIMEOUT_MS = 5_000;
/** A redirect has no body worth reading; a refresh page is a few hundred bytes. */
const MAX_BYTES = 64 * 1024;
const USER_AGENT = `gettrafficfast/1.0 (+${SITE_URL})`;

function httpAddress(raw: string | null | undefined, base: string): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw.trim(), base);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** The address of a refresh page (`<meta http-equiv="refresh" content="0;URL=…">`), or null. */
export function refreshTarget(html: string, base: string): string | null {
  const root = parse(html);
  const meta = root
    .querySelectorAll("meta")
    .find((m) => (m.getAttribute("http-equiv") ?? "").toLowerCase() === "refresh");
  const content = meta?.getAttribute("content") ?? "";
  const match = /url\s*=\s*['"]?([^'"\s]+)/i.exec(content);
  return match ? httpAddress(match[1], base) : null;
}

export type ShortLinkFetch = (url: string, init: RequestInit) => Promise<Response>;

/** The address a t.co link points to, or null when it cannot be read. */
export async function resolveXShortLink(
  raw: string,
  options: { fetchImpl?: ShortLinkFetch; timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<string | null> {
  if (!isXShortLink(raw)) return null;
  const url = new URL(raw);
  url.protocol = "https:";
  const timeoutMs = options.timeoutMs ?? SHORT_LINK_TIMEOUT_MS;
  const fetchImpl: ShortLinkFetch =
    options.fetchImpl ?? ((input, init) => safeFetch(input, init, { timeoutMs, maxBytes: MAX_BYTES, maxRedirects: 0 }));
  try {
    const response = await fetchImpl(url.toString(), {
      method: "GET",
      redirect: "manual",
      headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
    if (response.status >= 300 && response.status <= 399) return httpAddress(response.headers.get("location"), url.toString());
    if (!response.ok) return null;
    return refreshTarget(await response.text(), url.toString());
  } catch {
    return null;
  }
}
