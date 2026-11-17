/**
 * Near-duplicate keywords: two phrases that would produce two articles for
 * one search intent, which then compete with each other (cannibalisation).
 *
 * Pure: phrases in, verdicts out. No model is asked and nothing is fetched.
 * Two signals, and the module says which one spoke:
 *
 *  1. the words. Each phrase is reduced to a set of content tokens
 *     (lowercase, no punctuation or accents, stop words out, plural and a few
 *     verb endings folded, a handful of interchangeable category nouns
 *     merged), so word order never matters. Two sets are duplicates when
 *     their Jaccard similarity reaches `JACCARD_DUPLICATE`, or when one holds
 *     every token of the other and the extra words do not outnumber the
 *     shared ones (`JACCARD_CONTAINED`);
 *  2. the results page, when both keywords have a stored SERP snapshot: at
 *     least `SERP_SAME_INTENT_MIN` of the top `SERP_TOP_N` URLs in common
 *     means the search engine already answers both with the same pages.
 *
 * The word signal is lexical and knows it: "email marketing for Shopify" and
 * "email marketing for restaurants" share two of three tokens and are NOT
 * duplicates, so the threshold sits above one half; the price is that two
 * phrasings of one intent with few words in common ("get cited by ChatGPT",
 * "get traffic from ChatGPT") are only caught by the SERP signal. Nothing is
 * guessed in between.
 */

/** Jaccard similarity of the token sets at which two phrases are one topic. */
export const JACCARD_DUPLICATE = 0.6;
/** The lower bar when one phrase holds every token of the other. */
export const JACCARD_CONTAINED = 0.5;
/** How many of the top results are compared. */
export const SERP_TOP_N = 10;
/** Shared top results at which two keywords have the same intent. */
export const SERP_SAME_INTENT_MIN = 6;
/** A title covers a phrase only when the phrase has at least this many tokens. */
const TITLE_MIN_TOKENS = 3;

/**
 * Words that carry no topic. English, plus the articles and prepositions of
 * the other languages the platform writes in: a stop word left in only
 * lowers a similarity, it never invents one. "ai" is deliberately absent
 * (an Italian preposition, and the subject of half the keywords written here).
 */
const STOP_WORDS = new Set([
  // English
  "a", "an", "the", "and", "or", "of", "for", "to", "in", "on", "at", "by", "with", "from", "into", "about",
  "as", "is", "are", "be", "do", "does", "can", "how", "what", "why", "which", "when", "where", "who",
  "your", "my", "our", "you", "i", "it", "its", "this", "that", "these", "those", "vs", "versus", "via",
  // Italian
  "il", "lo", "la", "le", "gli", "un", "una", "uno", "di", "da", "del", "della", "dei", "delle", "per", "con",
  "su", "tra", "fra", "che", "come", "cosa", "e", "ed", "o", "al", "alla", "nel", "nella",
  // Spanish, Portuguese, French, German
  "el", "los", "las", "de", "para", "por", "y", "en", "que", "como", "os", "do", "dos", "das", "em", "um", "uma",
  "les", "des", "du", "pour", "avec", "et", "sur", "dans", "une", "comment",
  "der", "die", "das", "den", "und", "für", "fur", "mit", "von", "wie", "ein", "eine",
]);

/**
 * Category nouns a searcher uses interchangeably: "publishing tool" and
 * "publishing platform" are one results page. Generic to any niche, and kept
 * short on purpose: a synonym list that grows starts merging real intents.
 */
const SAME_WORD: Record<string, string> = {
  platform: "tool",
  software: "tool",
  app: "tool",
  application: "tool",
  solution: "tool",
};

/** One token to its comparable core: plural folded, then a few endings. */
export function stemToken(token: string): string {
  let word = token;
  if (word.length > 3) {
    if (word.endsWith("ies")) word = `${word.slice(0, -3)}y`;
    else if (/(?:ss|x|z|ch|sh)es$/.test(word)) word = word.slice(0, -2);
    else if (word.endsWith("s") && !/(?:ss|us|is)$/.test(word)) word = word.slice(0, -1);
  }
  word = SAME_WORD[word] ?? word;
  // An ending goes only when a stem of three letters or more is left:
  // "citation" → "cit", but "nation" and "need" stay whole.
  const strip = (suffix: string, replacement = ""): boolean => {
    if (!word.endsWith(suffix) || word.length - suffix.length < 3) return false;
    word = `${word.slice(0, -suffix.length)}${replacement}`;
    return true;
  };
  if (!strip("ization", "ize") && !strip("isation", "ize") && !strip("ation") && !strip("ing")) strip("ed");
  // "cite" and "cit(ed)", "write" and "writ(ing)" meet without the final e.
  if (word.length > 4 && word.endsWith("e")) word = word.slice(0, -1);
  return word;
}

/** The sorted, de-duplicated content tokens of a phrase. */
export function keywordTokens(phrase: string): string[] {
  const words = phrase
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    // Apostrophes vanish ("what's" → "whats"); every other mark separates.
    .replace(/['’‘`]/g, "")
    .replace(/\be[- ]commerce\b/g, "ecommerce")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  const tokens = new Set<string>();
  for (const word of words) {
    if (STOP_WORDS.has(word)) continue;
    const stem = stemToken(word);
    if (stem && !STOP_WORDS.has(stem)) tokens.add(stem);
  }
  return [...tokens].sort();
}

/** The form two phrases share when they differ only in order, plural, stop words or punctuation. */
export function normalizeKeyword(phrase: string): string {
  return keywordTokens(phrase).join(" ");
}

export interface WordSimilarity {
  /** |A ∩ B| / |A ∪ B|; 0 when either side has no content token. */
  jaccard: number;
  /** Every token of the shorter phrase is in the longer one. */
  contained: boolean;
  /** The two token sets are equal. */
  same: boolean;
}

export function wordSimilarity(a: readonly string[], b: readonly string[]): WordSimilarity {
  if (a.length === 0 || b.length === 0) return { jaccard: 0, contained: false, same: false };
  const setB = new Set(b);
  let shared = 0;
  for (const token of a) if (setB.has(token)) shared += 1;
  const union = a.length + b.length - shared;
  return {
    jaccard: shared / union,
    contained: shared === Math.min(a.length, b.length),
    same: shared === a.length && shared === b.length,
  };
}

/** A result URL reduced to what identifies the page: host without www, path without a trailing slash. */
export function normalizeSerpUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${host}${path}`;
  } catch {
    return null;
  }
}

/** The first `SERP_TOP_N` distinct pages of a stored snapshot's results. */
export function topSerpUrls(results: unknown): string[] {
  if (!Array.isArray(results)) return [];
  const urls: string[] = [];
  for (const result of results) {
    const url = (result as { url?: unknown } | null)?.url;
    if (typeof url !== "string") continue;
    const page = normalizeSerpUrl(url);
    if (page && !urls.includes(page)) urls.push(page);
    if (urls.length >= SERP_TOP_N) break;
  }
  return urls;
}

/** How many top results two keywords share; null when either has no snapshot. */
export function serpOverlap(a: readonly string[] | null | undefined, b: readonly string[] | null | undefined): number | null {
  if (!a?.length || !b?.length) return null;
  const setB = new Set(b.slice(0, SERP_TOP_N));
  return a.slice(0, SERP_TOP_N).filter((url) => setB.has(url)).length;
}

/**
 * Why two phrases are one topic:
 *  - `same_words`: equal once order, plural, stop words and punctuation are gone;
 *  - `similar_words`: most of their words in common;
 *  - `contained`: one is the other plus a word or two;
 *  - `title_covers`: every word of the phrase is in a published article's title;
 *  - `same_serp`: the stored results pages share most of their top results.
 */
export type DuplicateReason = "same_words" | "similar_words" | "contained" | "title_covers" | "same_serp";

export const DUPLICATE_REASON_TEXT: Record<DuplicateReason, string> = {
  same_words: "the same words in another order or form",
  similar_words: "most of the same words",
  contained: "the same phrase with a word or two added",
  title_covers: "a published article's title already covers it",
  same_serp: `at least ${SERP_SAME_INTENT_MIN} of the top ${SERP_TOP_N} search results are the same pages`,
};

/** A phrase as the comparison reads it. */
export interface DuplicateEntry {
  /** Whatever the caller needs to recognise the entry again. */
  id: string;
  text: string;
  /** "title": the text is an article's title, compared by coverage only. Default "keyword". */
  kind?: "keyword" | "title";
  /** Normalised top result URLs of the keyword's latest stored snapshot, when it has one. */
  serpUrls?: readonly string[] | null;
}

interface Prepared {
  entry: DuplicateEntry;
  tokens: string[];
}

function prepare(entry: DuplicateEntry): Prepared {
  return { entry, tokens: keywordTokens(entry.text) };
}

function reasonBetween(a: Prepared, b: Prepared): DuplicateReason | null {
  const aTitle = a.entry.kind === "title";
  const bTitle = b.entry.kind === "title";
  const words = wordSimilarity(a.tokens, b.tokens);

  if (aTitle || bTitle) {
    // Two titles are never compared: they are articles that already exist.
    if (aTitle && bTitle) return null;
    if (words.same) return "same_words";
    const phrase = aTitle ? b : a;
    const title = aTitle ? a : b;
    const covered = words.contained && phrase.tokens.length <= title.tokens.length;
    return covered && phrase.tokens.length >= TITLE_MIN_TOKENS ? "title_covers" : null;
  }

  if (words.same) return "same_words";
  if (words.jaccard >= JACCARD_DUPLICATE) return words.contained ? "contained" : "similar_words";
  // A single shared token is a subject, not a topic: "rfm" does not make
  // every phrase that mentions it a duplicate.
  if (words.contained && Math.min(a.tokens.length, b.tokens.length) >= 2 && words.jaccard >= JACCARD_CONTAINED) {
    return "contained";
  }
  const overlap = serpOverlap(a.entry.serpUrls, b.entry.serpUrls);
  if (overlap !== null && overlap >= SERP_SAME_INTENT_MIN) return "same_serp";
  return null;
}

/** Why `a` and `b` are one topic, or null when they are not. */
export function duplicateReason(a: DuplicateEntry, b: DuplicateEntry): DuplicateReason | null {
  return reasonBetween(prepare(a), prepare(b));
}

export interface DuplicateMatch {
  entry: DuplicateEntry;
  reason: DuplicateReason;
}

/** An index over known phrases, so a batch is checked without re-tokenising the pool each time. */
export interface DuplicateIndex {
  /** The first known entry `candidate` duplicates, or null. */
  find(candidate: DuplicateEntry): DuplicateMatch | null;
  /** Makes `entry` known, so later candidates are checked against it too. */
  add(entry: DuplicateEntry): void;
}

export function duplicateIndex(known: readonly DuplicateEntry[] = []): DuplicateIndex {
  const prepared = known.map(prepare);
  return {
    find(candidate) {
      const mine = prepare(candidate);
      for (const other of prepared) {
        if (other.entry.id === candidate.id) continue;
        const reason = reasonBetween(mine, other);
        if (reason) return { entry: other.entry, reason };
      }
      return null;
    },
    add(entry) {
      prepared.push(prepare(entry));
    },
  };
}

export interface DuplicateCluster {
  /** Members in the order they were given. */
  members: DuplicateEntry[];
  /** Every signal that joined two members of the cluster. */
  reasons: DuplicateReason[];
}

/**
 * Groups phrases into clusters of one topic: two phrases share a cluster
 * when they are duplicates, directly or through a third (A~B and B~C puts A,
 * B and C together, as the three articles compete for one results page).
 * Phrases with no duplicate are left out. Titles are not clustered.
 */
export function clusterDuplicates(entries: readonly DuplicateEntry[]): DuplicateCluster[] {
  const prepared = entries.filter((entry) => entry.kind !== "title").map(prepare);
  const parent = prepared.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const links: Array<{ a: number; reason: DuplicateReason }> = [];

  for (let a = 0; a < prepared.length; a += 1) {
    for (let b = a + 1; b < prepared.length; b += 1) {
      const reason = reasonBetween(prepared[a], prepared[b]);
      if (!reason) continue;
      links.push({ a, reason });
      const rootA = find(a);
      const rootB = find(b);
      if (rootA !== rootB) parent[Math.max(rootA, rootB)] = Math.min(rootA, rootB);
    }
  }

  const byRoot = new Map<number, DuplicateCluster>();
  prepared.forEach((item, i) => {
    const root = find(i);
    const cluster = byRoot.get(root) ?? { members: [], reasons: [] };
    cluster.members.push(item.entry);
    byRoot.set(root, cluster);
  });
  for (const link of links) {
    const cluster = byRoot.get(find(link.a));
    if (cluster && !cluster.reasons.includes(link.reason)) cluster.reasons.push(link.reason);
  }
  return [...byRoot.values()].filter((cluster) => cluster.members.length > 1);
}
