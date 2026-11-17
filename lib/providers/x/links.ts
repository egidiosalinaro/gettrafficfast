/**
 * Links on X, read as text: pure, no I/O, safe in a browser bundle.
 */

/** True for one of X's short links: https://t.co/ and an id of letters and digits. */
export function isXShortLink(raw: string | null | undefined): boolean {
  if (!raw) return false;
  try {
    const url = new URL(raw);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.hostname.toLowerCase() === "t.co" &&
      /^\/[A-Za-z0-9]{1,40}$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

const STATUS_URL = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/(?:\w{1,15}|i\/web|i)\/status(?:es)?\/(\d{1,20})(?:[/?#]|$)/i;

/** The status id of a link to one post on X (x.com, twitter.com, mobile.twitter.com), or null. */
export function statusIdOf(raw: string | null | undefined): string | null {
  const match = STATUS_URL.exec((raw ?? "").trim());
  return match ? match[1] : null;
}
