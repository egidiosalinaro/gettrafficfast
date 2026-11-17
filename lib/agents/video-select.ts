import { z } from "zod";
import { getLlmProvider } from "@/lib/providers/llm/registry";
import { Agent, AgentContext, AgentResult } from "./contract";

/**
 * Video-select agent — the relevance judgement, and only that.
 *
 * The application searches the provider and hands over candidates; this agent
 * decides whether any of them genuinely serves a section of the article. An
 * irrelevant embed hurts both the reader and SEO, so the default answer is
 * "none": selecting nothing is success, not failure.
 */

export const VideoSelectInput = z.object({
  keyword: z.string().min(1),
  language: z.string().min(2),
  title: z.string().min(1),
  headings: z.array(z.object({ id: z.string(), level: z.number(), text: z.string() })),
  candidates: z
    .array(
      z.object({
        videoId: z.string().min(1),
        title: z.string(),
        channel: z.string(),
        description: z.string(),
        publishedAt: z.string(),
      })
    )
    .min(1),
  maxSelections: z.number().int().min(1).max(2).default(1),
});
export type VideoSelectInput = z.infer<typeof VideoSelectInput>;

export const VideoSelectOutput = z.object({
  selections: z
    .array(
      z.object({
        videoId: z.string().min(1),
        /** Heading id of the section the video belongs under. */
        headingId: z.string().min(1),
        /** Why this video helps THIS section's reader. */
        reason: z.string().min(10),
        /** 0-1; the workflow only embeds above a threshold. */
        confidence: z.number().min(0).max(1),
      })
    )
    .max(2)
    .default([]),
});
export type VideoSelectOutput = z.infer<typeof VideoSelectOutput>;

/** Model-facing: no count/range caps — enforced deterministically below. */
const LlmVideoSelectOutput = z.object({
  selections: z
    .array(
      z.object({
        videoId: z.string().min(1),
        headingId: z.string().min(1),
        reason: z.string().min(10),
        confidence: z.number(),
      })
    )
    .default([]),
});

/** Below this the workflow does not embed, whatever the agent picked. */
export const VIDEO_CONFIDENCE_THRESHOLD = 0.7;

export const videoSelectAgent: Agent<VideoSelectInput, VideoSelectOutput> = {
  name: "video-select",
  version: 1,
  inputSchema: VideoSelectInput,
  outputSchema: VideoSelectOutput,

  async run(input, ctx: AgentContext): Promise<AgentResult<VideoSelectOutput>> {
    const outline = input.headings
      .map((h) => `- [${h.id}] ${h.text}`)
      .join("\n");
    const list = input.candidates
      .map(
        (c, i) =>
          `${i + 1}. videoId: ${c.videoId}
   title: ${c.title}
   channel: ${c.channel}
   published: ${c.publishedAt}
   description: ${c.description.slice(0, 200)}`
      )
      .join("\n");

    const prompt = `An article is being published and MAY include a YouTube video — only if one genuinely helps its readers.

Article: ${input.title}
Target keyword: ${input.keyword}
Sections (each line is [headingId] text):
${outline}

Candidate videos:
${list}

Select AT MOST ${input.maxSelections} video(s). The bar is high:
- The video must add something the article's text cannot (a demonstration, a walkthrough, footage).
- It must match a SPECIFIC section — assign the headingId it belongs under.
- Tangential, promotional, clickbait or outdated videos are rejections.
- If no candidate clears the bar, return an empty selections list. That is the expected outcome most of the time, and it is a good outcome.

confidence is your honest probability (0-1) that a reader of that section would thank you for the embed. Write reason in ${input.language}.`;

    const llm = getLlmProvider(undefined, ctx.llmArm);
    const { value, usage } = await llm.generateStructured(prompt, LlmVideoSelectOutput, {
      tier: "fast",
      temperature: 0.2,
      signal: ctx.signal,
    });

    // Discard hallucinated ids/slots at the boundary: a selection that does
    // not reference a real candidate and a real section never leaves the agent.
    // Counts and ranges are enforced here too — never asked of the model.
    const candidateIds = new Set(input.candidates.map((c) => c.videoId));
    const headingIds = new Set(input.headings.map((h) => h.id));
    const selections = value.selections
      .filter((s) => candidateIds.has(s.videoId) && headingIds.has(s.headingId))
      .map((s) => ({ ...s, confidence: Math.max(0, Math.min(1, s.confidence)) }))
      .slice(0, input.maxSelections);

    return { output: { selections }, usage: [usage] };
  },
};
