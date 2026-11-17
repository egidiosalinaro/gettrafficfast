import { REDDIT_ARCHIVE_DAYS, redditIdAtOrBelow } from "@/lib/providers/discovery/reddit-ids";
import { domainOf } from "@/lib/providers/serp/types";
import { isCompanySource } from "@/lib/domain/source-matching";
import { replyWindowDays } from "./reply-window";

/**
 * Deterministic qualification: the rules a model does not get to argue with.
 *
 * They run before the agent, on every discovered target, for two reasons.
 * Cost: a model call per thread is the expensive step, and a thread that is a
 * year old, promotional, or on the customer's own site should never reach it.
 * Trust: a rejection with a rule name attached is arguable and repeatable; a
 * model's "not a fit" is neither. The agent judges only what survives here,
 * and the reason on a rules rejection names the rule so the inbox can show
 * exactly why.
 *
 * Pure: no I/O, no clock other than the one passed in.
 */

export interface RuleTarget {
  surface: string;
  kind: string;
  url: string;
  title: string;
  excerpt: string | null;
  community: string | null;
  /**
   * When it was posted; for a web-search find, the latest instant the
   * engine's date allows, so the age computed from it never overstates.
   */
  posted_at: string | null;
  comment_count: number | null;
  found_for: string | null;
  /** The surface's own id (a Reddit post id, "owner/repo#12"); what bounds an undated Reddit thread. */
  external_id?: string | null;
}

export interface RuleContext {
  now: Date;
  /** The business's own domains: a page there is not off-site. */
  ownDomains: string[];
  /** Keywords and entities the business can speak to. */
  expertise: string[];
  /**
   * The newest Reddit post id known to be older than the archive window
   * (lib/providers/discovery/reddit-ids.ts): an undated Reddit thread with
   * an id at or below it is archived. Null or absent when nothing is known,
   * which leaves undated threads alone.
   */
  redditArchivedBelow?: string | null;
}

export type RuleOutcome =
  | { status: "rejected"; rule: string; reason: string }
  | { status: "pass"; flags: string[] };

/**
 * How long a page stays worth answering, by kind. Null means evergreen: an
 * awesome-list takes additions for as long as it is maintained, and that is
 * judged by its last push, not by when it was created.
 */
export const FRESHNESS_DAYS: Record<string, number | null> = {
  thread: 180,
  issue: 365,
  discussion: 365,
  repository: null,
  article: 365,
  post: 60,
  page: 365,
  // A list article takes additions for as long as its author keeps it, and
  // the answer that cited it carries no date for it.
  listicle: null,
};

/** The window for a kind; null is evergreen, an unknown kind gets the thread's. */
export function freshnessDays(kind: string): number | null {
  return kind in FRESHNESS_DAYS ? FRESHNESS_DAYS[kind] : 180;
}

export function freshUntil(kind: string, createdAt: string | null): string | null {
  const days = freshnessDays(kind);
  if (days === null || !createdAt) return null;
  const at = new Date(createdAt).getTime();
  if (!Number.isFinite(at)) return null;
  return new Date(at + days * 86_400_000).toISOString();
}

/** Places engines do not read because a login stands in front of them. */
const NON_PUBLIC_HOSTS = [
  "facebook.com",
  "discord.gg",
  "discord.com",
  "t.me",
  "telegram.me",
  "slack.com",
  "whatsapp.com",
  "chat.whatsapp.com",
  "instagram.com",
  "tiktok.com",
];

/** Titles that are an advert, a job, or a place no brand should appear. */
const PROMOTIONAL =
  /\b(hiring|we'?re hiring|job (opening|offer|post)|discount code|coupon|promo code|giveaway|for sale|buy now|dm me|affiliate link|casino|betting|onlyfans|xxx|porn|nsfw|make money fast|get rich|\[ad\]|\[promo\]|\[sponsored\])\b/i;

const STOPWORDS = new Set([
  "the", "and", "for", "you", "are", "how", "can", "get", "any", "one", "all", "not", "but", "has",
  "was", "its", "our", "who", "why", "use", "new", "top", "now", "see", "way", "out", "off", "own",
  "too", "yet", "per", "this", "that", "with", "from", "into", "than", "them", "then",
  "about", "after", "again", "also", "amount", "another", "anyone", "around", "because", "been",
  "before", "being", "best", "between", "both", "could", "does", "doing", "down", "during", "each",
  "every", "from", "have", "having", "here", "into", "just", "like", "looking", "make", "more",
  "most", "much", "need", "only", "other", "over", "please", "really", "same", "should", "since",
  "some", "still", "such", "than", "that", "their", "them", "then", "there", "these", "they",
  "thing", "things", "this", "those", "through", "under", "until", "very", "want", "what", "when",
  "where", "which", "while", "will", "with", "would", "your", "yours", "help", "using", "used",
  "tool", "tools", "free", "good", "great", "know", "does", "anybody", "recommend", "recommendations",
  "question", "questions", "advice", "suggestions", "software", "website", "sites", "site",
]);

/** Two-letter tokens that carry meaning in this product's domain. */
const SHORT_ALLOWED = new Set(["ai"]);

/** Lowercased content words of three letters or more, stopwords removed. */
export function contentTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    const token = raw.trim();
    if ((token.length < 3 && !SHORT_ALLOWED.has(token)) || STOPWORDS.has(token)) continue;
    tokens.add(token);
    // A crude stem so "automations" meets "automation".
    if (token.endsWith("s") && token.length > 4) tokens.add(token.slice(0, -1));
  }
  return tokens;
}

export function overlap(a: Set<string>, b: Set<string>): string[] {
  const out: string[] = [];
  for (const token of a) if (b.has(token)) out.push(token);
  return out;
}

/** Whole days between `iso` and now, or null when `iso` is not a date. */
function ageDays(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  const at = new Date(iso).getTime();
  return Number.isFinite(at) ? Math.floor((now.getTime() - at) / 86_400_000) : null;
}

/**
 * The rules that are a function of time alone, so they can be applied
 * again to a row already judged: a thread qualified at five months is
 * archived at six, and an inbox that still shows it lies.
 *
 * A Reddit thread is `archived` once it is REDDIT_ARCHIVE_DAYS old: Reddit
 * takes no new comment or vote on it, so the reply cannot be posted at all.
 * With a date that is the age; without one, the thread is archived when its
 * id sits at or below a post known to be that old (`redditArchivedBelow`),
 * because Reddit numbers posts in order. Everything else is `stale` past its
 * kind's window: a reply nobody will read. Null when neither applies, which
 * for an undated row means "cannot tell", not "fresh".
 */
export function expiryOf(target: RuleTarget, ctx: RuleContext): RuleOutcome | null {
  if (target.surface === "reddit" && target.kind === "thread") {
    const age = ageDays(target.posted_at, ctx.now);
    if (age !== null && age >= REDDIT_ARCHIVE_DAYS) {
      return {
        status: "rejected",
        rule: "archived",
        reason: `Archived on Reddit: at least ${age} days old, and Reddit takes no new comment on a thread after ${REDDIT_ARCHIVE_DAYS} days. There is nowhere to post the reply.`,
      };
    }
    if (age === null && ctx.redditArchivedBelow && redditIdAtOrBelow(target.external_id, ctx.redditArchivedBelow)) {
      return {
        status: "rejected",
        rule: "archived",
        reason: `Archived on Reddit: the search engine gave no date, but Reddit numbers threads in order and this one comes before a thread known to be over ${REDDIT_ARCHIVE_DAYS} days old. There is nowhere to post the reply.`,
      };
    }
    return null;
  }

  const days = freshnessDays(target.kind);
  const age = ageDays(target.posted_at, ctx.now);
  if (days !== null && age !== null && age > days) {
    return {
      status: "rejected",
      rule: "stale",
      reason: `${age} days old, past the ${days}-day window for a ${target.kind}: a reply now would not be read.`,
    };
  }
  return null;
}

const REPLY_WINDOW_NAME: Record<string, string> = {
  x: "an X post",
  linkedin: "a LinkedIn post",
  reddit: "a Reddit thread",
  github: "a GitHub issue",
};

/**
 * A row not yet judged whose post date is already past its platform's "To
 * reply" window (lib/placements/reply-window.ts), as `stale` (2026-11-13).
 * The inbox would show it under Expired the moment it was qualified, so
 * paying a model to judge it buys nothing: an X post from 5 October found
 * on 12 November is 38 days old, inside the 60-day window for a post but far
 * past the two days a reply on X is read in. Only for rows about to be
 * judged: a row already qualified moves to Expired by the display rule and
 * stays answerable there, so `expiryOf` does not include this. The age is a
 * floor (an engine's "4 months ago" is the latest instant it allows), and
 * an undated row passes: unknown is "cannot tell", not "old".
 */
function pastReplyWindowRule(target: RuleTarget, ctx: RuleContext): RuleOutcome | null {
  const days = replyWindowDays(target.surface, target.kind);
  if (days === null || !target.posted_at) return null;
  const at = new Date(target.posted_at).getTime();
  if (!Number.isFinite(at) || ctx.now.getTime() - at <= days * 86_400_000) return null;
  const age = Math.floor((ctx.now.getTime() - at) / 86_400_000);
  const what = REPLY_WINDOW_NAME[target.surface] ?? `a ${target.kind} on ${target.surface}`;
  return {
    status: "rejected",
    rule: "stale",
    reason: `${age} days old, past the ${days}-day window to reply to ${what}: it would only be listed as expired, so it is not judged.`,
  };
}

export function applyRules(target: RuleTarget, ctx: RuleContext): RuleOutcome {
  const host = domainOf(target.url);

  if (host && ctx.ownDomains.some((own) => isCompanySource(host, own))) {
    return { status: "rejected", rule: "own_site", reason: "This page is on your own site; a placement has to be somewhere else." };
  }

  if (host && NON_PUBLIC_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) {
    return {
      status: "rejected",
      rule: "not_public",
      reason: "Behind a login or inside a closed group: answer engines do not read it.",
    };
  }

  // A "page" is what the canonicaliser returns when a URL is not a thread,
  // issue, article or post: a profile, a tag listing, a plain blog page.
  // Whatever the surface, there is nowhere on it to reply.
  if (target.kind === "page") {
    return {
      status: "rejected",
      rule: "not_answerable",
      reason:
        target.surface === "web"
          ? "A plain web page with no place to reply."
          : "Not a thread, issue, article or post anyone can reply to.",
    };
  }

  const expired = expiryOf(target, ctx);
  if (expired) return expired;
  const late = pastReplyWindowRule(target, ctx);
  if (late) return late;

  const text = `${target.title} ${target.excerpt ?? ""}`;
  if (PROMOTIONAL.test(target.title) || PROMOTIONAL.test((target.excerpt ?? "").slice(0, 300))) {
    return {
      status: "rejected",
      rule: "promotional",
      reason: "A promotional, hiring or adult thread: not a place for an expert answer.",
    };
  }

  if (target.title.trim().length < 15 && !(target.excerpt ?? "").trim()) {
    return {
      status: "rejected",
      rule: "too_thin",
      reason: "Too little text to know what is being asked.",
    };
  }

  if (ctx.expertise.length > 0) {
    const threadTokens = contentTokens(text);
    const known = contentTokens([...ctx.expertise, target.found_for ?? ""].join(" "));
    if (overlap(known, threadTokens).length === 0) {
      return {
        status: "rejected",
        rule: "no_overlap",
        reason: "Nothing in the thread touches what the business can speak to.",
      };
    }
  }

  const flags: string[] = [];
  if (!target.posted_at && freshnessDays(target.kind) !== null) flags.push("date_unknown");
  if (target.comment_count === null) flags.push("engagement_unknown");
  return { status: "pass", flags };
}
