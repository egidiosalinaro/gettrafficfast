import { z } from "zod";
import { clampText } from "@/lib/content/text";
import { getLlmProvider } from "@/lib/providers/llm/registry";
import { Agent, AgentContext, AgentResult } from "./contract";

/**
 * Refresh-plan agent — decides whether a decaying article is worth rewriting,
 * and if so, exactly what to change.
 *
 * Decay detection says the numbers moved; this agent says whether there is
 * anything to DO about it. An article can lose ground for reasons a rewrite
 * cannot fix, and rewriting it anyway costs money and risks a working page —
 * so "leave" is a first-class outcome and the default when in doubt.
 */

export const RefreshPlanInput = z.object({
  keyword: z.string().min(1),
  language: z.string().min(2),
  title: z.string().min(1),
  headings: z.array(z.object({ id: z.string(), level: z.number(), text: z.string() })),
  bodyText: z.string().min(1),
  /** What decay detection observed, in words. */
  decayDetail: z.string().min(1),
  /** What outranks the article today. */
  competitors: z
    .array(
      z.object({
        position: z.number(),
        title: z.string(),
        domain: z.string(),
        snippet: z.string(),
      })
    )
    .default([]),
  /** Questions searchers ask that the article may not answer. */
  questions: z.array(z.string()).default([]),
});
export type RefreshPlanInput = z.infer<typeof RefreshPlanInput>;

export const RefreshPlanOutput = z.object({
  verdict: z.enum(["refresh", "leave"]),
  reason: z.string().min(1),
  /** Section-level edits, each against a real heading id. */
  revisions: z
    .array(z.object({ headingId: z.string().min(1), instruction: z.string().min(1) }))
    .max(6)
    .default([]),
  /** Sections the article is missing; null placement means "at the end". */
  additions: z
    .array(
      z.object({
        afterHeadingId: z.string().nullable().default(null),
        heading: z.string().min(1),
        angle: z.string().min(1),
      })
    )
    .max(3)
    .default([]),
  metaDescription: z.string().max(160).nullable().default(null),
});
export type RefreshPlanOutput = z.infer<typeof RefreshPlanOutput>;

/** Model-facing: no counts, no closed verdict — normalised at the boundary. */
const LlmRefreshPlanOutput = z.object({
  verdict: z.string().min(1),
  reason: z.string().min(1),
  revisions: z
    .array(z.object({ headingId: z.string().min(1), instruction: z.string().min(1) }))
    .default([]),
  additions: z
    .array(
      z.object({
        afterHeadingId: z.string().nullable().default(null),
        heading: z.string().min(1),
        angle: z.string().min(1),
      })
    )
    .default([]),
  metaDescription: z.string().nullable().default(null),
});

export const refreshPlanAgent: Agent<RefreshPlanInput, RefreshPlanOutput> = {
  name: "refresh-plan",
  version: 1,
  inputSchema: RefreshPlanInput,
  outputSchema: RefreshPlanOutput,

  async run(input, ctx: AgentContext): Promise<AgentResult<RefreshPlanOutput>> {
    const outline = input.headings
      .map((h) => `- [${h.id}] ${"#".repeat(h.level)} ${h.text}`)
      .join("\n");
    const rivals = input.competitors
      .slice(0, 8)
      .map((c) => `${c.position}. [${c.domain}] ${c.title}\n   ${c.snippet.slice(0, 200)}`)
      .join("\n");

    const prompt = `A published article is losing ground. Decide whether rewriting it would actually help, and if so, what to change.

Target keyword: ${input.keyword}
Article title: ${input.title}
What we measured: ${input.decayDetail}

Article sections (each line is [headingId] level text):
${outline}

Article text:
${input.bodyText.slice(0, 10000)}
${rivals ? `\nWhat ranks above it today:\n${rivals}` : ""}
${input.questions.length > 0 ? `\nQuestions searchers ask:\n${input.questions.map((q) => `- ${q}`).join("\n")}` : ""}

Judge honestly:
- verdict "leave" if the article is already the better answer and lost ground for reasons a rewrite cannot fix (a stronger domain outranking it, a SERP that changed shape, seasonality). Say so plainly — leaving a good article alone is a correct outcome, not a failure.
- verdict "refresh" only when there is something concrete to fix: outdated facts, questions it fails to answer, sections that bury the answer, coverage the winning results have and it lacks.

If refreshing:
- revisions: one instruction per section that needs work, using the exact headingId. Say what to change and why — not "improve this".
- additions: sections the article is genuinely missing; afterHeadingId places each one, or null to append at the end.
- metaDescription: a replacement only if the current one no longer matches what the article delivers, otherwise null.
- Never propose deleting sections, and never propose changing what the article is about.

Write reason, instructions, headings and angles in ${input.language}.`;

    const llm = getLlmProvider();
    const { value, usage } = await llm.generateStructured(prompt, LlmRefreshPlanOutput, {
      tier: "fast",
      temperature: 0.2,
      signal: ctx.signal,
    });

    // Boundary: anything unclear becomes "leave". A garbled verdict must never
    // be read as permission to rewrite a working article, and an instruction
    // against a section that does not exist cannot be carried out.
    const headingIds = new Set(input.headings.map((h) => h.id));
    const verdict = value.verdict.trim().toLowerCase() === "refresh" ? "refresh" : "leave";
    const revisions = value.revisions
      .filter((r) => headingIds.has(r.headingId))
      .slice(0, 6);
    const additions = value.additions
      .map((a) => ({
        ...a,
        afterHeadingId:
          a.afterHeadingId && headingIds.has(a.afterHeadingId) ? a.afterHeadingId : null,
      }))
      .slice(0, 3);

    return {
      output: {
        // Nothing concrete to do is the same as "leave", whatever was claimed.
        verdict: verdict === "refresh" && revisions.length + additions.length === 0
          ? "leave"
          : verdict,
        reason: value.reason,
        revisions,
        additions,
        metaDescription: value.metaDescription
          ? clampText(value.metaDescription, 160)
          : null,
      },
      usage: [usage],
    };
  },
};
