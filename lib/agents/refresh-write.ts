import { z } from "zod";
import { getLlmProvider } from "@/lib/providers/llm/registry";
import { Agent, AgentContext, AgentResult } from "./contract";

/**
 * Refresh-write agent — applies a plan to an existing article.
 *
 * It returns the COMPLETE updated document, not a diff: the content pipeline
 * validates whole documents, and asking a model to emit a patch format is a
 * second parser to get wrong. Everything the plan does not mention must come
 * back unchanged — the refresh guard checks that it did.
 */

export const RefreshWriteInput = z.object({
  keyword: z.string().min(1),
  language: z.string().min(2),
  title: z.string().min(1),
  /** The current article as a full HTML document (h1 + body). */
  currentHtml: z.string().min(1),
  revisions: z.array(z.object({ heading: z.string(), instruction: z.string() })).default([]),
  additions: z
    .array(z.object({ afterHeading: z.string().nullable(), heading: z.string(), angle: z.string() }))
    .default([]),
});
export type RefreshWriteInput = z.infer<typeof RefreshWriteInput>;

export const RefreshWriteOutput = z.object({ html: z.string().min(1) });
export type RefreshWriteOutput = z.infer<typeof RefreshWriteOutput>;

export const refreshWriteAgent: Agent<RefreshWriteInput, RefreshWriteOutput> = {
  name: "refresh-write",
  version: 1,
  inputSchema: RefreshWriteInput,
  outputSchema: RefreshWriteOutput,

  async run(input, ctx: AgentContext): Promise<AgentResult<RefreshWriteOutput>> {
    const revisions = input.revisions
      .map((r) => `- Section "${r.heading}": ${r.instruction}`)
      .join("\n");
    const additions = input.additions
      .map(
        (a) =>
          `- New section "${a.heading}"${a.afterHeading ? ` after "${a.afterHeading}"` : " at the end"}: ${a.angle}`
      )
      .join("\n");

    const prompt = `You are updating an existing published article. Return the COMPLETE updated article, not a summary of changes.

Target keyword: ${input.keyword}
Language: ${input.language}

Current article:
${input.currentHtml}

${revisions ? `Changes to make:\n${revisions}\n` : ""}${additions ? `Sections to add:\n${additions}\n` : ""}
Rules:
- Output the ENTIRE article as HTML, starting with the <h1> title.
- Everything the instructions do not mention must come back WORD FOR WORD as it is now. Do not re-word, re-order, shorten or "improve" untouched sections.
- Keep every existing section unless an instruction says otherwise; you may add, never delete.
- Each section must still open by answering its own question in the first sentences, and still make sense read on its own.
- Use only <h1>, <h2>, <h3>, <p>, <ul>, <ol>, <li>, <strong>, <em>, <a>, <blockquote>, <table> markup. No Markdown, no code fences, no commentary before or after the article.
- Never invent statistics, prices, dates or sources.

Write in ${input.language}.`;

    const llm = getLlmProvider();
    const { text, usage } = await llm.generateText(prompt, {
      tier: "quality",
      temperature: 0.4,
      signal: ctx.signal,
    });

    return { output: { html: text }, usage: [usage] };
  },
};
