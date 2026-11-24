import { z } from "zod";
import { getLlmProvider } from "@/lib/providers/llm/registry";
import { contentLanguageName } from "@/lib/content-language";

/**
 * Keyword research.
 *
 * Still a direct capability rather than an agent — it is called synchronously
 * from the keywords page. It goes through the LLM provider like everything
 * else, so no model vendor is named here, and the response is schema-validated
 * instead of hand-parsed.
 */

export const KeywordSuggestion = z.object({
  keyword: z.string().min(1),
  searchVolume: z.number().nullable().default(null),
  competition: z.enum(["Low", "Medium", "High"]).default("Medium"),
  difficulty: z.number().min(0).max(100).default(50),
  cpc: z.number().nullable().default(null),
  opportunity: z.enum(["Low", "Medium", "High"]).default("Medium"),
  /**
   * The model's label for the kind of search (lib/keywords/intent.ts). Not a
   * closed enum at the boundary: an off-list value is read as no label, and
   * code decides what is stored (`settleSuggestions`).
   */
  intent: z.string().nullable().default(null),
});
export type KeywordSuggestion = z.infer<typeof KeywordSuggestion>;

const Suggestions = z.object({ keywords: z.array(KeywordSuggestion).min(1).max(25) });

const FIELD_GUIDE = `Each keyword carries:
- keyword: the phrase
- searchVolume: estimated monthly searches (number, or null when unknown)
- competition: "Low" | "Medium" | "High"
- difficulty: 0-100, realistic (most fall between 20 and 80)
- cpc: estimated cost per click in USD (number, or null)
- opportunity: "Low" | "Medium" | "High", from volume weighed against competition
- intent: "comparison" | "platform_howto" | "problem" | "product_adjacent"`;

/** What the site's own data names, for the suggestion call (lib/keywords/named-tools.ts). */
export interface SuggestionContext {
  /** The business's own name: "<name> vs <tool>" may name it. */
  businessName?: string;
  /** Products and platforms the site's data names: the only ones a keyword may name. */
  names?: readonly string[];
  /**
   * Topics the site already has (its keywords and published titles). The
   * top-up refuses any suggestion that overlaps one of them
   * (`freshSuggestions`), so a site with a long history got suggestions that
   * were all refused, day after day, from a call that was paid for. Listing
   * them asks for new ground in the same single call; code still checks.
   */
  avoid?: readonly string[];
}

/** How many existing topics the suggestion prompt lists at most: keeps the prompt bounded. */
export const AVOID_TOPICS_MAX = 80;

/** The "already covered" block of the suggestion prompt; empty when there is nothing to avoid. */
export function avoidBlock(context: SuggestionContext = {}): string {
  const seen = new Set<string>();
  const topics: string[] = [];
  for (const raw of context.avoid ?? []) {
    const topic = raw.trim();
    const key = topic.toLowerCase();
    if (!topic || seen.has(key)) continue;
    seen.add(key);
    topics.push(topic);
    if (topics.length >= AVOID_TOPICS_MAX) break;
  }
  if (topics.length === 0) return "";
  return `This site already covers the topics below. Suggest only NEW topics: none that repeats one of them, rephrases it or adds a word or two to it.
${topics.map((t) => `- ${t}`).join("\n")}`;
}

/**
 * The mix of searches a pool needs (docs/INTELLIGENCE.md, "Search intent of
 * a topic"), and the rule that keeps it honest: a product is named only when
 * the site's own data names it. The prompt says it; code checks it after
 * (`settleSuggestions`), because a prompt is a request, not a guarantee.
 */
export function intentMixBlock(context: SuggestionContext = {}): string {
  const names = (context.names ?? []).map((n) => n.trim()).filter(Boolean);
  const business = context.businessName?.trim() || "the business";
  const list = names.length
    ? `Named in this site's own data (its articles, the searches it competes in, AI answers about its topics). These are the ONLY products and platforms you may name:\n${names.map((n) => `- ${n}`).join("\n")}`
    : "No product or platform is named in this site's data yet, so name none.";
  return `Cover four kinds of search, roughly a quarter each where the material allows, and label each keyword with its intent:
- "comparison": a reader choosing between tools: "<tool> alternatives", "${business} vs <tool>", "<tool> review", "best <category> tools". Use only tools from the list below that are genuine alternatives to ${business}. With no fitting tool on the list, only "best <category> …" phrases that name no product.
- "platform_howto": how-to and support questions about platforms and tools from the list below that this audience works in every day (set up, connect, cancel, limits, errors, the best time to post). Only platforms from the list; with none fitting, write none.
- "problem": the outcome this audience wants or the problem it has, as people ask it ("why does my … get no …", "how to get more …").
- "product_adjacent": the business's core topics.
${list}
Never name any other product, brand or company: no example, no guess.
For "comparison", "platform_howto" and "problem" keywords set searchVolume and cpc to null: nobody has measured them.`;
}

export async function generateKeywordsFromBusiness(
  businessNiche?: string,
  businessDescription?: string,
  websiteUrl?: string,
  contentLanguage?: string,
  named: SuggestionContext = {}
): Promise<KeywordSuggestion[]> {
  const language = contentLanguageName(contentLanguage);
  const context = [
    businessNiche && `Niche: ${businessNiche}`,
    businessDescription && `Description: ${businessDescription}`,
    websiteUrl && `Website: ${websiteUrl}`,
  ]
    .filter(Boolean)
    .join("\n");

  const prompt = `You are an SEO expert. Generate 15-25 keywords worth creating content for, based on this business.

${context}

Cover: core products and services, how the target audience actually searches, industry terms, long-tail variations, related topics, and local intent where it applies. Mix short-tail and long-tail, and mix informational, commercial and transactional intent.

${intentMixBlock(named)}
${avoidBlock(named) ? `\n${avoidBlock(named)}\n` : ""}
${FIELD_GUIDE}

Write every keyword in ${language}, regardless of the language of the business information.`;

  const { value } = await getLlmProvider().generateStructured(prompt, Suggestions, {
    tier: "fast",
    temperature: 0.7,
  });
  return value.keywords;
}

export async function findSimilarKeywords(
  userKeywords: string[],
  businessNiche?: string,
  businessDescription?: string,
  contentLanguage?: string
): Promise<KeywordSuggestion[]> {
  const language = contentLanguageName(contentLanguage);
  const context = [
    businessNiche && `Niche: ${businessNiche}`,
    businessDescription && `Description: ${businessDescription}`,
  ]
    .filter(Boolean)
    .join("\n");

  const prompt = `You are an SEO expert. Generate 10-20 keywords related to the ones below: variations, long-tail forms and adjacent terms worth their own article.

User keywords:
${userKeywords.map((k) => `- ${k}`).join("\n")}
${context ? `\nBusiness context:\n${context}\n` : ""}
${FIELD_GUIDE}

Write every keyword in ${language}, regardless of the language of the user's keywords.`;

  const { value } = await getLlmProvider().generateStructured(prompt, Suggestions, {
    tier: "fast",
    temperature: 0.7,
  });
  return value.keywords;
}
