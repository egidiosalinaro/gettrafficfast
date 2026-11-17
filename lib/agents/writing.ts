import { z } from "zod";
import { getLlmProvider } from "@/lib/providers/llm/registry";
import type { LlmUsage } from "@/lib/providers/llm/types";
import { Agent, AgentContext, AgentResult } from "./contract";
import {
  ArticleEvidence,
  BusinessFacts,
  STOCK_PHRASE_RULES,
  TITLE_RULES,
  anatomyRules,
  businessBlock,
  comparisonBlock,
  comparisonProductRule,
  evidenceBlock,
  factsBlock,
  isComparativeKeyword,
  isComparisonBrief,
} from "./article-brief";
import { OutlineOutput } from "./outline";
import { anatomyLabels, isQuestion } from "@/lib/content/anatomy";

/**
 * The H2 the plan gives the writer: the section's heading when it is a
 * question, else the question it answers (2026-11-15: most headings are the
 * questions people ask). Code decides, not the model.
 */
export function sectionHeading(section: { heading: string; question: string }): string {
  if (isQuestion(section.heading) || !isQuestion(section.question)) return section.heading;
  return section.question;
}

/**
 * Writing agent — turns an approved outline into the article.
 *
 * It returns the document as text rather than as a JSON field: wrapping 1500
 * words of HTML in JSON buys nothing and adds an escaping failure mode. The
 * shape of what comes back is not trusted here either way — the content
 * pipeline validates it downstream, exactly as it validates any model output.
 *
 * The revision agent below is the same writer given its own draft and the
 * problems found in it. Both state the same rules (`writingRules`), so a
 * revision cannot be told something the first draft was not.
 */

export const WritingInput = BusinessFacts.extend({
  keyword: z.string().min(1),
  language: z.string().min(2),
  outline: OutlineOutput,
  /** The real results, so the writer can cite what it states. */
  evidence: ArticleEvidence.optional(),
});
export type WritingInput = z.infer<typeof WritingInput>;

export const WritingOutput = z.object({
  html: z.string().min(1),
  /** The model that wrote it, as the provider reported it. */
  model: z.string().optional(),
  /** True when it was not the model the quality tier is configured for. */
  fallback: z.boolean().optional(),
  /** True when a model outside the quality family wrote it. */
  tierDowngraded: z.boolean().optional(),
});
export type WritingOutput = z.infer<typeof WritingOutput>;

/** Who wrote it, read off the usage the provider returned. */
function served(usage: LlmUsage): Pick<WritingOutput, "model" | "fallback" | "tierDowngraded"> {
  return {
    model: usage.model,
    fallback: usage.fallback ?? false,
    tierDowngraded: usage.tierDowngraded ?? false,
  };
}

/** The writer runs on the quality tier and stays in it (docs/AGENT_RUNTIME.md, "Model selection"). */
const WRITER_OPTIONS = { tier: "quality", keepTier: true, temperature: 0.7 } as const;

interface RulesInput extends BusinessFacts {
  keyword: string;
  language: string;
}

/**
 * The rules every draft and every revision is held to. Exported so a test
 * can read what the model was told.
 */
export function writingRules(input: RulesInput): string {
  const name = input.businessName?.trim();
  const site = input.websiteUrl?.trim();
  return `Requirements:
- Write the entire article in ${input.language}.
- Length: 900–1500 words. That is a ceiling for most keywords, not a floor: stop when the search is answered. Never exceed 1,800 words; a draft over that is sent back to be cut.
- Open every H2 with its direct answer in the first two or three sentences, then develop it. Each section must stand on its own: never write "as we saw above" or refer to other sections.
- Short paragraphs (2–4 sentences). Use <ul>/<ol> for steps and features.
- Use the keyword and natural variations in the title, the intro, at least one H2 and the closing section. Never keyword-stuff.

${anatomyRules(input)}

Headings:
- 5 to 8 <h2> sections, the data section aside.
- An <h3> only when its own subsection runs to 150 words or more. A section of three paragraphs needs no subsections. If in doubt, no <h3>.
- FAQ: 3 to 5 real questions under one <h2>, each question an <h3> with a short paragraph, or no FAQ at all. Never an FAQ of one or two questions.

Tables and code:
- ${
    isComparativeKeyword(input.keyword) || isComparisonBrief(input)
      ? "This keyword compares options: include one comparison <table> (with <thead> and <tbody>) whose cells contain only what the evidence supports. A cell you cannot fill from the evidence says so in words or the column is dropped."
      : "When the article compares options side by side, use a comparison <table> (with <thead> and <tbody>) rather than prose."
  }
- When the article explains something done in code, config or a terminal, show it: <pre><code>…</code></pre> for blocks the reader copies, <code> inline for names and commands. A technical how-to without a code block has skipped the how.

${TITLE_RULES}

${STOCK_PHRASE_RULES}

Facts and numbers:
${factsBlock(input)}
- Do NOT invent statistics, quotes, prices, plan names, ratings or product features, for this business or for any competitor.

Links:
- ${
    site
      ? `The business's only website is ${site}. Any link to ${name ?? "the business"} uses exactly that host. Never guess another domain for it (.com, .io, a "www." variant with the brand name): a guessed address is a broken or hijacked link.`
      : `No website is on record for ${name ?? "the business"}: do not link to it and do not write a domain for it.`
  }
- Other external links only when the URL appears in the search evidence. Do NOT embed images, iframes or videos.

The product:
${
    isComparisonBrief(input)
      ? `- ${comparisonProductRule(input)}

${comparisonBlock(input)}`
      : `- ${name ?? "The business"} is not mentioned in the introduction and not in the body.
- It may be mentioned at most once, in the closing section, in one plain sentence saying what it does. No superlatives ("unparalleled", "best", "leading", "ultimate"), no pitch, no feature list. If it does not fit naturally, leave it out.`
  }
- End with a closing <h2> that tells the reader the next thing to do.

Formatting (critical):
- Output valid semantic HTML ONLY. <strong> for bold, <em> for italics.
- NEVER use Markdown: no **, no __, no #, no backticks, no [text](url). No code fences: code goes in <pre><code>.
- Allowed tags: <h1>, <h2>, <h3>, <p>, <ul>, <ol>, <li>, <strong>, <em>, <a>, <blockquote>, <table>, <thead>, <tbody>, <tr>, <th>, <td>, <pre>, <code>.`;
}

export const writingAgent: Agent<WritingInput, WritingOutput> = {
  name: "writing",
  version: 4,
  inputSchema: WritingInput,
  outputSchema: WritingOutput,

  async run(input, ctx: AgentContext): Promise<AgentResult<WritingOutput>> {
    const { outline } = input;
    const business = businessBlock(input);

    const plan = outline.sections
      .map((section, index) => {
        const subs = section.subsections.length
          ? `\n   Subsections (H3, only if each will run to 150+ words): ${section.subsections.join(" | ")}`
          : "";
        return `${index + 1}. H2: ${sectionHeading(section)}
   Question: ${section.question}
   Open with this answer: ${section.answer}
   Develop: ${section.points.join("; ")}${subs}`;
      })
      .join("\n\n");

    const shortVersion = outline.shortVersion?.trim()
      ? `\nThe short version (the paragraph right after the <h1>, labelled "${anatomyLabels(input.language).shortVersion}:"): ${outline.shortVersion}\n`
      : "";

    const faq = outline.faq.length
      ? `\n\nFAQ section (H2 "FAQ", each question an H3, each answer a short paragraph):\n${outline.faq
          .map((f) => `- ${f.question} → ${f.answer}`)
          .join("\n")}`
      : "";

    const prompt = `You are an expert content writer. Write the article below to plan.

Title (use as the <h1>): ${outline.title}
Target keyword: ${input.keyword}
Angle: ${outline.angle}
Opening brief: ${outline.intro}${shortVersion}
${business ? `\n${business}\n` : ""}
${evidenceBlock(input.evidence)}

Sections, in this order:

${plan}${faq}
${outline.entities.length ? `\nCover these concepts naturally: ${outline.entities.join(", ")}.` : ""}

If the planned title breaks a title rule below, fix the title rather than follow the plan.

${writingRules(input)}
- Start directly with the <h1>. Output nothing before it — no plan, no notes, no preamble.`;

    const llm = getLlmProvider("writer", ctx.llmArm);
    const { text, usage } = await llm.generateText(prompt, { ...WRITER_OPTIONS, signal: ctx.signal });

    return { output: { html: text.trim(), ...served(usage) }, usage: [usage] };
  },
};

// ── Revision ────────────────────────────────────────────────────────────────

export const RevisionInput = BusinessFacts.extend({
  keyword: z.string().min(1),
  language: z.string().min(2),
  /** The draft as the writer returned it, <h1> included. */
  draftHtml: z.string().min(1),
  /** What the gates and the audit found, each as one sentence. */
  problems: z.array(z.string().min(1)).min(1),
  evidence: ArticleEvidence.optional(),
});
export type RevisionInput = z.infer<typeof RevisionInput>;

/**
 * What a rewrite may do with the business's name. On 2026-11-12 a revision
 * asked to fix an E-E-A-T finding came back naming the product in two
 * sentences (PRODUCT_MENTION), and was kept. A rewrite never adds a
 * mention: at most one, in the closing section.
 */
export function productRule(facts: BusinessFacts): string {
  const name = facts.businessName?.trim() || "the business";
  if (isComparisonBrief(facts)) {
    return `The business, whatever the problems above say:
- ${comparisonProductRule(facts)}
- Do NOT add anything about ${name} that the business facts above do not state.`;
  }
  return `The business, whatever the problems above say:
- Do NOT add any mention of ${name}. Adding one is never the fix for a problem above.
- ${name} appears at most once in the whole article, in the closing section, in one plain sentence. If the draft names it anywhere else, or in more than one sentence, remove those mentions.`;
}

/**
 * One rewrite with the findings named: the same pattern as the placement
 * draft's rewrite (lib/jobs/workflows/placement-draft.ts), run at most once
 * per article by the workflow. It rewrites the whole document rather than
 * patching it, because the fixes are editorial (cut 900 words, drop an
 * invented price, retitle) and nothing in this platform edits article markup
 * by substitution.
 */
export const revisionAgent: Agent<RevisionInput, WritingOutput> = {
  name: "article-revision",
  version: 4,
  inputSchema: RevisionInput,
  outputSchema: WritingOutput,

  async run(input, ctx: AgentContext): Promise<AgentResult<WritingOutput>> {
    const business = businessBlock(input);

    const prompt = `You are an editor revising an article before it is published. A check found the problems listed below. Rewrite the article so that every one of them is gone, and change nothing that is not needed for that: keep the structure, the points and the wording that already work.

Target keyword: ${input.keyword}
${business ? `\n${business}\n` : ""}
${evidenceBlock(input.evidence)}

Problems to fix, all of them:
${input.problems.map((problem, index) => `${index + 1}. ${problem}`).join("\n")}

How to fix them:
- A figure with no source: delete it, or say the same thing in words without the number. Do not replace it with another figure.
- A figure from About you, which is not for the public blog: delete it and the claim it carries. Do not replace it with another figure or with a vaguer version of the same result.
- A link to a wrong address for the business: use the real website or remove the link.
- A stock phrase: rewrite the sentence so it says something specific, or delete it.
- Too long: cut the weakest sections and the repetition, not the answers.
- A title that promises what the body lacks: change the title to what the body delivers, unless delivering it takes only a table or a list built from the evidence.
- No short version, or a long one: write it, or cut it to the answer, as the rules below say.
- Headings that are not questions: rephrase them as the questions their sections answer, and open each section with the answer. The sections themselves stay.
- A figure in the data section that the owner did not give, or a weak early one: delete it; with no figure left, delete the section.
- A first-hand figure from the owner's facts above is not a figure with no source: keep it, and attribute it in the same sentence with whose it is and its period, from the owner's wording.

${productRule(input)}

${writingRules(input)}
- Output the whole revised article, starting directly with the <h1>. Output nothing before it and nothing after it: no list of changes, no notes.

The draft:
${input.draftHtml}`;

    const llm = getLlmProvider("writer", ctx.llmArm);
    const { text, usage } = await llm.generateText(prompt, {
      ...WRITER_OPTIONS,
      temperature: 0.4,
      signal: ctx.signal,
    });

    return { output: { html: text.trim(), ...served(usage) }, usage: [usage] };
  },
};
