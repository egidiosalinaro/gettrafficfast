import { z } from "zod";
import { clampText } from "@/lib/content/text";
import { getLlmProvider } from "@/lib/providers/llm/registry";
import { Agent, AgentContext, AgentResult } from "./contract";
import { AEO_INTENTS } from "@/lib/visibility/settings";
import { MAX_QUERY_LENGTH } from "@/lib/visibility/queries";

/**
 * Propose the questions a buyer would type into an answer engine.
 *
 * Import-from-keywords copies the keyword list verbatim, which is why a first
 * run is full of "AEO vs SEO" and "content calendar automation". Those measure
 * the category, not the business. This agent writes the other kind of prompt:
 * how a founder would ask when choosing a tool. It returns data. Persistence
 * and the owner's yes/no live in the API and the settings screen.
 */

export const MIN_SUGGESTED_PROMPTS = 8;
export const MAX_SUGGESTED_PROMPTS = 12;

export const ProposePromptInput = z.object({
  business: z.object({
    name: z.string().min(1),
    niche: z.string().nullable(),
    description: z.string().nullable(),
    domain: z.string().nullable(),
  }),
  language: z.string().min(2),
  /** Wordings already in the set, so the model does not rephrase them. */
  existing: z.array(z.string()).max(80).default([]),
  /** Keywords the business already tracks, as expertise, not as output. */
  keywords: z.array(z.string()).max(20).default([]),
  /** Competitors the business already listed. Never invent names beyond this. */
  competitors: z
    .array(z.object({ name: z.string().nullable(), domain: z.string() }))
    .max(20)
    .default([]),
});
export type ProposePromptInput = z.infer<typeof ProposePromptInput>;

export const ProposedPrompt = z.object({
  query: z.string().min(3).max(MAX_QUERY_LENGTH),
  cluster: z.string().max(60).nullable(),
  intent: z.enum(AEO_INTENTS),
  /** One sentence for the owner: why this question is worth asking. */
  why: z.string().min(1).max(220),
});
export type ProposedPrompt = z.infer<typeof ProposedPrompt>;

export const ProposePromptOutput = z.object({
  prompts: z.array(ProposedPrompt).max(MAX_SUGGESTED_PROMPTS),
});
export type ProposePromptOutput = z.infer<typeof ProposePromptOutput>;

const LlmProposeOutput = z.object({
  prompts: z.array(
    z.object({
      query: z.string().min(1),
      cluster: z.string().nullable().optional(),
      intent: z.string(),
      why: z.string().min(1),
    })
  ),
});

export const proposePromptsAgent: Agent<ProposePromptInput, ProposePromptOutput> = {
  name: "propose-prompts",
  version: 1,
  inputSchema: ProposePromptInput,
  outputSchema: ProposePromptOutput,

  async run(input, ctx: AgentContext): Promise<AgentResult<ProposePromptOutput>> {
    const business = [
      `Name: ${input.business.name}`,
      input.business.domain ? `Site: ${input.business.domain}` : null,
      input.business.niche ? `Niche: ${input.business.niche}` : null,
      input.business.description ? `What they do: ${input.business.description}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    const existing =
      input.existing.length > 0
        ? input.existing.map((q) => `- ${q}`).join("\n")
        : "(none yet)";
    const keywords =
      input.keywords.length > 0 ? input.keywords.join(", ") : "(none listed)";
    const competitors =
      input.competitors.length > 0
        ? input.competitors
            .map((c) => (c.name ? `${c.name} (${c.domain})` : c.domain))
            .join(", ")
        : "(none listed — do not invent brand names)";

    const prompt = `You write the prompts a founder would type into Gemini, ChatGPT or Perplexity when they are looking for a product like this one.

The business:
${business}

Topics they already track as keywords (expertise only — do not copy these as prompts):
${keywords}

Competitors they already listed:
${competitors}

Prompts already in their set (do not repeat or lightly rephrase):
${existing}

Write ${MIN_SUGGESTED_PROMPTS} to ${MAX_SUGGESTED_PROMPTS} prompts. Rules:
- Phrase them as a person would type them, not as SEO keywords. "how do I get my site cited by ChatGPT" is a prompt. "ChatGPT citation optimization" is a keyword. Prefer the first.
- They must be commercial enough that a citation would mean a buyer found this business. Drop category definitions ("what is SEO", "AEO vs SEO", "organic traffic from AI search").
- Mix intents: commercial ("best … for …"), comparison ("X vs Y" only using competitors listed above, or generic "X vs doing it by hand" if the list is empty), informational how-to ("how do I …"). At most two navigational prompts that use the business's own name.
- Never invent a competitor brand. If the competitor list is empty, do not name one.
- Do not start every prompt with the business's own name.
- Each prompt is a single line, no numbering, no quotes.

For each prompt return:
- query: the wording, in ${input.language}
- cluster: two or three words grouping it (e.g. "AI citations", "publishing"). Null if nothing fits.
- intent: one of ${AEO_INTENTS.join(", ")}
- why: one sentence to the owner, in ${input.language}, explaining why this question is worth measuring.

Write query, cluster and why in ${input.language}.`;

    const llm = getLlmProvider();
    const { value, usage } = await llm.generateStructured(prompt, LlmProposeOutput, {
      tier: "fast",
      temperature: 0.4,
      signal: ctx.signal,
    });

    const prompts: ProposedPrompt[] = [];
    for (const item of value.prompts) {
      const intent = item.intent.trim().toLowerCase();
      if (!(AEO_INTENTS as readonly string[]).includes(intent)) continue;
      const query = clampText(item.query, MAX_QUERY_LENGTH);
      if (query.length < 3) continue;
      prompts.push({
        query,
        cluster: item.cluster?.trim() ? clampText(item.cluster.trim(), 60) : null,
        intent: intent as (typeof AEO_INTENTS)[number],
        why: clampText(item.why, 220),
      });
      if (prompts.length >= MAX_SUGGESTED_PROMPTS) break;
    }

    return {
      output: { prompts },
      usage: [usage],
    };
  },
};
