/**
 * What kind of search a topic answers (`keywords.intent`), and the rules
 * that decide it. Pure: phrases and names in, verdicts out, no model, no
 * fetch.
 *
 * Four kinds, because a site that only writes about its own category misses
 * the searches its buyers make on the way (docs/INTELLIGENCE.md, "Search
 * intent of a topic"):
 *
 *   comparison        choosing between tools: "<tool> alternatives",
 *                     "<a> vs <b>", "<tool> review", "<tool> pricing",
 *                     "best <category> tools", "which <category> tools…";
 *   platform_howto    how-to and support questions about a platform or tool
 *                     the audience works in, named in the site's data
 *                     ("how to connect WordPress to Search Console",
 *                     "X account locked", "best day to post on X");
 *   problem           the outcome the reader wants or the problem they have
 *                     ("why do my posts get no views", "how to get more
 *                     impressions", "can AI content rank");
 *   product_adjacent  everything else: the business's own category.
 *
 * Rules decide first, in that order (comparison, problem, platform how-to);
 * a label a model gave, in the suggestion call that already runs, is taken
 * only where the rules found nothing and it cannot invent anything
 * (`settleIntent`). A platform how-to needs a name the site's data holds:
 * the rules never guess that a word is a platform.
 */

export const TOPIC_INTENTS = ["comparison", "platform_howto", "problem", "product_adjacent"] as const;
export type TopicIntent = (typeof TOPIC_INTENTS)[number];

/** The stored value as one of the four, or null (not classified: a row from before 2026-11-15, or a value this build does not know). */
export function parseTopicIntent(value: unknown): TopicIntent | null {
  return typeof value === "string" && (TOPIC_INTENTS as readonly string[]).includes(value) ? (value as TopicIntent) : null;
}

/** How the tools describe the field (lib/tools/*-keywords.ts, get_content). */
export const INTENT_DESCRIPTION =
  'The kind of search the topic answers: "comparison" (choosing between tools: alternatives, vs, review, pricing, best <category> tools), "platform_howto" (a how-to or support question about a platform or tool the site\'s data names), "problem" (the outcome the reader wants or the problem they have), "product_adjacent" (the business\'s own category). Decided by rules from the phrase; for a model\'s suggestion, its label only where the rules found nothing and the label names nothing.';

/** What the Content screen prints next to a topic's source. */
export const TOPIC_INTENT_LABEL: Record<TopicIntent, string> = {
  comparison: "Comparison",
  platform_howto: "How-to",
  problem: "Problem",
  product_adjacent: "Core topic",
};

/** Lower case, accents gone, split on anything that is not a letter or a digit. */
export function tokens(text: string): string[] {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function squash(text: string): string {
  return tokens(text).join("");
}

// ── Comparison ──────────────────────────────────────────────────────────────

/** Nouns that make "best …" or "which …" a choice between tools. */
const TOOL_NOUNS =
  /\b(tools?|software|apps?|platforms?|plugins?|services?|extensions?|schedulers?|generators?|writers?|assistants?|agenc(?:y|ies)|solutions?|programs?|providers?|builders?|editors?|checkers?|trackers?|alternatives?)\b/i;

const COMPARISON_SHAPES: RegExp[] = [
  /\balternativ\w*\b/i, // alternatives, alternative to, alternativa/e (it, es), alternatives (fr), Alternativen (de)
  /\b(vs\.?|versus)\b/i,
  /\bcompar(e|ed|es|ing|ison|isons)\b/i,
  /\b(reviews?|competitors?|pricing)\s*\??$/i,
];

const BEST_OF = /^(?:what\s+(?:are|is)\s+(?:the\s+)?|which\s+(?:are\s+(?:the\s+)?)?)?(best|top(?:\s+\d+)?|migliori|mejores|meilleur[se]?|beste)\b/i;
const WHICH_TOOLS = /^(which|what)\b.*\b(tools?|software|apps?|platforms?)\b/i;

function isComparison(keyword: string): boolean {
  const text = keyword.trim();
  if (COMPARISON_SHAPES.some((shape) => shape.test(text))) return true;
  if (BEST_OF.test(text) && TOOL_NOUNS.test(text)) return true;
  // "Which AI tools are easy to …", "What tool should I use to …"
  return WHICH_TOOLS.test(text);
}

const GENERIC_LEAD = /^(?:(?:the|best|top|free|cheap|cheaper|cheapest|open[- ]source|\d+)\s+)+/i;
const TRAILING_QUALIFIER = /\s+(?:for|in|with|on|to)\s+.+$|\s+\d{4}$|\s*\?$/i;

function cleanSide(side: string): string {
  return side.replace(GENERIC_LEAD, "").replace(TRAILING_QUALIFIER, "").trim();
}

/**
 * The products a comparison phrase names, by its shape: the X of
 * "X alternatives", "alternatives to X", "X vs Y", "X review", "X pricing",
 * "X competitors". "best AI writing tools" names none: it is
 * a category. Lower case, as written.
 */
export function comparedNames(keyword: string): string[] {
  const text = keyword.trim().replace(/\s+/g, " ");
  const sides: string[] = [];
  const vs = text.split(/\s+(?:vs\.?|versus)\s+/i);
  if (vs.length > 1) {
    sides.push(...vs.map((side) => side.replace(/^(?:\w+\s+)*?(?:compare|comparing)\s+/i, "")));
  } else {
    // "alternatives to X" names X; "X alternatives for SEO" names X, not SEO.
    const to = /\balternativ\w*\s+(?:to|a|de|à|zu)\s+(.+)$/i.exec(text);
    const before = /^(.+?)\s+(?:alternativ\w*|reviews?|pricing|competitors?)\b/i.exec(text);
    if (before) sides.push(before[1]);
    if (to) sides.push(to[1]);
  }
  return sides
    .map(cleanSide)
    .map((side) => side.toLowerCase())
    .filter((side) => side.length > 0);
}

// ── Problem ─────────────────────────────────────────────────────────────────

const OUTCOME =
  /\b(rank\w*|traffic|views?|impressions?|clicks?|visib\w*|cited|citations?|leads?|sales|conversions?|engagement|followers?|reach|growth|grow|indexed|indexing|costs?|revenue|signups?|customers?|subscribers?|reply|replies)\b/;
const ASKS = /^(why|how|can|could|does|do|will|is|are|what makes|what's stopping)\b/;
const OUTCOME_VERB = /^(get|getting|increase|improve|boost|grow|drive|fix|reduce|cut|lower|eliminate|stop|avoid|recover|attract|win|double)\b/;
const FAILURE =
  /\b(not working|no (?:views|traffic|impressions|clicks|sales|leads|replies|engagement|followers)|not (?:ranking|indexed|showing|getting)|dropped|declin\w+|low (?:traffic|engagement|impressions|reach))\b/;
const HOW_TO_OUTCOME =
  /\bhow (?:to|do i|do you|can i|can you|should i)\s+(?:get|increase|improve|boost|grow|fix|stop|reduce|avoid|recover|rank|drive|generate|attract|win|be cited|get cited)\b/;

function isProblem(keyword: string): boolean {
  const text = keyword.trim().toLowerCase();
  if (/^why\b/.test(text) || /^(perch[eé]|por qu[eé]|pourquoi|warum)\b/.test(text)) return true;
  if (FAILURE.test(text) || HOW_TO_OUTCOME.test(text) || /\bget more\b/.test(text)) return true;
  return (ASKS.test(text) || OUTCOME_VERB.test(text)) && OUTCOME.test(text);
}

// ── Platform how-to ─────────────────────────────────────────────────────────

const SUPPORT =
  /^(how|can|what|where|when|is|does|do|why)\b|\b(set ?up|setup|settings?|cancel\w*|delete|deactivat\w*|change|reset|connect\w*|integrat\w*|install\w*|export|import|log ?in|login|sign ?in|locked|suspended|banned|shadowban\w*|limits?|api|username|password|subscription|refund|error|verify|verification|schedul\w*|best (?:time|day|days|times) to|tutorial|guide|use|using)\b/;

/**
 * Names that are also ordinary words ("Make", "Writer", "Medium"): they are
 * the tool only when written with a capital, past the first word. Lower
 * case, they are the word.
 */
const COMMON_WORD_NAMES = new Set([
  "make", "writer", "medium", "notion", "buffer", "ghost", "later", "monday", "front", "drift", "loom",
  "copy", "word", "slack", "zoom", "square", "frame", "pages", "keynote", "sprout", "hub", "post", "blog",
  "search", "console", "analytics", "sheets", "docs", "forms", "drive", "meet", "chat",
]);

/** The ways a name is written: "Twitter/X" is "Twitter", "X" and itself. */
function aliases(name: string): string[] {
  const parts = name.split(/\s*\/\s*/).filter(Boolean);
  return [...new Set([name, ...parts].map((p) => p.trim()).filter((p) => tokens(p).length > 0))];
}

/** True when `name` (or one of its aliases) is in the phrase, as whole words. */
export function mentionsName(keyword: string, name: string): boolean {
  const words = tokens(keyword);
  for (const alias of aliases(name)) {
    const target = tokens(alias);
    if (target.length === 0) continue;
    for (let i = 0; i + target.length <= words.length; i += 1) {
      if (!target.every((t, j) => words[i + j] === t)) continue;
      if (target.length === 1 && COMMON_WORD_NAMES.has(target[0])) {
        // Only "…with Make", never "how to make…".
        const written = keyword.match(new RegExp(`(^|[^A-Za-z0-9])(${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(?=$|[^A-Za-z0-9])`, "g")) ?? [];
        const capitalised = written.some((m) => /[A-Z]/.test(m.trim().charAt(0)) && keyword.trim().indexOf(m.trim()) > 0);
        if (!capitalised) continue;
      }
      return true;
    }
  }
  return false;
}

/** The first of `names` the phrase mentions, or null. */
export function mentionedName(keyword: string, names: readonly string[]): string | null {
  return names.find((name) => mentionsName(keyword, name)) ?? null;
}

// ── The verdict ─────────────────────────────────────────────────────────────

export interface IntentContext {
  /** Platforms and tools the site's data names (lib/keywords/named-tools.ts). Empty: no platform how-to is recognised. */
  names?: readonly string[];
}

/** The rules alone. */
export function classifyTopicIntent(keyword: string, context: IntentContext = {}): TopicIntent {
  const text = keyword.trim();
  if (!text) return "product_adjacent";
  if (isComparison(text)) return "comparison";
  if (isProblem(text)) return "problem";
  const names = context.names ?? [];
  if (names.length > 0 && SUPPORT.test(text.toLowerCase()) && mentionedName(text, names)) return "platform_howto";
  // A named platform with nothing else: "X api limits" matches SUPPORT on
  // "api"; a bare name ("WordPress") is the platform itself, a core topic.
  return "product_adjacent";
}

/**
 * The rules, then a label a model gave where the rules found nothing.
 *
 *  - the rules' comparison, problem and platform how-to always stand;
 *  - where the rules say product_adjacent, a model's "problem" is taken (it
 *    names nothing); its "comparison" is not (the phrase has none of the
 *    shapes a comparison has), and its "platform_howto" is not either (the
 *    phrase names no platform the site's data holds, so it would be a guess).
 */
export function settleIntent(keyword: string, modelLabel: unknown, context: IntentContext = {}): TopicIntent {
  const ruled = classifyTopicIntent(keyword, context);
  if (ruled !== "product_adjacent") return ruled;
  return parseTopicIntent(modelLabel) === "problem" ? "problem" : "product_adjacent";
}

/** The stored intent, or the rules' verdict for a row stored before intents were (null). */
export function intentOf(stored: unknown, keyword: string, context: IntentContext = {}): TopicIntent {
  return parseTopicIntent(stored) ?? classifyTopicIntent(keyword, context);
}

// ── No invented competitor ──────────────────────────────────────────────────

/**
 * Words a category is made of: a side of "AI writer vs human writer" built
 * from these names no product, so it needs no evidence.
 */
const CATEGORY_WORDS = new Set([
  "ai", "seo", "aeo", "geo", "llm", "llms", "content", "writer", "writers", "writing", "tool", "tools", "software",
  "app", "apps", "agency", "agencies", "human", "humans", "freelancer", "freelancers", "manual", "automated",
  "automation", "automatic", "blog", "blogs", "blogging", "article", "articles", "marketing", "platform", "platforms",
  "service", "services", "plugin", "plugins", "generator", "generators", "assistant", "assistants", "free", "paid",
  "online", "social", "media", "email", "scheduler", "schedulers", "crm", "cms", "in", "house", "inhouse", "team",
  "outsourcing", "diy", "traditional", "organic", "ads", "ppc", "search", "engine", "engines", "chatbot", "chatbots",
  "copywriter", "copywriters", "copywriting", "editor", "editors", "the", "a", "an", "and", "or", "of", "for", "my",
  "your", "own", "custom", "local", "small", "business", "businesses", "startup", "startups", "enterprise", "open",
  "source", "self", "hosted", "cloud", "desktop", "mobile", "web", "website", "websites", "site", "sites",
]);

export interface ComparisonEvidence {
  /** Products the site's data names (lib/keywords/named-tools.ts). */
  names: readonly string[];
  /** The business's own name: "<business> vs <tool>" names it. */
  businessName?: string | null;
  /** The business's profile as the owner wrote it (niche, description): a word there is the owner's, not invented. */
  profile?: string | null;
}

/** True when `side` is a product the evidence names, the business itself, or a category. */
function sideIsKnown(side: string, evidence: ComparisonEvidence): boolean {
  const flat = squash(side);
  if (!flat) return true;
  const sideTokens = tokens(side);
  if (sideTokens.every((t) => CATEGORY_WORDS.has(t))) return true;
  const candidates = [...evidence.names, ...(evidence.businessName ? [evidence.businessName] : [])].flatMap(aliases);
  for (const candidate of candidates) {
    const c = squash(candidate);
    if (!c) continue;
    if (c === flat) return true;
    // "Surfer SEO" is "surfer", "Junia AI" is "junia": the brand without the category word.
    const core = tokens(candidate).filter((t) => !CATEGORY_WORDS.has(t)).join("");
    const sideCore = sideTokens.filter((t) => !CATEGORY_WORDS.has(t)).join("");
    if (core && sideCore && core === sideCore) return true;
  }
  const profile = tokens(evidence.profile ?? "");
  if (profile.length > 0) {
    const set = new Set(profile);
    if (sideTokens.every((t) => set.has(t) || CATEGORY_WORDS.has(t))) return true;
  }
  return false;
}

/**
 * The names in a comparison phrase that nothing in the site's data vouches
 * for: neither a product its data names, nor the business, nor its own
 * profile, nor a plain category. Empty when the phrase invents nothing.
 *
 * Used on what a model proposes, never on what a person adds: a person may
 * compare anything they like. A model's "Fooly alternatives" is refused,
 * because a page about a product the data never saw is a page about a guess.
 * The price of the rule, said plainly: a real comparison whose products the
 * data has not met yet ("butter alternatives" for a bakery whose profile
 * never says butter) is refused too, until the data names them.
 */
export function unknownComparedNames(keyword: string, evidence: ComparisonEvidence): string[] {
  if (!isComparison(keyword)) return [];
  return comparedNames(keyword).filter((side) => !sideIsKnown(side, evidence));
}

// ── The weekly mix ──────────────────────────────────────────────────────────

/**
 * What a week of articles aims for, when the pool has them (docs/
 * AUTOPILOT.md, "A week's mix"): one or two comparisons, two platform
 * how-tos, two or three problem pieces; the rest core topics. `min` is
 * filled first, `max` is not passed while anything else is left.
 */
export const WEEKLY_MIX: Record<TopicIntent, { min: number; max: number }> = {
  comparison: { min: 1, max: 2 },
  platform_howto: { min: 2, max: 2 },
  problem: { min: 2, max: 3 },
  product_adjacent: { min: 0, max: 7 },
};

/** The order the minimums are filled in when a week has fewer free days than minimums. */
const MIN_ORDER: TopicIntent[] = ["problem", "platform_howto", "comparison"];

export interface MixCandidate {
  id: string;
  score: number;
  /** Null or absent: a core topic, as far as the mix is concerned. */
  intent?: TopicIntent | null;
}

/**
 * Takes up to `slots` candidates for one week out of `queue` (best score
 * first, and it is consumed), given the intents the week already holds.
 *
 * First the minimums, one intent at a time in turn (the one furthest below
 * its minimum first), each time the best-scored candidate of that intent.
 * Then the rest by score, skipping an intent at its maximum; and when only
 * those are left, the best of them anyway: an empty day is worse than a
 * third comparison. With no intents in the pool this is the score order,
 * exactly as before.
 */
export function takeWeek<T extends MixCandidate>(queue: T[], held: Partial<Record<TopicIntent, number>>, slots: number): T[] {
  const counts: Record<TopicIntent, number> = {
    comparison: held.comparison ?? 0,
    platform_howto: held.platform_howto ?? 0,
    problem: held.problem ?? 0,
    product_adjacent: held.product_adjacent ?? 0,
  };
  const chosen: T[] = [];
  const kind = (c: T): TopicIntent => c.intent ?? "product_adjacent";
  const take = (index: number) => {
    const [picked] = queue.splice(index, 1);
    counts[kind(picked)] += 1;
    chosen.push(picked);
  };

  let progressed = true;
  while (chosen.length < slots && progressed) {
    progressed = false;
    const short = MIN_ORDER.filter((intent) => counts[intent] < WEEKLY_MIX[intent].min).sort(
      (a, b) => WEEKLY_MIX[b].min - counts[b] - (WEEKLY_MIX[a].min - counts[a])
    );
    for (const intent of short) {
      if (chosen.length >= slots) break;
      const index = queue.findIndex((c) => kind(c) === intent);
      if (index === -1) continue;
      take(index);
      progressed = true;
    }
  }

  while (chosen.length < slots && queue.length > 0) {
    const index = queue.findIndex((c) => counts[kind(c)] < WEEKLY_MIX[kind(c)].max);
    take(index === -1 ? 0 : index);
  }

  // Within the week, best first: the earliest free day gets the best topic.
  return chosen.sort((a, b) => b.score - a.score);
}

/**
 * The whole pool in the order the mix would schedule it, a week at a time
 * from an empty week: what the Content screen lists as "Next topics".
 */
export function mixOrder<T extends MixCandidate>(available: readonly T[]): T[] {
  const queue = [...available].sort((a, b) => b.score - a.score);
  const out: T[] = [];
  while (queue.length > 0) out.push(...takeWeek(queue, {}, 7));
  return out;
}

/**
 * Which `count` of a suggestion call's ideas to buy, when the top-up needs
 * fewer than it got: the kinds the pool lacks most first (a week's minimum
 * less what the pool holds), one kind at a time in turn, and within a kind
 * in the order the ideas came. Costs nothing: it chooses among ideas the
 * one call already returned, and buys no more than the floor asks for.
 */
export function chooseForPool<T extends { intent?: TopicIntent | null }>(
  ideas: readonly T[],
  pool: Partial<Record<TopicIntent, number>>,
  count: number
): T[] {
  const kind = (idea: T): TopicIntent => idea.intent ?? "product_adjacent";
  const need = (intent: TopicIntent) => WEEKLY_MIX[intent].min - (pool[intent] ?? 0);
  const order: TopicIntent[] = [...MIN_ORDER, "product_adjacent" as const].sort((a, b) => need(b) - need(a));
  const left = [...ideas];
  const chosen: T[] = [];
  while (chosen.length < count && left.length > 0) {
    let took = false;
    for (const intent of order) {
      if (chosen.length >= count) break;
      const index = left.findIndex((idea) => kind(idea) === intent);
      if (index === -1) continue;
      chosen.push(...left.splice(index, 1));
      took = true;
    }
    if (!took) break;
  }
  return chosen;
}
