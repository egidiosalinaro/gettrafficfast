/**
 * Where a post's author picture can be had by their public handle, with no
 * key and no call of ours.
 *
 * The one place an avatar host is named: the Replies item asks
 * `publicAvatarUrl` and never builds a URL itself, so swapping the proxy (or
 * turning it off) is an edit here. The URL is loaded by the person's browser
 * as an `<img>`, lazily and without a referrer; the server never fetches it,
 * so it is no paid call and no work on a request.
 *
 * - GitHub serves every account's picture at `github.com/<login>.png`, its
 *   own public address: first-party, free, no key. A login that does not
 *   exist answers 404.
 * - X and Reddit offer nothing like it without an API key (X's oEmbed, the
 *   free read the add-post path uses, carries no profile image; Reddit's
 *   listing carries the author's name only). For them the browser asks
 *   unavatar.io, a public avatar proxy, which receives the platform and the
 *   handle (and, being a request from the browser, the viewer's IP). Its
 *   anonymous use is rate-limited per IP (25 to 50 lookups a day according
 *   to its own pages in November 2026; a cached lookup does not count) and
 *   it reads X without X's blessing, so a picture is a nicety that can be
 *   missing on any given day. `fallback=false` makes it answer 404 rather
 *   than a generic picture when it has none: a picture shown is the
 *   author's or nothing.
 * - Everything else (LinkedIn, Hacker News, Quora, DEV, a web page): none.
 *   LinkedIn pictures are not public by handle, Hacker News has none.
 *
 * The caller falls back to initials on any error, so a 404, a 429 or a
 * blocked host reads the same: no picture.
 */

/** The proxy for platforms without a first-party address. Change it here, nowhere else. */
export const AVATAR_PROXY_BASE = "https://unavatar.io";

/** The platforms the proxy is asked for, by their key in the proxy's URL. */
const PROXIED: Record<string, string> = {
  x: "x",
  reddit: "reddit",
};

/** A handle as each platform allows it, so a display name or a URL never becomes a lookup. */
const HANDLE: Record<string, RegExp> = {
  x: /^\w{1,15}$/,
  reddit: /^[\w-]{3,20}$/,
  github: /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i,
};

/** Hosts an avatar may come from, for a test or a content policy. */
export const AVATAR_HOSTS = ["github.com", new URL(AVATAR_PROXY_BASE).hostname] as const;

/**
 * The address of `handle`'s picture on `surface`, or null when there is no
 * keyless public one (or the handle is not one the platform would accept).
 * `handle` is bare: no "@", no "u/".
 */
export function publicAvatarUrl(surface: string, handle: string | null | undefined): string | null {
  const name = handle?.trim() ?? "";
  const shape = HANDLE[surface];
  if (!name || !shape || !shape.test(name)) return null;
  if (surface === "github") return `https://github.com/${encodeURIComponent(name)}.png?size=80`;
  const key = PROXIED[surface];
  return key ? `${AVATAR_PROXY_BASE}/${key}/${encodeURIComponent(name)}?fallback=false` : null;
}
