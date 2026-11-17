import { canonicalTarget } from "@/lib/providers/discovery/canonical";
import type { PostDateRequest } from "@/lib/providers/post-dates";
import { xStatusPostedAt } from "@/lib/providers/x/status-time";

/**
 * When a post was made, read from its URL (2026-11-13). Pure: no I/O.
 *
 * The owner's Replies showed a flood of "date unknown", and a discovery run
 * surfaced X posts from 5 October as new on 12 November: a web search
 * result is dated only when Google prints a date beside it, and the code
 * never looked at the URL, which on two platforms is the date itself.
 *
 *   X          `/status/<id>`: a snowflake, milliseconds since X's epoch in
 *              the top bits (lib/providers/x/status-time.ts). Exact.
 *   LinkedIn   `urn:li:activity:<id>`, `urn:li:ugcPost:<id>`,
 *              `urn:li:share:<id>`, and `/posts/<slug>-activity-<id>-<x>`:
 *              the first 41 bits of the 64-bit id are Unix milliseconds
 *              (`id >> 22`). Exact to the millisecond; read only between
 *              2016 and a day from now, and anything outside is rejected.
 *
 * What the URL cannot say, `postDateRequestFor` names the free API that can
 * (lib/providers/post-dates): Hacker News, Stack Exchange, DEV, Reddit and a
 * GitHub issue. Quora, Indie Hackers, a LinkedIn article (`/pulse/`) and an
 * X article (`/article/<id>`, whose id is made when the draft is, so it
 * would make the article older than it is) stay unknown.
 */

export type UrlDateMethod = "x_snowflake" | "linkedin_id";

export interface UrlDate {
  /** Exact ISO instant: stored with no precision, like a platform API's timestamp. */
  at: string;
  method: UrlDateMethod;
}

const LINKEDIN_SHIFT = BigInt(22);
/** LinkedIn ids are read from 2016 on: below that the decoding is not trusted. */
const LINKEDIN_FIRST_MS = Date.UTC(2016, 0, 1);
const DAY_MS = 86_400_000;

/** The instant a LinkedIn activity, ugcPost or share id was made, or null outside the plausible range. */
export function linkedinIdPostedAt(id: string, now: Date = new Date()): string | null {
  if (!/^\d{16,20}$/.test(id)) return null;
  const ms = Number(BigInt(id) >> LINKEDIN_SHIFT);
  if (ms < LINKEDIN_FIRST_MS || ms > now.getTime() + DAY_MS) return null;
  return new Date(ms).toISOString();
}

const X_HOSTS = new Set(["x.com", "twitter.com", "mobile.twitter.com", "mobile.x.com"]);

function parse(url: string): URL | null {
  try {
    return new URL(url.trim());
  } catch {
    return null;
  }
}

function hostOf(url: URL): string {
  return url.hostname.toLowerCase().replace(/^www\./, "");
}

/** The post's instant, when its URL carries one; null otherwise. */
export function dateFromUrl(raw: string, now: Date = new Date()): UrlDate | null {
  const url = parse(raw);
  if (!url) return null;
  const host = hostOf(url);

  if (X_HOSTS.has(host)) {
    const status = /\/status(?:es)?\/(\d{1,20})(?:\/|$)/.exec(url.pathname);
    const at = status ? xStatusPostedAt(status[1], now) : null;
    return at ? { at, method: "x_snowflake" } : null;
  }

  if (host === "linkedin.com" || host.endsWith(".linkedin.com")) {
    let path = url.pathname;
    try {
      path = decodeURIComponent(path);
    } catch {
      // A malformed escape: read what is there.
    }
    const id =
      /urn:li:(?:activity|ugcPost|share):(\d{16,20})/i.exec(path)?.[1] ??
      /-(?:activity|ugcPost|share)-(\d{16,20})(?:-|$|\/)/i.exec(path)?.[1];
    const at = id ? linkedinIdPostedAt(id, now) : null;
    return at ? { at, method: "linkedin_id" } : null;
  }

  return null;
}

/** Stack Exchange hosts the API knows by their own domain. */
function stackExchangeSite(host: string): string {
  return host.replace(/^www\./, "");
}

/**
 * Which free API knows when this post was made, or null when none does.
 * Reads the URL through the canonicaliser, so every form of a thread asks
 * the same question.
 */
export function postDateRequestFor(raw: string): PostDateRequest | null {
  const canonical = canonicalTarget(raw);
  if (!canonical || canonical.kind === "page") return null;
  const url = new URL(canonical.url);

  switch (canonical.surface) {
    case "hackernews": {
      const id = url.searchParams.get("id");
      return id && /^\d+$/.test(id) ? { source: "hackernews", id } : null;
    }
    case "stackexchange": {
      const [, , id] = url.pathname.split("/");
      return id && /^\d+$/.test(id) ? { source: "stackexchange", site: stackExchangeSite(url.hostname), id } : null;
    }
    case "devto": {
      const [, user, slug] = url.pathname.split("/");
      return user && slug ? { source: "devto", user, slug } : null;
    }
    case "reddit":
      return canonical.kind === "thread" && /^[a-z0-9]{1,13}$/.test(canonical.externalId)
        ? { source: "reddit", id: canonical.externalId }
        : null;
    case "github": {
      if (canonical.kind !== "issue") return null;
      const match = /^\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(url.pathname);
      return match ? { source: "github", repo: match[1], number: match[2] } : null;
    }
    default:
      return null;
  }
}

/** Whether anything free can date a row on this surface: the URL or an API. */
export const DATABLE_SURFACES = ["x", "linkedin", "hackernews", "stackexchange", "devto", "reddit", "github"] as const;
