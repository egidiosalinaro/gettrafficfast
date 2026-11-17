/**
 * "Questions people ask": keyword ideas taken from the public conversations
 * discovery already found for the site (`placement_targets`,
 * docs/PLACEMENTS.md). A thread whose title is a question is somebody asking
 * it in public, in their own words; that is the article worth writing.
 *
 * Pure: rows in, ideas out. No model is asked, nothing is fetched, and no
 * number is attached. A question from a thread has no search volume,
 * difficulty or CPC, measured or estimated, and none is made up here: the
 * only count an idea carries is how many of the site's discovered threads
 * ask it, which is a count of rows, not a measure of demand.
 */

/** The fields of a discovered thread this module reads. */
export interface QuestionThread {
  url: string;
  title: string;
  surface: string;
  kind?: string | null;
  community?: string | null;
  status: string;
  /** "agent", "person" or "rules:<rule>": who stands behind the verdict. */
  qualified_by?: string | null;
  qualify_score?: number | null;
  /** The qualifier's reading of the post: "question", "showcase", "listing"… */
  intent?: string | null;
  posted_at?: string | null;
  created_at?: string | null;
}

export interface QuestionIdea {
  /** The question as asked, cleaned of the site's suffixes. */
  question: string;
  /** How many of the site's discovered threads ask it. Not search demand. */
  threadCount: number;
  /** The most recent thread that asks it. */
  sourceUrl: string;
  /** That thread's host, without "www.": "reddit.com". */
  host: string;
  surface: string;
  community: string | null;
  /** When that thread was posted; null when its date is unknown. */
  postedAt: string | null;
}

/** How many ideas the screen and the tool show unless asked otherwise. */
export const QUESTION_IDEAS_DEFAULT = 20;
export const QUESTION_IDEAS_MAX = 50;

/** `keywords.source` of a keyword added from here. */
export const QUESTION_SOURCE = "question";

/** What stands where a number would: said by the page and by the tools. */
export const ASKED_IN_PUBLIC = "Asked in a public thread";

/**
 * The qualifier's score floor (QUALIFY_SCORE_FLOOR, lib/placements/
 * qualification.ts), repeated here so this module stays free of I/O imports;
 * a test holds the two together.
 */
export const ON_TOPIC_SCORE_FLOOR = 60;

/** Rules that reject a thread for its age alone: the question still stands. */
const AGE_ONLY_RULES = new Set(["rules:stale", "rules:archived"]);

/**
 * Whether a discovered thread may feed a question idea.
 *
 * Anything not rejected does. A rejection keeps the thread only when it says
 * nothing against the topic: too old to answer (stale, archived), or judged
 * worth answering by the qualifier (at or above its floor) and refused for
 * the reply it would have needed. Every other rejection (no overlap with the
 * site's topics, own site, promotional, not public, not a thread, too thin,
 * or the qualifier scoring it below the floor) is off-topic, own-site or
 * spam as far as this list can tell, and is left out.
 */
export function isQuestionSource(thread: Pick<QuestionThread, "status" | "qualified_by" | "qualify_score">): boolean {
  if (thread.status !== "rejected") return true;
  const by = thread.qualified_by ?? "";
  if (AGE_ONLY_RULES.has(by)) return true;
  if (by === "agent") return typeof thread.qualify_score === "number" && thread.qualify_score >= ON_TOPIC_SCORE_FLOOR;
  return false;
}

/** Kinds that are somebody's finished piece, not somebody asking. */
const NOT_A_CONVERSATION = new Set(["article", "repository", "page"]);
/** Intents the qualifier gives to a post that shows or lists something. */
const NOT_ASKING = new Set(["showcase", "listing"]);

const SITE =
  "(?:r\\/[\\w-]+|reddit|quora|x|twitter|linkedin|hacker\\s?news|indie\\s?hackers|stack\\s?overflow|(?:[\\w ]+ )?stack\\s?exchange|dev community|github|medium)";
const SITE_SUFFIX = new RegExp(`\\s*[-–—|:·•/]\\s*${SITE}\\s*$`, "i");
const COUNT_SUFFIX = /\s*[|·•]\s*[\d.,]+\+?\s*(?:comments?|replies|answers?|upvotes?|points?|likes?|reactions?)\s*$/i;
const SITE_PREFIX = new RegExp(`^(?:${SITE}\\s*[-–—|:]\\s+|r\\/[\\w-]+ on reddit\\s*:\\s*)`, "i");
const TAG_PREFIX = /^(?:(?:ask|tell)\s+hn\s*:\s*|\[[^\]]{1,30}\]\s*|\([^)]{1,30}\)\s*)/i;
/** `Name on X: "the post" / X`, as a web search titles a post. */
const QUOTED_POST = /^.{1,80}?\s+on\s+(?:x|twitter|linkedin|threads)\s*:\s*["“”'‘]?(.+?)["“”'’]?$/i;

function collapse(text: string): string {
  return text.replace(/[​-‍﻿]/g, "").replace(/\s+/g, " ").trim();
}

/** A title without the site's own decoration: suffixes, prefixes, links, tags. */
export function stripSiteDecoration(title: string): string {
  let text = collapse(title);
  for (let previous = ""; previous !== text; ) {
    previous = text;
    text = text.replace(SITE_SUFFIX, "").replace(COUNT_SUFFIX, "").trim();
  }
  const quoted = QUOTED_POST.exec(text);
  if (quoted) text = quoted[1].trim();
  for (let previous = ""; previous !== text; ) {
    previous = text;
    text = text.replace(SITE_PREFIX, "").replace(TAG_PREFIX, "").trim();
  }
  text = text.replace(/https?:\/\/\S+/gi, " ");
  text = text.replace(/(?:\s+#[\p{L}\p{N}_]+)+\s*$/u, "");
  return collapse(text);
}

const TRUNCATED = /(?:\.{2,}|…)\s*$/;
const STARTERS = /^(?:how|what|what's|whats|why|which|who|where|when|is|are|can|could|should|does|best)\b/i;
/** "How I grew…", "How we built…": a story, not a question. */
const STORY = /^how\s+(?:i|we|my|our)\b/i;

const MIN_LENGTH = 12;
const MAX_LENGTH = 150;

/**
 * The question a title asks, cleaned, or null when it asks none.
 *
 * A sentence that ends in "?" is a question in any language. Without one, a
 * title is a question only when it opens like one in English (how, what,
 * why, which, is, can, should, best…) and is a single plain line: "How to X:
 * a guide" is an article's headline, and "How I did X" is a story. A title
 * the source cut short ("…") is dropped rather than completed, unless a
 * whole question sentence came before the cut.
 */
export function questionFromTitle(title: string): string | null {
  const text = stripSiteDecoration(title);
  if (!text) return null;

  let question: string | null = null;
  const sentences = text.split(/(?<=[.!?…])\s+/);
  const asked = sentences.find((s) => /\?["”')\]]*$/.test(s) && !TRUNCATED.test(s));
  if (asked) {
    question = asked.replace(/["”')\]]+$/, "").replace(/\?+$/, "?");
  } else if (
    !TRUNCATED.test(text) &&
    sentences.length === 1 &&
    STARTERS.test(text) &&
    !STORY.test(text) &&
    !/:\s/.test(text)
  ) {
    question = text.replace(/[.!:;,\s]+$/, "");
  }
  if (!question) return null;

  question = collapse(question.replace(/^["“'‘\s]+/, ""));
  if (question.length < MIN_LENGTH || question.length > MAX_LENGTH) return null;
  if (questionTokens(question).size < 2) return null;
  return question.charAt(0).toUpperCase() + question.slice(1);
}

/** Words that carry no topic: articles, auxiliaries, question words, askers. */
const STOP_WORDS = new Set(
  `a an the and or but of to in on at by for from with without into about as if so than then
   is are am was were be been being do does did done can could should would will shall may might must
   has have had having get gets getting got use uses used using need needs want wants
   how what whats why which who whom whose when where
   i me my mine we us our you your yours it its they them their this that these those there here
   any anyone anybody some someone something everyone not no yes
   best good better great top vs versus really actually just still also please
   way ways thing things`.split(/\s+/)
);

/**
 * The topic words of a phrase, for comparing two phrases: lower case,
 * hyphens closed ("e-commerce" is "ecommerce"), stop words and one-letter
 * words dropped, and a crude plural stem so "tools" meets "tool".
 */
export function questionTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  const closed = text
    .toLowerCase()
    .replace(/(\p{L})[-‐‑](?=\p{L})/gu, "$1")
    .replace(/['’]s\b/g, "");
  for (const raw of closed.split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2 || STOP_WORDS.has(raw)) continue;
    tokens.add(raw.length > 4 && raw.endsWith("s") && !raw.endsWith("ss") ? raw.slice(0, -1) : raw);
  }
  return tokens;
}

function shared(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const token of a) if (b.has(token)) n += 1;
  return n;
}

/** Two questions are one when this share of their topic words is common (Jaccard). */
export const SAME_QUESTION_OVERLAP = 0.6;
/** A question is covered when this share of its topic words is in one keyword or title. */
export const COVERED_OVERLAP = 0.75;

export function sameQuestion(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  const common = shared(a, b);
  return common / (a.size + b.size - common) >= SAME_QUESTION_OVERLAP;
}

/**
 * Whether a keyword or an article title already answers the question: most
 * of the question's topic words are in it. The other way round does not
 * count: the keyword "email deliverability" does not cover "How do I warm up
 * a new domain for email deliverability?", which is its own article.
 */
export function isCovered(question: Set<string>, existing: readonly Set<string>[]): boolean {
  if (question.size === 0) return false;
  return existing.some((tokens) => shared(question, tokens) / question.size >= COVERED_OVERLAP);
}

function millis(value: string | null | undefined): number {
  if (!value) return 0;
  const at = new Date(value).getTime();
  return Number.isFinite(at) ? at : 0;
}

/** When a thread was asked, for ordering: its date, or when discovery found it. */
function askedAt(thread: QuestionThread): number {
  return millis(thread.posted_at) || millis(thread.created_at);
}

/** A public page's host without "www.", or null when the URL is not http(s). */
export function threadHost(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * The site's question ideas: question-shaped titles of its discovered
 * threads, near-duplicates folded into one, the ones a keyword or an article
 * already covers left out, ranked by how many distinct threads ask the
 * question and then by how recently.
 */
export function questionIdeas(input: {
  threads: readonly QuestionThread[];
  /** The pool's keywords (`keywords.keyword`). */
  keywords: readonly string[];
  /** Titles of the site's written articles. */
  articleTitles: readonly string[];
  limit?: number;
}): QuestionIdea[] {
  const limit = Math.max(1, Math.min(input.limit ?? QUESTION_IDEAS_DEFAULT, QUESTION_IDEAS_MAX));
  const existing = [...input.keywords, ...input.articleTitles].map(questionTokens).filter((tokens) => tokens.size > 0);

  interface Group {
    tokens: Set<string>;
    question: string;
    source: QuestionThread;
    host: string;
    urls: Set<string>;
    latest: number;
  }
  const groups: Group[] = [];

  // Recent first, so a group's wording and link are its most recent thread's.
  const recentFirst = [...input.threads].sort((a, b) => askedAt(b) - askedAt(a));
  for (const thread of recentFirst) {
    if (!isQuestionSource(thread)) continue;
    if (NOT_A_CONVERSATION.has(thread.kind ?? "") || NOT_ASKING.has(thread.intent ?? "")) continue;
    const host = threadHost(thread.url);
    if (!host) continue;
    const question = questionFromTitle(thread.title);
    if (!question) continue;
    const tokens = questionTokens(question);

    const group = groups.find((g) => sameQuestion(g.tokens, tokens));
    if (group) {
      group.urls.add(thread.url);
      continue;
    }
    if (isCovered(tokens, existing)) continue;
    groups.push({ tokens, question, source: thread, host, urls: new Set([thread.url]), latest: askedAt(thread) });
  }

  return groups
    .sort((a, b) => b.urls.size - a.urls.size || b.latest - a.latest)
    .slice(0, limit)
    .map((g) => ({
      question: g.question,
      threadCount: g.urls.size,
      sourceUrl: g.source.url,
      host: g.host,
      surface: g.source.surface,
      community: g.source.community ?? null,
      postedAt: g.source.posted_at ?? null,
    }));
}
