import { z } from "zod";
import { clampText } from "@/lib/content/text";
import { getLlmProvider } from "@/lib/providers/llm/registry";
import { Agent, AgentContext, AgentResult } from "./contract";
import {
  ArticleEvidence,
  BusinessFacts,
  STOCK_PHRASE_RULES,
  TITLE_RULES,
  businessBlock,
  evidenceBlock,
  factsBlock,
  isComparativeKeyword,
} from "./article-brief";

/**
 * Outline agent — decides what the article says before anything writes it.
 *
 * The outline is where AEO is won or lost: an answer engine retrieves a
 * passage, so every section must state the question it answers and be
 * self-contained. Encoding that here means the writing agent inherits the
 * structure instead of being asked to remember rules while composing prose.
 */

/**
 * What the research step learned from the REAL search results. Optional: the
 * outline works without it (no SERP provider configured), but when present it
 * turns planning-from-priors into planning-from-evidence.
 */
export const OutlineSerpContext = z.object({
  intent: z.string().min(1),
  angle: z.string().min(1),
  questions: z.array(z.string()).default([]),
  /** Titles ranking today — the article must not be another one of these. */
  competitorTitles: z.array(z.string()).default([]),
  gaps: z.array(z.string()).default([]),
});
export type OutlineSerpContext = z.infer<typeof OutlineSerpContext>;

export const OutlineInput = BusinessFacts.extend({
  keyword: z.string().min(1),
  language: z.string().min(2),
  serp: OutlineSerpContext.optional(),
  /** The results themselves: titles, snippets, "people also ask". */
  evidence: ArticleEvidence.optional(),
});
export type OutlineInput = z.infer<typeof OutlineInput>;

const Section = z.object({
  heading: z.string().min(1).describe("H2 text, phrased as the question a reader would ask"),
  question: z.string().min(1).describe("The exact question this section answers"),
  answer: z.string().min(1).describe("The direct answer, 1-2 sentences, to open the section"),
  points: z.array(z.string()).min(1).max(6).describe("Supporting points to develop"),
  subsections: z.array(z.string()).max(4).default([]).describe("Optional H3 headings"),
});

export const OutlineOutput = z.object({
  title: z.string().min(1).max(120),
  angle: z.string().min(1).describe("What makes this article worth reading"),
  intro: z.string().min(1).describe("Brief for the opening paragraph"),
  /**
   * The direct answer to the article's question, 3-6 sentences: the "short
   * version" paragraph that opens the article (2026-11-15). Absent on
   * outlines stored before it existed.
   */
  shortVersion: z.string().optional(),
  sections: z.array(Section).min(3).max(8),
  faq: z
    .array(z.object({ question: z.string().min(1), answer: z.string().min(1) }))
    .max(6)
    .default([]),
  entities: z
    .array(z.string())
    .max(15)
    .default([])
    .describe("Named concepts, products and terms the article must cover"),
});
export type OutlineOutput = z.infer<typeof OutlineOutput>;

/**
 * Model-facing schema: minimums stay (they are quality requirements the model
 * must meet), maximums are gone (models cannot count — a 16th entity
 * dead-lettered a production job). Caps are applied deterministically below.
 */
const LlmSection = z.object({
  heading: z.string().min(1),
  question: z.string().min(1),
  answer: z.string().min(1),
  points: z.array(z.string()).min(1),
  subsections: z.array(z.string()).default([]),
});
const LlmOutlineOutput = z.object({
  title: z.string().min(1),
  angle: z.string().min(1),
  intro: z.string().min(1),
  shortVersion: z.string().default(""),
  sections: z.array(LlmSection).min(3),
  faq: z.array(z.object({ question: z.string().min(1), answer: z.string().min(1) })).default([]),
  entities: z.array(z.string()).default([]),
});

function serpSection(serp: OutlineSerpContext): string {
  const parts = [
    `\nWhat Google currently shows for this keyword (real data, not assumptions):`,
    `- Dominant search intent: ${serp.intent}`,
  ];
  if (serp.competitorTitles.length > 0) {
    parts.push(`- Titles ranking today:\n${serp.competitorTitles.map((t) => `  - ${t}`).join("\n")}`);
  }
  if (serp.questions.length > 0) {
    parts.push(`- Questions searchers also ask:\n${serp.questions.map((q) => `  - ${q}`).join("\n")}`);
  }
  if (serp.gaps.length > 0) {
    parts.push(`- What today's results fail to cover:\n${serp.gaps.map((g) => `  - ${g}`).join("\n")}`);
  }
  parts.push(`- Recommended angle: ${serp.angle}`);
  parts.push(
    `Plan the article to serve this intent BETTER than what ranks: take the recommended angle, answer the searchers' questions where they naturally fit, seize the gaps, and never produce a rehash of a title that already ranks.`
  );
  return parts.join("\n") + "\n";
}

export const outlineAgent: Agent<OutlineInput, OutlineOutput> = {
  name: "outline",
  version: 6,
  inputSchema: OutlineInput,
  outputSchema: OutlineOutput,

  async run(input, ctx: AgentContext): Promise<AgentResult<OutlineOutput>> {
    const business = businessBlock(input);
    const paa = input.evidence?.questions ?? [];

    const prompt = `You are a senior SEO and content strategist. Plan an article for the target keyword below.

Keyword: ${input.keyword}
${business ? `\n${business}\n` : ""}${input.serp ? serpSection(input.serp) : ""}
${evidenceBlock(input.evidence)}

${factsBlock(input)}

Write every field in ${input.language}.

${TITLE_RULES}

How to plan it:
- Identify the search intent behind the keyword and serve it directly.
- Plan for 900–1500 words in total. That is a ceiling for most keywords, not a target to exceed: a search answered in 900 words gets 900.
- shortVersion: the direct answer to the article's question in 3 to 6 sentences (at most 100 words), complete on its own. It opens the article, right under the title, so an answer engine can quote it alone: no teaser, no "in this article", no mention of the business.
- 5 to 8 sections (H2). Most section headings are the questions people actually ask, written as questions ending in "?"${
      paa.length > 0 ? ', in the searchers\' own words from "People also ask" where one fits' : ""
    }; at least half of them must be.
- Each section states the question it answers and a direct 1-2 sentence answer that will OPEN the section. This matters: AI answer engines retrieve individual passages, so a section must make sense on its own, with no reference to earlier sections.
- Subsections (H3) only where a section will run to 150 words or more for EACH subsection. Most sections have none. A heading every three sentences is an index, not an article.
- ${
      isComparativeKeyword(input.keyword)
        ? "This keyword compares options: plan one section built around a comparison table (name its columns in the section's points), using only attributes the evidence supports."
        : "If the keyword compares options, plan a comparison table; if it is a technical how-to, plan the code or config blocks the reader will copy."
    }
- Cover the concrete entities, products and terms someone researching this topic expects to see.
- FAQ: 3 to 5 real questions, or none. ${
      paa.length > 0
        ? `Prefer the "People also ask" questions above, in the searchers' own words, when the sections do not already answer them.`
        : "Only questions a searcher really asks and the sections do not already answer."
    } One or two questions is not an FAQ: leave it empty.
- The intro brief must not mention the business or its product. ${input.businessName ?? "The business"} may be named once, in the closing section, in a plain sentence.

${STOCK_PHRASE_RULES}
The intro brief you write is followed literally, so do not ask for a "landscape" or "evolving world" opening.`;

    const llm = getLlmProvider(undefined, ctx.llmArm);
    const { value, usage } = await llm.generateStructured(prompt, LlmOutlineOutput, {
      tier: "fast",
      temperature: 0.6,
      signal: ctx.signal,
    });

    return {
      output: {
        title: clampText(value.title, 120),
        angle: value.angle,
        intro: value.intro,
        shortVersion: value.shortVersion.trim(),
        sections: value.sections.slice(0, 8).map((section) => ({
          ...section,
          points: section.points.slice(0, 6),
          subsections: section.subsections.slice(0, 4),
        })),
        // 3 to 5 real questions, or none: one question under an "FAQ"
        // heading is a section pretending to be a list.
        faq: value.faq.length >= 3 ? value.faq.slice(0, 5) : [],
        entities: value.entities.slice(0, 15),
      },
      usage: [usage],
    };
  },
};
