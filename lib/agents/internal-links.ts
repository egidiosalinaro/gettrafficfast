import { z } from "zod";
import { getLlmProvider } from "@/lib/providers/llm/registry";
import { Agent, AgentContext, AgentResult } from "./contract";

/**
 * Internal-links agent — the judgement of WHERE a link belongs, and only that.
 *
 * The application already knows WHICH articles are related (the knowledge
 * graph says so); this agent picks the anchor text inside the new article for
 * each worthwhile target. The anchor must be an EXACT verbatim span of the
 * article text: the linking module verifies it character-for-character against
 * a single text node and silently drops anything that does not match, so a
 * hallucinated anchor can never alter the article. As with videos: linking to
 * nothing is success, not failure.
 */

/** In-body links one article may get. */
export const MAX_IN_BODY_LINKS = 8;

export const InternalLinksInput = z.object({
  language: z.string().min(2),
  sourceTitle: z.string().min(1),
  /** Body text of the article being produced, tags stripped. */
  sourceBodyText: z.string().min(1),
  /** Published articles the graph found related — the only allowed targets. */
  targets: z
    .array(
      z.object({
        articleId: z.string().min(1),
        title: z.string().min(1),
        keyword: z.string(),
        excerpt: z.string(),
      })
    )
    .min(1),
  /**
   * Up to 8 since 2026-11-15: with the Read next block (3) that makes the 6
   * to 12 internal links an article has when the site has enough published
   * articles. One call either way: the count costs nothing.
   */
  maxLinks: z.number().int().min(1).max(MAX_IN_BODY_LINKS).default(3),
});
export type InternalLinksInput = z.infer<typeof InternalLinksInput>;

export const InternalLinksOutput = z.object({
  links: z
    .array(
      z.object({
        targetArticleId: z.string().min(1),
        /** Exact span of sourceBodyText to wrap in the link. */
        anchor: z.string().min(3),
        /** Why a reader at this point is served by the target. */
        reason: z.string().min(1),
      })
    )
    .max(MAX_IN_BODY_LINKS)
    .default([]),
});
export type InternalLinksOutput = z.infer<typeof InternalLinksOutput>;

/** Model-facing: no count caps — enforced deterministically below. */
const LlmInternalLinksOutput = z.object({
  links: z
    .array(
      z.object({
        targetArticleId: z.string().min(1),
        anchor: z.string().min(3),
        reason: z.string().min(1),
      })
    )
    .default([]),
});

export const internalLinksAgent: Agent<InternalLinksInput, InternalLinksOutput> = {
  name: "internal-links",
  version: 2,
  inputSchema: InternalLinksInput,
  outputSchema: InternalLinksOutput,

  async run(input, ctx: AgentContext): Promise<AgentResult<InternalLinksOutput>> {
    const list = input.targets
      .map(
        (t, i) =>
          `${i + 1}. articleId: ${t.articleId}
   title: ${t.title}
   keyword: ${t.keyword}
   excerpt: ${t.excerpt.slice(0, 300)}`
      )
      .join("\n");

    const prompt = `A new article is being published on a site that already has related articles. Decide whether the new article should link to any of them, and with what anchor text.

New article: ${input.sourceTitle}

New article text:
${input.sourceBodyText.slice(0, 12000)}

Already-published articles (the only allowed targets):
${list}

Select AT MOST ${input.maxLinks} link(s)${
      input.maxLinks >= 3
        ? `, and aim for ${Math.min(input.maxLinks, input.targets.length)} when the targets genuinely fit: a reader who wants to go deeper on a point should find the link right there. Spread them through the article, never two in one sentence`
        : ""
    }. The rules:
- The anchor MUST be an exact span copied character-for-character from the new article text above — same casing, same accents, same punctuation. If you cannot find a natural existing phrase for a target, do not link to it. The system verifies the span and silently drops anything that is not verbatim.
- Pick a phrase of roughly 2 to 8 words that names what the target article covers — the phrase a reader would want to click to learn more. Never link filler like "click here" or a whole sentence.
- Never use a heading as the anchor.
- One link per target at most, and only where the target genuinely deepens what the surrounding passage discusses.
- If no target fits naturally, return an empty list. That is a good outcome, not a failure.

Write reason in ${input.language}.`;

    const llm = getLlmProvider(undefined, ctx.llmArm);
    const { value, usage } = await llm.generateStructured(prompt, LlmInternalLinksOutput, {
      tier: "fast",
      temperature: 0.2,
      signal: ctx.signal,
    });

    // Boundary: a link must point at a real offered target, one link per
    // target, and the count cap is code's job. Anchor *content* is verified
    // later by the linking module against the actual HTML.
    const allowed = new Set(input.targets.map((t) => t.articleId));
    const taken = new Set<string>();
    const links = value.links
      .map((l) => ({ ...l, anchor: l.anchor.trim() }))
      .filter((l) => {
        if (l.anchor.length < 3) return false;
        if (!allowed.has(l.targetArticleId)) return false;
        if (taken.has(l.targetArticleId)) return false;
        taken.add(l.targetArticleId);
        return true;
      })
      .slice(0, input.maxLinks);

    return { output: { links }, usage: [usage] };
  },
};
