import { z } from "zod";
import { getLlmProvider } from "@/lib/providers/llm/registry";
import { Agent, AgentContext, AgentResult } from "./contract";

/**
 * Push-page agent (Push page 3, docs/LIFECYCLE.md): ONE call per pushed
 * article, on the fast tier, that proposes
 *
 * - a tighter meta title and meta description for the article, holding the
 *   search Google shows it for (its main query), with the same promise;
 * - for each of the site's best pages chosen by code, where a link to the
 *   article fits: an exact phrase the page already writes, or one short
 *   sentence to add at the end of one of its numbered paragraphs.
 *
 * It decides nothing that matters on its own: which article, which query
 * and which pages are code's (lib/lifecycle/push.ts); every title is checked
 * for length, the query and invented figures, and every link is verified
 * against the page's tree (lib/knowledge/push-links.ts). A suggestion that
 * fails is dropped and the page is left as it was.
 */

export const PushPageInput = z.object({
  language: z.string().min(2),
  mainQuery: z.string().min(1),
  target: z.object({
    title: z.string().min(1),
    metaTitle: z.string().nullable(),
    metaDescription: z.string().nullable(),
    /** The article's text, tags stripped, for the promise it makes. */
    bodyText: z.string(),
  }),
  sources: z
    .array(
      z.object({
        articleId: z.string().min(1),
        title: z.string().min(1),
        /** The paragraphs a sentence may be added to, numbered from 1. */
        paragraphs: z.array(z.object({ index: z.number().int().min(1), text: z.string() })),
      })
    )
    .max(3),
});
export type PushPageInput = z.infer<typeof PushPageInput>;

const Link = z.object({
  sourceArticleId: z.string().min(1),
  mode: z.enum(["existing", "sentence"]),
  anchor: z.string().min(2),
  paragraph: z.number().int().min(1).nullable().default(null),
  sentence: z.string().nullable().default(null),
});

export const PushPageOutput = z.object({
  metaTitle: z.string().nullable(),
  metaDescription: z.string().nullable(),
  links: z.array(Link).max(3).default([]),
});
export type PushPageOutput = z.infer<typeof PushPageOutput>;

/** Model-facing: lenient on counts and nulls, tightened below. */
const LlmPushPageOutput = z.object({
  metaTitle: z.string().nullable().optional(),
  metaDescription: z.string().nullable().optional(),
  links: z
    .array(
      z.object({
        sourceArticleId: z.string(),
        mode: z.string(),
        anchor: z.string(),
        paragraph: z.number().nullable().optional(),
        sentence: z.string().nullable().optional(),
      })
    )
    .default([]),
});

export const pushPageAgent: Agent<PushPageInput, PushPageOutput> = {
  name: "push-page",
  version: 1,
  inputSchema: PushPageInput,
  outputSchema: PushPageOutput,

  async run(input, ctx: AgentContext): Promise<AgentResult<PushPageOutput>> {
    const sources = input.sources
      .map(
        (source) => `### Page ${source.articleId}: ${source.title}
${source.paragraphs.map((p) => `[${p.index}] ${p.text}`).join("\n")}`
      )
      .join("\n\n");

    const prompt = `An article on this site sits on Google's pages 2 to 4 for the search "${input.mainQuery}". Two changes help it move: a search-result title that matches that search, and links to it from the site's strongest pages.

The article: ${input.target.title}
Current search-result title: ${input.target.metaTitle ?? "(none: the headline is used)"}
Current description: ${input.target.metaDescription ?? "(none)"}
Article text:
${input.target.bodyText.slice(0, 6000)}

1. Write metaTitle: at most 60 characters, containing "${input.mainQuery}" exactly (any letter case), saying what the article delivers. The same promise as the article: no claim, figure or benefit the text above does not support, no clickbait, no exclamation mark.
2. Write metaDescription: 70 to 155 characters, containing "${input.mainQuery}", one or two plain sentences of what a reader gets.
3. For each page below (one link per page at most), place one link to the article:
   - mode "existing": anchor is a phrase of 2 to 8 words copied character for character from one paragraph, that says "${input.mainQuery}" or a natural variant of it. Preferred when such a phrase exists.
   - mode "sentence": when no phrase fits, one short sentence (under 30 words, plain text, no address) to add at the END of paragraph number "paragraph", that follows naturally from it and contains anchor, a natural variant of "${input.mainQuery}", once. No "related", "read more" or "click here".
   - If a link would not fit a page naturally, leave that page out.

Pages:
${sources}

Write everything in ${input.language}. Return JSON: {"metaTitle": string, "metaDescription": string, "links": [{"sourceArticleId", "mode", "anchor", "paragraph", "sentence"}]}.`;

    const llm = getLlmProvider(undefined, ctx.llmArm);
    const { value, usage } = await llm.generateStructured(prompt, LlmPushPageOutput, {
      tier: "fast",
      temperature: 0.2,
      signal: ctx.signal,
    });

    // Boundary: only offered pages, one link each, known modes. Content is
    // verified later against the real tree and the title rules.
    const allowed = new Set(input.sources.map((s) => s.articleId));
    const taken = new Set<string>();
    const links: PushPageOutput["links"] = [];
    for (const link of value.links) {
      if (!allowed.has(link.sourceArticleId) || taken.has(link.sourceArticleId)) continue;
      if (link.mode !== "existing" && link.mode !== "sentence") continue;
      const anchor = link.anchor.trim();
      if (anchor.length < 2) continue;
      if (link.mode === "sentence" && (!link.sentence?.trim() || !link.paragraph)) continue;
      taken.add(link.sourceArticleId);
      links.push({
        sourceArticleId: link.sourceArticleId,
        mode: link.mode,
        anchor,
        paragraph: link.mode === "sentence" ? Math.floor(link.paragraph ?? 0) || null : null,
        sentence: link.mode === "sentence" ? (link.sentence ?? "").trim() : null,
      });
    }

    return {
      output: {
        metaTitle: value.metaTitle?.trim() || null,
        metaDescription: value.metaDescription?.trim() || null,
        links: links.slice(0, 3),
      },
      usage: [usage],
    };
  },
};
