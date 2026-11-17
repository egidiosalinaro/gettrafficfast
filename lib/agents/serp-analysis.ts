import { z } from "zod";
import { clampText } from "@/lib/content/text";
import { getLlmProvider } from "@/lib/providers/llm/registry";
import { Agent, AgentContext, AgentResult } from "./contract";

/**
 * SERP-analysis agent — reads the real search results for a keyword and
 * judges what they mean: the intent being served, how hard the SERP is to
 * crack, and the angle that would beat what ranks today.
 *
 * This is the difference between planning from the model's priors and
 * planning from evidence. The provider fetched the data; this agent only
 * interprets it, and its output feeds the outline.
 */

export const SEARCH_INTENTS = [
  "informational",
  "commercial",
  "transactional",
  "navigational",
  "mixed",
] as const;
export type SearchIntent = (typeof SEARCH_INTENTS)[number];

export const SerpAnalysisInput = z.object({
  keyword: z.string().min(1),
  language: z.string().min(2),
  businessName: z.string().optional(),
  businessNiche: z.string().optional(),
  results: z
    .array(
      z.object({
        position: z.number(),
        title: z.string(),
        domain: z.string(),
        snippet: z.string(),
      })
    )
    .min(1),
  peopleAlsoAsk: z.array(z.string()).default([]),
  relatedSearches: z.array(z.string()).default([]),
});
export type SerpAnalysisInput = z.infer<typeof SerpAnalysisInput>;

export const SerpAnalysisOutput = z.object({
  intent: z.enum(SEARCH_INTENTS),
  /** 0-100: how hard outranking this SERP realistically is. */
  difficulty: z.number().min(0).max(100),
  /** The take that would beat what ranks — feeds the outline directly. */
  angle: z.string().min(1),
  /** Questions the article must answer (from PAA, snippets, related). */
  questions: z.array(z.string()).max(8).default([]),
  /** What today's results fail to cover — the article's opening. */
  gaps: z.array(z.string()).max(6).default([]),
  /**
   * How many of the results read are articles, guides or blog posts, as
   * opposed to tools, product pages, homepages or app listings. Null when
   * the model did not say: an unknown count never skips an article.
   */
  articleResults: z.number().int().min(0).nullable().default(null),
  /** How many results the count is out of. */
  resultsRead: z.number().int().min(0).default(0),
});
export type SerpAnalysisOutput = z.infer<typeof SerpAnalysisOutput>;

/**
 * Model-facing: no count caps, no closed enums with consequences. An
 * off-list intent degrades to "mixed" at the boundary; maximums are code's
 * job, never the model's.
 */
const LlmSerpAnalysisOutput = z.object({
  intent: z.string().min(1),
  difficulty: z.number(),
  angle: z.string().min(1),
  questions: z.array(z.string()).default([]),
  gaps: z.array(z.string()).default([]),
  articleResults: z.number().nullable().optional(),
});

/**
 * Whether an article can rank for this search, decided by code from what the
 * analysis counted. It cannot when the searcher wants to do or reach
 * something (transactional or navigational) and at most one result in seven
 * is an article: for "content calendar generator" the results were 8/8 free
 * tools, and a 2,442-word guide was published into them anyway. Anything
 * unknown or mixed reads as "can rank": the gate skips only on evidence.
 */
export const MIN_RESULTS_FOR_INTENT_GATE = 5;

export function guideCanRank(analysis: {
  intent: SearchIntent;
  articleResults: number | null;
  resultsRead: number;
}): boolean {
  if (analysis.intent !== "transactional" && analysis.intent !== "navigational") return true;
  if (analysis.articleResults === null || analysis.resultsRead < MIN_RESULTS_FOR_INTENT_GATE) return true;
  return analysis.articleResults / analysis.resultsRead > 1 / 7;
}

const INTENT_SET = new Set<string>(SEARCH_INTENTS);

export const serpAnalysisAgent: Agent<SerpAnalysisInput, SerpAnalysisOutput> = {
  name: "serp-analysis",
  version: 2,
  inputSchema: SerpAnalysisInput,
  outputSchema: SerpAnalysisOutput,

  async run(input, ctx: AgentContext): Promise<AgentResult<SerpAnalysisOutput>> {
    const read = input.results.slice(0, 10);
    const results = read
      .map(
        (r) =>
          `${r.position}. [${r.domain}] ${r.title}
   ${r.snippet.slice(0, 200)}`
      )
      .join("\n");

    const context = [
      input.businessName && `Business: ${input.businessName}`,
      input.businessNiche && `Niche: ${input.businessNiche}`,
    ]
      .filter(Boolean)
      .join("\n");

    const prompt = `You are analysing the REAL Google results for a keyword, to decide how an article can beat them. This is evidence, not speculation — reason only from what is below.

Keyword: ${input.keyword}
${context ? `${context}\n` : ""}
Current top results:
${results}
${input.peopleAlsoAsk.length > 0 ? `\nPeople also ask:\n${input.peopleAlsoAsk.map((q) => `- ${q}`).join("\n")}` : ""}
${input.relatedSearches.length > 0 ? `\nRelated searches:\n${input.relatedSearches.map((q) => `- ${q}`).join("\n")}` : ""}

Judge:
- intent: what the searcher is trying to do, from what actually ranks — informational, commercial, transactional, navigational, or mixed. The pages that rank ARE the evidence of intent.
- difficulty: 0-100. Big brands, deep guides and exact-match titles across the SERP mean high; forums, thin pages and tangential results ranking mean the door is open.
- angle: the single strongest take a new article should lead with to be MORE useful than these results — not a rehash of them.
- questions: the questions the article must answer, drawn from "people also ask", the snippets, and related searches. Real questions only, no inventions.
- gaps: what the current results fail to cover or cover badly — each gap is an opportunity the article should seize.
- articleResults: of the ${read.length} results listed, how many are articles, guides, tutorials or blog posts. A free tool, a generator, a calculator, a product or pricing page, a homepage, an app-store listing or a template gallery is NOT an article. Count from the titles, domains and snippets; give a whole number.

Write angle, questions and gaps in ${input.language}.`;

    const llm = getLlmProvider(undefined, ctx.llmArm);
    const { value, usage } = await llm.generateStructured(prompt, LlmSerpAnalysisOutput, {
      tier: "fast",
      temperature: 0.2,
      signal: ctx.signal,
    });

    return {
      output: {
        intent: (INTENT_SET.has(value.intent) ? value.intent : "mixed") as SearchIntent,
        difficulty: Math.max(0, Math.min(100, value.difficulty)),
        angle: clampText(value.angle, 500),
        questions: value.questions.map((q) => q.trim()).filter(Boolean).slice(0, 8),
        gaps: value.gaps.map((g) => g.trim()).filter(Boolean).slice(0, 6),
        articleResults:
          typeof value.articleResults === "number" && Number.isFinite(value.articleResults)
            ? Math.max(0, Math.min(read.length, Math.round(value.articleResults)))
            : null,
        resultsRead: read.length,
      },
      usage: [usage],
    };
  },
};
