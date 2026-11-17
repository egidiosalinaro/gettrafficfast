import { domainOf } from "@/lib/providers/serp/types";
import { surfaceLabel } from "./surfaces";

/**
 * The link to the reply a person posted, checked before it is stored on a
 * `published_manually` row.
 *
 * A posted row with no link cannot be measured: nothing can say which reply
 * brought the profile visits, the follows or the traffic. Since 2026-11-08
 * "I posted it" is one tap and the link is asked for afterwards, as a
 * reminder on the card (`set_published_url`); it is still the address of the
 * person's own reply, on the surface the thread is on, and never the
 * thread's own address, which is the one link always at hand and never the
 * right one.
 *
 * Pure and free of Node APIs: the inbox runs the same check to keep its
 * save button disabled, and the action route runs it again before the row
 * is touched. Every refusal is one sentence a person can act on.
 */

export const PUBLISHED_URL_MAX = 2000;

/**
 * A reply the person marked as posted whose link is not recorded yet: the
 * card's amber reminder and the inbox's "missing their link" count. Rows
 * posted before the link existed are in it too, which is the truth. A reply
 * marked as removed from the site (`removedAt`, lib/placements/removed.ts)
 * is not: there is no reply left to link to.
 */
export function missingPublishedLink(row: {
  status: string;
  publishedUrl?: string | null;
  removedAt?: string | null;
}): boolean {
  return row.status === "published_manually" && !row.removedAt && !(row.publishedUrl ?? "").trim();
}

export type PublishedUrlCheck = { ok: true; url: string } | { ok: false; error: string };

export interface PublishedUrlTarget {
  surface: string;
  /** The thread the reply was posted under (`placement_targets.url`). */
  url: string;
}

const X_HOSTS = new Set(["x.com", "twitter.com", "mobile.twitter.com", "mobile.x.com"]);

const onHost = (host: string, root: string) => host === root || host.endsWith(`.${root}`);

/** Hosts a reply on this surface can live at. Surfaces not named here take any host. */
const SURFACE_HOST: Record<string, (host: string) => boolean> = {
  x: (host) => X_HOSTS.has(host),
  reddit: (host) => onHost(host, "reddit.com"),
  // lnkd.in is the short link LinkedIn's phone app copies for a comment.
  linkedin: (host) => onHost(host, "linkedin.com") || host === "lnkd.in",
  // qr.ae is the short link Quora's own Share → Copy link hands out on the
  // phone. It redirects to the answer; what is stored is what was pasted.
  quora: (host) => onHost(host, "quora.com") || host === "qr.ae",
  github: (host) => host === "github.com",
};

/** What a reply link looks like on each surface: the placeholder and the hint say the same thing. */
const EXAMPLE: Record<string, string> = {
  x: "https://x.com/you/status/1234567890",
  reddit: "https://www.reddit.com/r/…/comments/…/comment/…",
  linkedin: "https://www.linkedin.com/feed/update/urn:li:activity:…?commentUrn=…",
  quora: "https://www.quora.com/…/answer/…",
  github: "https://github.com/owner/repo/issues/1#issuecomment-…",
};

export function publishedUrlExample(surface: string): string {
  return EXAMPLE[surface] ?? "https://…";
}

/** Query parameters that only track the click; they never tell two replies apart. */
const TRACKING_PARAM = /^(utm_|fbclid$|gclid$|igshid$|mc_cid$|mc_eid$|ref$|ref_src$|ref_url$|share_id$|rdt$|context$|source$|si$|s$|t$)/i;

function parse(raw: string): URL | null {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function segmentsOf(url: URL): string[] {
  return url.pathname.split("/").filter(Boolean);
}

/** The status id an X address points at, wherever /status/<digits> sits in the path. */
function xStatusId(url: URL): string | null {
  const segments = segmentsOf(url);
  const at = segments.findIndex((s, i) => s === "status" && /^\d+$/.test(segments[i + 1] ?? ""));
  return at >= 0 ? segments[at + 1] : null;
}

/**
 * The status id of a post on X, from an address as stored or pasted:
 * x.com or twitter.com (mobile and www included), `/<user>/status/<digits>`
 * or `/i/web/status/<digits>`. Null for anything else, including a profile,
 * a search page or another site. The one reader of X addresses: the reply
 * intent (`intent.ts`) and the published-link check use the same rule.
 */
export function xStatusIdOf(raw: string): string | null {
  const url = parse(raw.trim());
  if (!url || !X_HOSTS.has(domainOf(url.toString()))) return null;
  return xStatusId(url);
}

/**
 * The post and the comment a Reddit address points at. Both forms Reddit
 * hands out are read: /comments/<post>/<slug>/<comment> and
 * /comments/<post>/comment/<comment>.
 */
function redditIds(url: URL): { post: string; comment: string | null } | null {
  const segments = segmentsOf(url);
  const at = segments.indexOf("comments");
  const post = at >= 0 ? segments[at + 1] : undefined;
  if (!post) return null;
  const comment = segments[at + 3] ?? null;
  return { post: post.toLowerCase(), comment: comment ? comment.toLowerCase() : null };
}

/** A LinkedIn post's activity id, from either /feed/update/urn:li:activity:<id> or /posts/…-activity-<id>-…. */
function linkedinActivity(url: URL): string | null {
  return safeDecode(url.pathname).match(/activity[:-](\d{6,})/i)?.[1] ?? null;
}

function linkedinPointsAtComment(url: URL): boolean {
  return /comment/i.test(safeDecode(url.pathname)) || [...url.searchParams.keys()].some((key) => /comment/i.test(key));
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * One page, however it was copied: host without "www.", path without the
 * trailing slash, tracking parameters dropped. The rest of the query and the
 * fragment are kept, because on several sites they are what names a reply:
 * a Hacker News comment is ?id=<n>, a GitHub one is #issuecomment-<n>, a
 * LinkedIn one carries commentUrn.
 */
function pageKey(url: URL): string {
  const path = url.pathname.replace(/\/{2,}/g, "/").replace(/\/+$/, "").toLowerCase();
  const query = [...url.searchParams.entries()]
    .filter(([key]) => !TRACKING_PARAM.test(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  return `${domainOf(url.toString())}${path}?${query}${url.hash}`;
}

/** True when the pasted address is the thread itself rather than a reply under it. */
function isTheThread(surface: string, reply: URL, thread: URL | null): boolean {
  if (!thread) return false;
  if (surface === "x") {
    const threadStatus = xStatusId(thread);
    if (threadStatus && xStatusId(reply) === threadStatus) return true;
  }
  if (surface === "reddit") {
    const replyIds = redditIds(reply);
    const threadIds = redditIds(thread);
    if (replyIds && threadIds && !replyIds.comment && replyIds.post === threadIds.post) return true;
  }
  if (surface === "linkedin") {
    const activity = linkedinActivity(reply);
    if (activity && activity === linkedinActivity(thread) && !linkedinPointsAtComment(reply)) return true;
  }
  return pageKey(reply) === pageKey(thread);
}

/**
 * Whether `raw` can be recorded as the link to the person's published
 * reply under `target`. On success, the trimmed address as pasted: what is
 * stored is what the person gave, nothing rewritten.
 */
export function checkPublishedUrl(raw: unknown, target: PublishedUrlTarget): PublishedUrlCheck {
  const value = typeof raw === "string" ? raw.trim() : "";
  const label = surfaceLabel(target.surface);
  const where = SURFACE_HOST[target.surface] ? ` on ${label}` : "";

  if (!value) {
    return {
      ok: false,
      error: `Paste the link to your reply${where}. Without it, nothing can tell which reply brought the visits.`,
    };
  }
  if (value.length > PUBLISHED_URL_MAX) {
    return { ok: false, error: `That link is longer than ${PUBLISHED_URL_MAX} characters. Paste the address of your reply itself.` };
  }
  const url = parse(value);
  if (!url || !url.hostname.includes(".")) {
    return { ok: false, error: "That is not a web address. Paste the link to your reply, starting with https://." };
  }

  const host = domainOf(url.toString());
  const allowed = SURFACE_HOST[target.surface];
  if (allowed && !allowed(host)) {
    return {
      ok: false,
      error: `That link is not on ${label}, where this thread is. Paste the link to your reply there, like ${publishedUrlExample(target.surface)}`,
    };
  }

  if (target.surface === "x" && !xStatusId(url)) {
    return {
      ok: false,
      error: "A link to a reply on X has /status/ and a number in it. Open your reply on X, then Share → Copy link.",
    };
  }
  if (target.surface === "reddit" && !redditIds(url)) {
    const share = segmentsOf(url).includes("s");
    return {
      ok: false,
      error: share
        ? "A Reddit share link (/s/…) does not say which comment it is. Open it, then copy the address from the browser bar."
        : "A link to a Reddit comment has /comments/ in it. Under your comment, use Share → Copy link.",
    };
  }

  if (isTheThread(target.surface, url, parse(target.url))) {
    return {
      ok: false,
      error: "That is the link to the thread you replied to, not to your reply. Paste your reply's own link: it is behind its timestamp or its Share menu.",
    };
  }

  return { ok: true, url: value };
}

/**
 * The surface whose replies live at this address ("x", "reddit", "linkedin",
 * "quora", "github"), or null for any other site and for something that is
 * not a web address. Read off the host alone, with the same table
 * `checkPublishedUrl` uses, so a link pasted without its card can be sent
 * to the posted replies of the right platform (link-match.ts).
 */
export function replyLinkSurface(raw: string): string | null {
  const url = parse(raw.trim());
  if (!url) return null;
  const host = domainOf(url.toString());
  return Object.keys(SURFACE_HOST).find((surface) => SURFACE_HOST[surface](host)) ?? null;
}

/** One page however it was copied, for telling two pasted links apart. Null when it is not a web address. */
export function replyLinkKey(raw: string): string | null {
  const url = parse(raw.trim());
  if (!url) return null;
  const status = X_HOSTS.has(domainOf(url.toString())) ? xStatusId(url) : null;
  return status ? `x:${status}` : pageKey(url);
}
