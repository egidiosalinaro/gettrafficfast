import type { SupabaseClient } from "@supabase/supabase-js";
import { clampText } from "@/lib/content/text";
import { canonicalTarget } from "@/lib/providers/discovery/canonical";
import { X_QUERY_MAX_CHARS, type XApiClient, type XApiPost } from "@/lib/providers/x/api";
import { storeTargets, type StoredTarget } from "./discovery";
import { topicsFor } from "./expertise";
import { mediaFromProvider, saveTargetMedia, type PostMediaState } from "./media";
import { X_EXCLUDED_WORDS, xConversationPhrases } from "./x-conversation";
import { referencedFromXApi, saveTargetReferenced } from "./referenced";
import {
  X_SEARCH_CALL_WORST_USD,
  X_SEARCH_QUERIES_PER_RUN,
  X_SEARCH_RESULTS_PER_QUERY,
  X_SEARCH_WINDOW_HOURS,
  meteredXCall,
  type MeteredRefusal,
} from "./x-budget";

/**
 * Fresh posts on X, found through the official API once a day
 * (docs/PLACEMENTS.md, "Fresh posts and reply numbers from the X API").
 *
 * Until now fresh X posts reached the inbox one way: the owner found them in
 * his own X List and pasted the links ("Add a post from X"). The weekly web
 * search finds X posts one to three weeks old, and on X a reply matters in
 * the first hours. This searches X itself for posts of the last 12 hours
 * that match what the site is about, and stores them as the rows discovery
 * stores (`placement_targets`, surface `x`, kind `post`, the canonical
 * `status:<id>` identity), found via `x_search`, fresh for 24 hours. The
 * rules, the X pre-filter, the qualifier and the drafter then treat them as
 * every other discovered thread, and they show under "Found for you".
 *
 * Conversations, not noise (2026-11-14): a search is the site's topics AND
 * the phrases of someone asking or struggling ("how do I", "anyone know"),
 * minus the obvious adverts (lib/placements/x-conversation.ts), because a
 * search on the topics alone returned the word "ChatGPT" in jokes, sales and
 * news, and every one of those was a paid read and a paid judgement.
 *
 * Bounded and rotating, because every post returned is billed: three
 * searches a run, 10 results each, each search an OR of a few of the site's
 * topics, and the topics a run uses move on every day so the whole list is
 * covered over a few days instead of the first ones every time.
 */

/** `found_via` of a row the X search found. */
export const X_SEARCH_SOURCE = "x_search";

/** A post found this way is worth a reply for a day, then it reads as Expired. */
export const X_SEARCH_FRESH_HOURS = 24;

/** A post with more replies than this already has its answers: skipped. */
export const X_MAX_REPLIES = 50;

/** An author the owner replied to this recently is left alone. */
export const X_RECENT_AUTHOR_DAYS = 7;

/** Topics OR-ed in one search. */
export const X_TERMS_PER_QUERY = 4;

/** A topic longer than this many words is too narrow for an exact phrase on X: it is not searched. */
const MAX_TERM_WORDS = 4;

const TITLE_MAX = 200;
const EXCERPT_MAX = 2_000;

/** A topic as an X search term: plain words, quoted when it is a phrase. Null when nothing usable is left. */
export function xSearchTerm(raw: string): string | null {
  const words = raw
    .toLowerCase()
    // Operators and quotes would change the query's meaning: keep words only.
    .replace(/[^\p{L}\p{N}\s'+.-]/gu, " ")
    .replace(/(^|\s)[-+]+/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^[.']+|[.']+$/g, ""))
    .filter((w) => w.length > 0);
  // A longer topic, cut, would be an exact phrase nobody wrote: left out.
  if (words.length === 0 || words.length > MAX_TERM_WORDS) return null;
  // A bare OR or AND is an operator; inside a quoted phrase it is a word.
  if (words.length === 1 && /^(or|and)$/i.test(words[0])) return null;
  const phrase = words.join(" ");
  if (phrase.length < 3) return null;
  return words.length > 1 ? `"${phrase}"` : phrase;
}

/** Words that do not make a topic on their own or inside a phrase: function words, question words, verbs of a brief. */
const TERM_STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "into", "onto", "about", "your", "you", "our", "their", "this", "that",
  "how", "what", "which", "why", "when", "who", "where", "can", "could", "should", "would", "will", "does",
  "are", "was", "were", "has", "have", "had", "been", "being", "get", "got", "make", "more", "most", "some",
  "any", "all", "best", "top", "well", "very", "just", "than", "then", "also", "use", "using", "used", "via",
  "per", "vs", "versus", "without", "within", "do", "is", "it", "to", "of", "in", "on", "at", "by", "or",
  "an", "as", "be", "my", "me", "we", "us", "if", "so", "no", "not", "a", "i",
  "reduce", "eliminate", "replace", "increase", "improve", "boost", "grow", "find", "need", "want", "write",
  "daily", "new", "good", "great", "easy", "fast", "cheap", "free", "rank",
  // The tails and joints of a brief, never what a post is about.
  "powered", "driven", "based", "software", "platform", "system", "solution", "solutions", "alternative",
  "cost", "costs",
  // Italian, Spanish, French, German, Portuguese function words of three letters or more.
  "della", "delle", "degli", "dello", "con", "come", "che", "una", "uno", "nel", "nella", "dei", "sul",
  "para", "como", "los", "las", "del", "por", "que", "une", "des", "pour", "avec", "les", "sur",
  "der", "die", "das", "und", "für", "mit", "wie", "ein", "eine", "den", "dem", "uma", "com", "dos", "nos",
]);

/** Two-letter words that carry a topic in this product's niches. */
const SHORT_TOPIC_WORDS = new Set(["ai", "ux", "ui", "ml", "ar", "vr", "3d", "pr", "hr", "qa", "bi"]);

/** Most terms a site's list keeps: three days of full searches. */
export const X_MAX_TERMS = 36;

function normalizedWords(raw: string): string[] {
  return raw
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    // A hyphen or a slash joins two words people also write apart: "ai-generated" is "ai generated".
    .replace(/[-/_]+/g, " ")
    .replace(/[^\p{L}\p{N}\s'+.]/gu, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^[.'+]+|[.']+$/g, ""))
    .filter((w) => w.length > 0);
}

/** The key a word is compared by: a crude plural fold, so "engines" meets "engine". */
function stem(word: string): string {
  return word.length > 4 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;
}

function isContentWord(word: string): boolean {
  if (TERM_STOPWORDS.has(word)) return false;
  return word.length >= 3 || SHORT_TOPIC_WORDS.has(word);
}

function containsRun(haystack: string[], needle: string[]): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/**
 * The topics the search draws from, as people write them on X: short
 * phrases (two or three words) cut from the site's keywords (its
 * "Questions people ask" among them, keywords with source `question`), its
 * knowledge graph's entities and its niche, ranked by how many of those
 * name them. A keyword like "AI content strategy for Google ranking" is an
 * exact phrase nobody posts; "ai content" and "content strategy" are what it
 * shares with the rest of the list, and what X can match. A source that is
 * already a phrase of two or three words ("answer engine optimization",
 * "SEO for SaaS") is kept as written, ahead of its own pieces.
 *
 * A topic of one word comes only from a keyword or the niche that is that
 * one word ("aeo", "plumbing"); an entity of one word is a brand or a
 * buzzword ("ChatGPT", "AI") and is never searched as a topic. The
 * business's own names are left out (`topicsFor`). A phrase that contains a
 * better-ranked one is left out too: the OR with the shorter one finds it.
 * When at least a full day's searches of phrases are named by two sources or
 * more, the phrases only one source names are dropped.
 */
export function xSearchTerms(source: {
  keywords: string[];
  entities: string[];
  brandNames: string[];
  niche?: string | null;
}): string[] {
  const keywordKeys = new Set(source.keywords.map((k) => k.trim().toLowerCase()));
  const texts: Array<{ words: string[]; entity: boolean }> = topicsFor(source.keywords, source.entities, source.brandNames).map(
    (topic) => ({ words: normalizedWords(topic), entity: !keywordKeys.has(topic.toLowerCase()) })
  );
  if (source.niche?.trim()) texts.push({ words: normalizedWords(source.niche), entity: false });

  const candidates = new Map<string, { words: string[]; whole: boolean; first: number }>();
  const add = (words: string[], whole: boolean) => {
    const key = words.map(stem).join(" ");
    const known = candidates.get(key);
    if (known) known.whole ||= whole;
    else candidates.set(key, { words, whole, first: candidates.size });
  };
  for (const text of texts) {
    const { words } = text;
    // A keyword, a niche or an entity that is already a short phrase, as written ("seo for saas").
    if (words.length === 1 && !text.entity && isContentWord(words[0])) add(words, true);
    if (words.length >= 2 && words.length <= 3 && isContentWord(words[0]) && isContentWord(words[words.length - 1])) add(words, true);
    // Runs of content words, cut into the phrases of two and three words they hold.
    let run: string[] = [];
    for (const word of [...words, ""]) {
      if (word && isContentWord(word)) {
        run.push(word);
        continue;
      }
      for (let size = 2; size <= 3; size += 1) {
        for (let i = 0; i + size <= run.length; i += 1) add(run.slice(i, i + size), false);
      }
      run = [];
    }
  }

  const stemmed = texts.map((t) => t.words.map(stem));
  const ranked = [...candidates.entries()]
    .map(([key, c]) => {
      const keyWords = key.split(" ");
      return { ...c, keyWords, count: stemmed.filter((t) => containsRun(t, keyWords)).length };
    })
    .sort(
      (a, b) =>
        b.count - a.count || Number(b.whole) - Number(a.whole) || a.keyWords.length - b.keyWords.length || a.first - b.first
    );

  // A phrase only one source names is often a seam between two words
  // ("writing costs", "form articles"): kept only when the phrases several
  // name do not fill a whole day's searches.
  const shared = ranked.filter((c) => c.count >= 2).length;
  const pool = shared >= X_SEARCH_QUERIES_PER_RUN * X_TERMS_PER_QUERY ? ranked.filter((c) => c.count >= 2) : ranked;

  const chosen: Array<{ keyWords: string[]; count: number }> = [];
  const terms: string[] = [];
  for (const candidate of pool) {
    if (terms.length >= X_MAX_TERMS) break;
    // Narrower than a phrase already searched, or a piece of one that no other source names.
    if (chosen.some((c) => containsRun(candidate.keyWords, c.keyWords))) continue;
    if (chosen.some((c) => c.count === candidate.count && containsRun(c.keyWords, candidate.keyWords))) continue;
    const term = xSearchTerm(candidate.words.join(" "));
    if (!term || terms.includes(term)) continue;
    chosen.push(candidate);
    terms.push(term);
  }
  return terms;
}

/** Whole days since 1970 (UTC): what the rotation turns on. */
export function dayIndexOf(now: Date): number {
  return Math.floor(now.getTime() / 86_400_000);
}

/** The filters every search carries: the site's language, original posts only, never the owner's own. */
export function xQueryFilters(language: string, ownHandle: string | null): string {
  const lang = (language || "en").slice(0, 2).toLowerCase();
  const parts = [/^[a-z]{2}$/.test(lang) ? `lang:${lang}` : "lang:en", "-is:retweet", "-is:reply"];
  if (ownHandle && /^\w{1,15}$/.test(ownHandle)) parts.push(`-from:${ownHandle}`);
  return parts.join(" ");
}

/**
 * What a search leaves out beyond the filters: `-is:nullcast` (posts made
 * for ads only; X documents it for recent search, negated, beside another
 * term, which a search here always has) and the advert words
 * (`X_EXCLUDED_WORDS`).
 */
export function xQueryExclusions(): string[] {
  return ["-is:nullcast", ...X_EXCLUDED_WORDS.map((w) => `-${w}`)];
}

/** One search of a run. */
export interface XQuery {
  /** What is sent to X. */
  query: string;
  /** The topics part alone: what `found_for` records and the overlap rule reads. */
  topics: string;
  /**
   * The same search without `-is:nullcast` and the excluded words: the
   * shape production ran before 2026-11-14, plus the phrases. Sent once
   * instead when X refuses `query` as invalid (400), so an operator X does
   * not take at this access level costs nothing and never the run. Null when
   * there is nothing to take out.
   */
  plain: string | null;
}

const orGroup = (terms: string[]): string => (terms.length === 1 ? terms[0] : `(${terms.join(" OR ")})`);

/**
 * The run's searches: at most `queries`, each an OR of up to `termsPerQuery`
 * topics, AND an OR of the conversation phrases of the site's language
 * (none for a language without them: the topics alone, as before), plus the
 * filters and the exclusions, under X's 512 characters. Over it, topics are
 * dropped from the end first, then exclusions, then phrases. The topics
 * start where yesterday's stopped (`dayIndex`), so a long list is covered in
 * turn. Recent search has no minimum-engagement operator at this access
 * level: engagement is filtered after the answer (`filterXPosts`).
 */
export function buildXQueries(params: {
  terms: string[];
  language: string;
  ownHandle?: string | null;
  dayIndex: number;
  queries?: number;
  termsPerQuery?: number;
  /** Test seam: the phrases; the language's otherwise. */
  phrases?: string[];
}): XQuery[] {
  const queries = params.queries ?? X_SEARCH_QUERIES_PER_RUN;
  const perQuery = params.termsPerQuery ?? X_TERMS_PER_QUERY;
  const terms = params.terms;
  if (terms.length === 0 || queries <= 0) return [];
  const filters = xQueryFilters(params.language, params.ownHandle ?? null);
  const allPhrases = params.phrases ?? xConversationPhrases(params.language);
  const allExclusions = xQueryExclusions();

  const wanted = Math.min(queries * perQuery, terms.length);
  const start = ((params.dayIndex % terms.length) * wanted) % terms.length;
  const picked: string[] = [];
  for (let i = 0; i < wanted; i += 1) picked.push(terms[(start + i) % terms.length]);

  const out: XQuery[] = [];
  for (let i = 0; i < picked.length && out.length < queries; i += perQuery) {
    let topics = picked.slice(i, i + perQuery);
    let phrases = allPhrases;
    let exclusions = allExclusions;
    const compose = (withExclusions: boolean) =>
      [orGroup(topics), phrases.length > 0 ? orGroup(phrases) : "", filters, ...(withExclusions ? exclusions : [])]
        .filter(Boolean)
        .join(" ");
    let query = compose(true);
    while (query.length > X_QUERY_MAX_CHARS) {
      if (topics.length > 1) topics = topics.slice(0, -1);
      else if (exclusions.length > 0) exclusions = exclusions.slice(0, -1);
      else if (phrases.length > 1) phrases = phrases.slice(0, -1);
      else break;
      query = compose(true);
    }
    if (query.length > X_QUERY_MAX_CHARS) continue;
    const plain = compose(false);
    out.push({ query, topics: orGroup(topics), plain: plain === query ? null : plain });
  }
  return out;
}

/** The owner's own account on X, read from the links of the replies they posted (`x.com/<handle>/status/…`). */
export function ownXHandle(publishedUrls: (string | null | undefined)[]): string | null {
  const counts = new Map<string, number>();
  for (const raw of publishedUrls) {
    if (!raw) continue;
    const target = canonicalTarget(raw);
    if (!target || target.surface !== "x" || target.kind !== "post" || !target.author || target.author === "i") continue;
    const key = target.author.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [handle, count] of counts) {
    if (count > bestCount) {
      best = handle;
      bestCount = count;
    }
  }
  return best;
}

export interface XSkips {
  /** Already a row of this site (by status id), or twice in this answer. */
  duplicate: number;
  /** By an author the owner replied to in the last 7 days. */
  recentAuthor: number;
  /** More than 50 replies already. */
  crowded: number;
  /** The owner's own post. */
  own: number;
  /** No text to answer. */
  empty: number;
}

/** What the run keeps of what X returned, and why the rest went. Pure. */
export function filterXPosts(
  posts: XApiPost[],
  ctx: { existingIds: ReadonlySet<string>; recentAuthors: ReadonlySet<string>; ownHandle: string | null }
): { keep: XApiPost[]; skipped: XSkips } {
  const skipped: XSkips = { duplicate: 0, recentAuthor: 0, crowded: 0, own: 0, empty: 0 };
  const seen = new Set<string>();
  const keep: XApiPost[] = [];
  const own = ctx.ownHandle?.toLowerCase() ?? null;
  for (const post of posts) {
    const handle = post.handle?.toLowerCase() ?? null;
    if (seen.has(post.id) || ctx.existingIds.has(post.id)) skipped.duplicate += 1;
    else if (own && handle === own) skipped.own += 1;
    else if (handle && ctx.recentAuthors.has(handle)) skipped.recentAuthor += 1;
    // Unknown is not "few": a post X sent without its numbers is kept.
    else if (post.metrics.replies !== null && post.metrics.replies > X_MAX_REPLIES) skipped.crowded += 1;
    else if (!post.text.trim()) skipped.empty += 1;
    else keep.push(post);
    seen.add(post.id);
  }
  return { keep, skipped };
}

function excerptOf(text: string): string {
  const chars = Array.from(text);
  return chars.length <= EXCERPT_MAX ? text : `${chars.slice(0, EXCERPT_MAX - 1).join("").trimEnd()}…`;
}

/** A post as the row discovery stores. `posted_at` is X's own instant (no precision: exact). */
export function xPostAsTarget(post: XApiPost, query: string): StoredTarget {
  const url = post.handle ? `https://x.com/${post.handle}/status/${post.id}` : `https://x.com/i/web/status/${post.id}`;
  const created = post.createdAt && Number.isFinite(Date.parse(post.createdAt)) ? new Date(post.createdAt).toISOString() : null;
  const text = post.text.trim();
  return {
    externalId: `status:${post.id}`,
    surface: "x",
    kind: "post",
    url,
    title: clampText(text, TITLE_MAX),
    excerpt: excerptOf(text),
    community: post.handle ? `@${post.handle}` : "",
    author: post.handle,
    createdAt: created,
    createdAtPrecision: null,
    score: post.metrics.likes,
    commentCount: post.metrics.replies,
    foundFor: query,
    foundVia: X_SEARCH_SOURCE,
    // A day from the post, or from now when X gave no time.
    freshUntil: new Date((created ? Date.parse(created) : Date.now()) + X_SEARCH_FRESH_HOURS * 3_600_000).toISOString(),
  };
}

/**
 * What is recorded about a found post's media: the photos and stills X
 * described, unread when it carried a key X did not describe. Null for a
 * post with no media at all.
 */
export function xPostMediaState(post: Pick<XApiPost, "media" | "mediaUndescribed">): PostMediaState | null {
  if (post.media.length === 0 && post.mediaUndescribed === 0) return null;
  const media = mediaFromProvider(post.media);
  return { media, unread: post.mediaUndescribed > 0 || media.length < post.media.length };
}

/** What the site already knows that the filter needs: the owner's handle and the authors they answered lately. */
export async function loadXSearchContext(
  supabase: SupabaseClient,
  businessId: string,
  now: Date
): Promise<{ ownHandle: string | null; recentAuthors: Set<string> }> {
  const since = new Date(now.getTime() - X_RECENT_AUTHOR_DAYS * 86_400_000).toISOString();
  const [{ data: posted }, { data: recent }] = await Promise.all([
    supabase
      .from("placement_targets")
      .select("published_url")
      .eq("business_id", businessId)
      .eq("surface", "x")
      .not("published_url", "is", null)
      .order("published_at", { ascending: false, nullsFirst: false })
      .limit(20),
    supabase
      .from("placement_targets")
      .select("author")
      .eq("business_id", businessId)
      .eq("surface", "x")
      .eq("status", "published_manually")
      .gte("published_at", since)
      .limit(500),
  ]);
  return {
    ownHandle: ownXHandle(((posted ?? []) as Array<{ published_url: string | null }>).map((r) => r.published_url)),
    recentAuthors: new Set(
      ((recent ?? []) as Array<{ author: string | null }>)
        .map((r) => r.author?.replace(/^@/, "").toLowerCase())
        .filter((a): a is string => Boolean(a))
    ),
  };
}

/** The status ids among `ids` this site already has a row for. */
export async function existingStatusIds(supabase: SupabaseClient, businessId: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const { data, error } = await supabase
    .from("placement_targets")
    .select("external_id")
    .eq("business_id", businessId)
    .eq("surface", "x")
    .in("external_id", ids.map((id) => `status:${id}`));
  if (error) throw new Error(`placement targets: ${error.message}`);
  return new Set(((data ?? []) as Array<{ external_id: string }>).map((r) => r.external_id.slice("status:".length)));
}

export interface XSearchOutcome {
  queries: string[];
  /** Searches X answered. */
  calls: number;
  /** Posts X returned (what was billed). */
  returned: number;
  stored: number;
  skipped: XSkips;
  /** Estimated cost of this run's searches. */
  costUsd: number;
  /** Why the run stopped before its last search, when it did. */
  stopped: MeteredRefusal | null;
  notes: string[];
}

/**
 * One site's daily search: the queries, each under the cap, the filter, the
 * rows. A refusal that will hold for every remaining search (the cap, the
 * pause, a billing or token refusal, a rate limit, the ledger) stops the
 * run; any other failure is noted and the next search is tried.
 */
export async function searchXForBusiness(params: {
  supabase: SupabaseClient;
  client: XApiClient | null;
  business: { id: string; user_id: string; content_language: string | null; niche: string | null };
  keywords: string[];
  entities: string[];
  brandNames: string[];
  now?: Date;
  signal?: AbortSignal;
}): Promise<XSearchOutcome> {
  const now = params.now ?? new Date();
  const { supabase, business } = params;
  const context = await loadXSearchContext(supabase, business.id, now);
  const searches = buildXQueries({
    terms: xSearchTerms({ keywords: params.keywords, entities: params.entities, brandNames: params.brandNames, niche: business.niche }),
    language: business.content_language ?? "en",
    ownHandle: context.ownHandle,
    dayIndex: dayIndexOf(now),
  });

  const outcome: XSearchOutcome = {
    queries: searches.map((q) => q.query),
    calls: 0,
    returned: 0,
    stored: 0,
    skipped: { duplicate: 0, recentAuthor: 0, crowded: 0, own: 0, empty: 0 },
    costUsd: 0,
    stopped: null,
    notes: [],
  };
  const startTime = new Date(now.getTime() - X_SEARCH_WINDOW_HOURS * 3_600_000);

  for (const search of searches) {
    const run = (query: string) =>
      meteredXCall({
        supabase,
        client: params.client,
        worstCaseUsd: X_SEARCH_CALL_WORST_USD,
        now,
        run: (client) => client.searchRecent({ query, maxResults: X_SEARCH_RESULTS_PER_QUERY, startTime, signal: params.signal }),
      });
    let query = search.query;
    let called = await run(query);
    // X refused the query itself (400): an operator it does not take at this
    // access level. A refused call returns no post and is billed nothing;
    // the same search without the exclusions is sent once instead.
    if (!called.ok && called.reason === "error" && /\(400\)/.test(called.message) && search.plain) {
      outcome.notes.push(`${query}: ${called.message}; searched again without the exclusions`);
      query = search.plain;
      called = await run(query);
    }
    if (!called.ok) {
      outcome.notes.push(`${query}: ${called.message}`);
      if (called.reason !== "error") {
        outcome.stopped = called.reason;
        break;
      }
      continue;
    }
    outcome.calls += 1;
    outcome.returned += called.result.billedPosts;
    outcome.costUsd = Math.round((outcome.costUsd + called.result.costUsd) * 10_000) / 10_000;

    const existing = await existingStatusIds(supabase, business.id, called.result.posts.map((p) => p.id));
    const { keep, skipped } = filterXPosts(called.result.posts, { ...context, existingIds: existing });
    for (const key of Object.keys(skipped) as Array<keyof XSkips>) outcome.skipped[key] += skipped[key];
    outcome.stored += await storeTargets({
      supabase,
      userId: business.user_id,
      businessId: business.id,
      targets: keep.map((post) => xPostAsTarget(post, search.topics)),
      now,
    });
    // The media came in the same answer (`attachments.media_keys`, no extra
    // post billed): recorded on the rows of the posts that have some, apart
    // from the insert, so a database without the columns loses the images
    // and nothing else. A post without media keeps `media` null.
    // So did the posts each one quotes or replies to (2026-11-14,
    // referenced.ts): recorded on every kept row, "none" included.
    for (const post of keep) {
      const where = { businessId: business.id, externalId: `status:${post.id}`, surface: "x" };
      const state = xPostMediaState(post);
      if (state) await saveTargetMedia(supabase, where, state);
      const referenced = referencedFromXApi(post);
      if (referenced) await saveTargetReferenced(supabase, where, referenced);
    }
  }

  return outcome;
}
