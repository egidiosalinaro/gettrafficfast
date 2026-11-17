import { z } from "zod";
import { DEFAULT_ANSWERS_LIMIT, MAX_ANSWERS_LIMIT, listAiAnswers, loadGrowth } from "@/lib/growth/read";
import { AiAnswersPage, GrowthSummary } from "@/lib/growth/schema";
import { isXApiEnabled } from "@/lib/providers/x/api";
import { defineTool } from "./tool";

/**
 * Growth (`/growth`, `/growth/ai`) as tools: the period's three blocks
 * (`get_growth`) and the AI answers behind the count (`list_ai_answers`),
 * through lib/growth/read.ts, the functions the screen's routes call.
 * Stored rows only, free: no engine, Google or X is asked.
 *
 * The rule for measurements holds in the output: a number nobody measured
 * is null, never 0; AI asks are counted per engine, never averaged across
 * engines, and marked as sampled.
 */

const Days = z
  .union([z.literal(7), z.literal(28)])
  .default(7)
  .describe("The period: the last 7 days (default) or 28, compared with the same length just before.");

export const getGrowth = defineTool({
  name: "get_growth",
  title: "Get growth",
  description:
    "Growth, as the /growth screen shows it: the last 7 (or 28) days against the same length before, in three blocks. `replies`: replies posted on X with X's views, likes, replies and reposts summed over the measured ones, coverage, the 3 most viewed, and the site's followers with their change (as get_reply_stats). `google`: Search Console impressions, clicks and impression-weighted average position over the period ending on the newest day Google has settled, each with its change (null when the data does not cover the period before), and pages on Google from URL Inspection (latest answer per URL, no history). `ai`: per engine, how many asks got a readable answer and how many cited the site, this period and the one before, split into the questions you chose (prompts) and your articles' keywords (articles); never averaged across engines; sampled. A null is not measured, never 0.",
  input: z.object({ days: Days }),
  output: GrowthSummary,
  scope: "read",
  paid: false,
  async handler(ctx, input) {
    return loadGrowth(ctx.client, ctx.businessId, { days: input.days, xApiEnabled: isXApiEnabled() });
  },
});

export const listAiAnswersTool = defineTool({
  name: "list_ai_answers",
  title: "List AI answers",
  description:
    "The answers behind Growth's AI count (/growth/ai), newest first, in the last 7 (or 28) days: each ask's question, engine, day, whether it cited the site (`status`; `counted` is false for an ask with no readable answer, which is not 'not cited'), the site's place among the sources, the cited page, the stored start of the answer (an excerpt, not the whole answer), and every source the engine returned, verbatim and numbered, with the site's own marked `ours` and the open places to reply in Today marked `inToday`. `kind`: `prompt` for the questions you chose (every source kept), `article` for the weekly check of an article's keyword (only the verdict, and the cited page when cited: `sourcesKept` false). Filter by `engine`; page with `offset` and `limit`. Sampled: one question asked once, not every AI answer.",
  input: z.object({
    days: Days,
    engine: z.string().trim().min(1).max(40).optional().describe("Only this engine, as stored: gemini, perplexity."),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(MAX_ANSWERS_LIMIT).default(DEFAULT_ANSWERS_LIMIT),
  }),
  output: AiAnswersPage,
  scope: "read",
  paid: false,
  async handler(ctx, input) {
    return listAiAnswers(ctx.client, ctx.businessId, {
      days: input.days,
      engine: input.engine ?? null,
      offset: input.offset,
      limit: input.limit,
    });
  },
});

export const GROWTH_READ_TOOLS = [getGrowth, listAiAnswersTool] as const;
