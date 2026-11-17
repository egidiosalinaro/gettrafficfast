import { createHash } from "crypto";
import type { DiscussionKind } from "./types";
import { domainOf } from "@/lib/providers/serp/types";

/**
 * One identity per public page, whoever found it.
 *
 * The same Reddit thread can arrive from Reddit's API (with a post id) and
 * from a web search (with a URL carrying a slug, a comment anchor and three
 * tracking parameters). If those became two rows, the inbox would show one
 * opportunity twice and the qualifier would pay for it twice. So every URL is
 * reduced here to a surface, a kind and an external id that is the same for
 * every form of the same page, and the unique key on placement_targets is
 * (business, surface, external id).
 *
 * Pure and exhaustive by construction: an unknown host is a "web" page keyed
 * by its normalised URL, never dropped.
 */

export type Surface =
  | "reddit"
  | "github"
  | "linkedin"
  | "x"
  | "hackernews"
  | "stackexchange"
  | "quora"
  | "indiehackers"
  | "devto"
  | "web";

export interface CanonicalTarget {
  surface: Surface;
  kind: DiscussionKind;
  externalId: string;
  url: string;
  /** Subreddit, repository, publication or domain. */
  community: string;
  /** The account named in the URL, when the platform puts one there. */
  author: string | null;
}

/** Query parameters that only ever track the click. */
const TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|igshid$|mc_cid$|mc_eid$|ref$|ref_src$|ref_url$|share_id$|rdt$|context$|source$|si$|s$|t$)/i;

/**
 * Lowercased host, tracking stripped, fragment dropped, no trailing slash.
 * The generic identity, and the starting point for the platform-specific ones.
 */
export function normalizeUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) {
    url.port = "";
  }
  const kept = new URLSearchParams();
  for (const [key, value] of [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (!TRACKING_PARAMS.test(key)) kept.append(key, value);
  }
  url.search = kept.toString() ? `?${kept.toString()}` : "";
  url.pathname = url.pathname.replace(/\/{2,}/g, "/").replace(/\/+$/, "") || "/";
  return url.toString().replace(/\/$/, "");
}

function hashOf(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

/** Every host an X post link arrives on; the canonical URL is always x.com. */
const X_HOSTS = new Set(["x.com", "twitter.com", "mobile.twitter.com", "mobile.x.com"]);

const REDDIT_HOSTS = new Set(["reddit.com", "old.reddit.com", "new.reddit.com", "np.reddit.com", "m.reddit.com"]);

export function canonicalTarget(raw: string): CanonicalTarget | null {
  const normalized = normalizeUrl(raw);
  if (!normalized) return null;
  const url = new URL(normalized);
  const host = domainOf(normalized);
  const segments = url.pathname.split("/").filter(Boolean);

  // ── Reddit: /r/<sub>/comments/<id>[/<slug>[/<comment>]] ──────────────────
  if (REDDIT_HOSTS.has(host) || host.endsWith(".reddit.com")) {
    const idx = segments.findIndex((s) => s === "comments");
    if (segments[0] === "r" && segments[1] && idx === 2 && segments[3]) {
      const sub = segments[1];
      const id = segments[3].toLowerCase();
      const slug = segments[4] ? `/${segments[4]}` : "";
      return {
        surface: "reddit",
        kind: "thread",
        externalId: id,
        url: `https://www.reddit.com/r/${sub}/comments/${id}${slug}/`,
        community: `r/${sub}`,
        author: null,
      };
    }
    return {
      surface: "reddit",
      kind: "page",
      externalId: hashOf(normalized),
      url: normalized,
      community: segments[0] === "r" && segments[1] ? `r/${segments[1]}` : "reddit",
      author: null,
    };
  }

  // ── GitHub: /<owner>/<repo>[/issues|discussions|pull/<n>] ────────────────
  if (host === "github.com") {
    const [owner, repo, section, number] = segments;
    if (owner && repo && !RESERVED_GITHUB.has(owner.toLowerCase())) {
      const slug = `${owner}/${repo}`;
      if ((section === "issues" || section === "pull") && number && /^\d+$/.test(number)) {
        return {
          surface: "github",
          kind: section === "issues" ? "issue" : "page",
          externalId: `${slug.toLowerCase()}#${section === "pull" ? "pr" : ""}${number}`,
          url: `https://github.com/${slug}/${section}/${number}`,
          community: slug,
          author: null,
        };
      }
      if (section === "discussions" && number && /^\d+$/.test(number)) {
        return {
          surface: "github",
          kind: "discussion",
          externalId: `${slug.toLowerCase()}#d${number}`,
          url: `https://github.com/${slug}/discussions/${number}`,
          community: slug,
          author: null,
        };
      }
      if (!section || section === "blob" || section === "tree" || section === "wiki") {
        // README, a file, the repo itself: all "the repository".
        return {
          surface: "github",
          kind: "repository",
          externalId: slug.toLowerCase(),
          url: `https://github.com/${slug}`,
          community: slug,
          author: owner,
        };
      }
    }
    return { surface: "github", kind: "page", externalId: hashOf(normalized), url: normalized, community: "github", author: null };
  }

  // ── LinkedIn: /pulse/<slug>, /posts/<slug>, /feed/update/urn:li:activity:<id>
  if (host === "linkedin.com" || host.endsWith(".linkedin.com")) {
    if (segments[0] === "pulse" && segments[1]) {
      return {
        surface: "linkedin",
        kind: "article",
        externalId: `pulse:${segments[1].toLowerCase()}`,
        url: `https://www.linkedin.com/pulse/${segments[1]}`,
        community: "linkedin",
        // The slug ends in "-<first>-<last>-<hash>" but the boundary with the
        // title is not recoverable without the page. Null beats a name cut in
        // the wrong place.
        author: null,
      };
    }
    if (segments[0] === "posts" && segments[1]) {
      return {
        surface: "linkedin",
        kind: "post",
        externalId: `posts:${segments[1].toLowerCase()}`,
        url: `https://www.linkedin.com/posts/${segments[1]}`,
        community: "linkedin",
        author: segments[1].split("_")[0] || null,
      };
    }
    if (segments[0] === "feed" && segments[1] === "update" && segments[2]) {
      return {
        surface: "linkedin",
        kind: "post",
        externalId: segments[2].toLowerCase(),
        url: `https://www.linkedin.com/feed/update/${segments[2]}`,
        community: "linkedin",
        author: null,
      };
    }
    return { surface: "linkedin", kind: "page", externalId: hashOf(normalized), url: normalized, community: "linkedin", author: null };
  }

  // ── X: /<user>/status/<id> and /<user>/article/<id> ──────────────────────
  // Search returns X articles far more often than tweets. An article is a
  // post with a reply box; treating it as a profile threw those rows out
  // before anyone could see them. /i/article/<id> is the same article with
  // the author left off the URL.
  if (X_HOSTS.has(host)) {
    const [user, section, id, extra] = segments;
    if (user && section === "status" && id && /^\d+$/.test(id)) {
      return {
        surface: "x",
        kind: "post",
        externalId: `status:${id}`,
        url: `https://x.com/${user}/status/${id}`,
        community: `@${user}`,
        author: user,
      };
    }
    if (user === "i" && section === "web" && id === "status" && extra && /^\d+$/.test(extra)) {
      return {
        surface: "x",
        kind: "post",
        externalId: `status:${extra}`,
        url: `https://x.com/i/web/status/${extra}`,
        community: "x",
        author: null,
      };
    }
    if (section === "article" && id && /^\d+$/.test(id)) {
      const handle = user && user !== "i" ? user : null;
      return {
        surface: "x",
        kind: "article",
        externalId: `article:${id}`,
        url: handle ? `https://x.com/${handle}/article/${id}` : `https://x.com/i/article/${id}`,
        community: handle ? `@${handle}` : "x",
        author: handle,
      };
    }
    return { surface: "x", kind: "page", externalId: hashOf(normalized), url: normalized, community: "x", author: null };
  }

  // ── Hacker News: /item?id=<n> ─────────────────────────────────────────────
  if (host === "news.ycombinator.com") {
    const id = url.searchParams.get("id");
    if (segments[0] === "item" && id && /^\d+$/.test(id)) {
      return {
        surface: "hackernews",
        kind: "thread",
        externalId: `hn:${id}`,
        url: `https://news.ycombinator.com/item?id=${id}`,
        community: "Hacker News",
        author: null,
      };
    }
    return page("hackernews", normalized, "Hacker News");
  }

  // ── Stack Exchange network: /questions/<id>[/<slug>], /q/<id> ────────────
  // One surface for the whole network; the community is the site, because
  // an answer on ai.stackexchange.com is read by a different crowd than one
  // on stackoverflow.com. An /a/<answer-id> link cannot be mapped to its
  // question without a fetch, so it stays a page rather than a guess.
  if (STACK_EXCHANGE_HOSTS.has(host) || host.endsWith(".stackexchange.com") || host.endsWith(".stackoverflow.com")) {
    const [section, id] = segments;
    if ((section === "questions" || section === "q") && id && /^\d+$/.test(id)) {
      return {
        surface: "stackexchange",
        kind: "thread",
        externalId: `${host}:${id}`,
        url: `https://${host}/questions/${id}${segments[2] && section === "questions" ? `/${segments[2]}` : ""}`,
        community: host,
        author: null,
      };
    }
    return page("stackexchange", normalized, host);
  }

  // ── Quora: /<Question-Slug>, /unanswered/<slug>; spaces at <space>.quora.com
  if (host === "quora.com" || host.endsWith(".quora.com")) {
    const space = host === "quora.com" || host === "www.quora.com" ? null : host.slice(0, -".quora.com".length);
    const slug = segments[0] === "unanswered" ? segments[1] : segments[0];
    const reserved = !slug || (segments.length > 1 && segments[0] !== "unanswered") || QUORA_RESERVED.has(slug.toLowerCase());
    if (!reserved) {
      if (space) {
        // A post in a Space is someone's article, not an open question.
        return {
          surface: "quora",
          kind: "post",
          externalId: `space:${space.toLowerCase()}/${slug.toLowerCase()}`,
          url: `https://${space}.quora.com/${slug}`,
          community: `${space}.quora.com`,
          author: null,
        };
      }
      return {
        surface: "quora",
        kind: "thread",
        externalId: `q:${slug.toLowerCase()}`,
        url: `https://www.quora.com/${slug}`,
        community: "Quora",
        author: null,
      };
    }
    return page("quora", normalized, space ? `${space}.quora.com` : "Quora");
  }

  // ── Indie Hackers: /post/<slug>, /<group>/post/<slug> ────────────────────
  if (host === "indiehackers.com") {
    const idx = segments.indexOf("post");
    const slug = idx >= 0 ? segments[idx + 1] : undefined;
    if (slug) {
      return {
        surface: "indiehackers",
        kind: "thread",
        externalId: `post:${slug.toLowerCase()}`,
        url: `https://www.indiehackers.com/post/${slug}`,
        community: idx > 0 ? segments.slice(0, idx).join("/") : "Indie Hackers",
        author: null,
      };
    }
    return page("indiehackers", normalized, "Indie Hackers");
  }

  // ── DEV Community: /<user>/<slug> ─────────────────────────────────────────
  if (host === "dev.to") {
    const [user, slug, extra] = segments;
    if (user && slug && !extra && !DEVTO_RESERVED.has(user.toLowerCase())) {
      return {
        surface: "devto",
        kind: "article",
        externalId: `${user.toLowerCase()}/${slug.toLowerCase()}`,
        url: `https://dev.to/${user}/${slug}`,
        community: "DEV Community",
        author: user,
      };
    }
    return page("devto", normalized, "DEV Community");
  }

  return {
    surface: "web",
    kind: "page",
    externalId: hashOf(normalized),
    url: normalized,
    community: host,
    author: null,
  };
}

/** A platform page that is not a thread anyone can reply to. */
function page(surface: Surface, normalized: string, community: string): CanonicalTarget {
  return { surface, kind: "page", externalId: hashOf(normalized), url: normalized, community, author: null };
}

/** Stack Exchange sites that do not live under stackexchange.com. */
const STACK_EXCHANGE_HOSTS = new Set([
  "stackoverflow.com",
  "superuser.com",
  "serverfault.com",
  "askubuntu.com",
  "mathoverflow.net",
  "stackapps.com",
]);

/** First path segments on quora.com that are not a question. */
const QUORA_RESERVED = new Set([
  "profile", "topic", "q", "search", "spaces", "about", "careers", "press", "contact",
  "answer", "log", "settings", "notifications", "sitemap", "unanswered", "partners", "ads",
]);

/** First path segments on dev.to that are not a user or an organisation. */
const DEVTO_RESERVED = new Set([
  "t", "tags", "search", "top", "latest", "about", "faq", "privacy", "terms", "pod",
  "videos", "listings", "readinglist", "settings", "dashboard", "new", "enter", "signout",
  "notifications", "sponsors", "contact", "code-of-conduct", "community-moderation",
]);

/** Top-level GitHub paths that are not a user or an organisation. */
const RESERVED_GITHUB = new Set([
  "topics", "search", "marketplace", "explore", "features", "pricing", "login", "join",
  "settings", "notifications", "orgs", "sponsors", "collections", "trending", "about",
  "site", "security", "enterprise", "customer-stories", "readme", "events", "issues", "pulls",
]);

/**
 * Two threads with the same question are the same opportunity. Title-based,
 * deliberately coarse: lowercase, letters and digits only, whitespace
 * collapsed. A cross-post to three subreddits collapses to one.
 */
export function contentHash(title: string, excerpt = ""): string {
  const normalizedTitle = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const key = normalizedTitle.length >= 20 ? normalizedTitle : `${normalizedTitle}|${excerpt.slice(0, 80).toLowerCase()}`;
  return hashOf(key);
}
