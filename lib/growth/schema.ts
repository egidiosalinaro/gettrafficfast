import { z } from "zod";
import { ReplyStats } from "@/lib/placements/reply-stats";

/**
 * The shapes Growth answers in: what GET /api/growth and `get_growth` return
 * (the three blocks), and what GET /api/growth/answers and `list_ai_answers`
 * return (the evidence). One schema, so the screen and the tools cannot say
 * a number two ways. Numbers are numbers and a measurement nobody made is
 * null, never 0.
 */

const Count = z.number().nullable();

export const DayWindowView = z.object({
  from: z.string().describe("First UTC day, inclusive (YYYY-MM-DD)."),
  to: z.string().describe("Last UTC day, inclusive."),
});

const SearchTotalsView = DayWindowView.extend({
  impressions: z.number().describe("Google's count over the window. 0 is a real zero: the data covers the window."),
  clicks: z.number(),
  averagePosition: Count.describe("Impression-weighted average position, one decimal; null with no impression."),
});

export const IndexPages = z.object({
  total: z.number().describe("The site's published URLs inside the Search Console property."),
  checked: z.number().describe("Of those, the ones Google's URL Inspection has answered for."),
  indexed: z.number().describe("Checked and on Google."),
  notIndexed: z.number(),
  unknown: z.number(),
  caption: z.string().nullable(),
  notIndexedRows: z
    .array(
      z.object({
        url: z.string(),
        coverageState: z.string().nullable().describe("Google's reason, in its words."),
        checkedAt: z.string(),
        inspectionResultLink: z.string().nullable(),
      })
    )
    .describe("The checked URLs Google does not have, at most 20, newest check first."),
});

export const GoogleGrowth = z.object({
  connection: z.object({
    status: z.enum(["absent", "connected", "error"]),
    siteUrl: z.string().nullable(),
    lastSyncedOn: z.string().nullable().describe("The newest day fetched from Search Console."),
    stale: z.boolean(),
    syncing: z.boolean(),
    lastError: z.string().nullable(),
  }),
  settledThrough: z
    .string()
    .nullable()
    .describe("The newest day with data; the current window ends on it (Google settles its last days over about three). Null when nothing was ever ingested."),
  coveredFrom: z.string().nullable().describe("The first day the ingested data covers."),
  current: SearchTotalsView.nullable().describe("The period. Null when nothing was ingested: not connected or no data yet, never 0."),
  previous: SearchTotalsView.nullable().describe("The same length just before. Null when the data does not cover it yet: no comparison, not a zero."),
  change: z.object({
    impressions: Count,
    clicks: Count,
    averagePosition: Count.describe("previous minus current, one decimal: positive moved up the page."),
  }),
  pages: IndexPages.nullable().describe("Pages on Google, from URL Inspection: the latest answer per URL, no history kept, so no change. Null when not connected or unreadable."),
});
export type GoogleGrowth = z.infer<typeof GoogleGrowth>;

const AskCountView = z.object({
  asks: z.number().describe("Readable answers in the window: the denominator."),
  cited: z.number(),
  rate: Count.describe("cited / asks; null with no ask (not asked, never 0)."),
});

export const EngineAsksView = z.object({
  engine: z.string(),
  current: AskCountView,
  previous: AskCountView,
  byKind: z
    .object({ prompts: AskCountView, articles: AskCountView })
    .describe("The current window split by family: the questions you chose (prompts) and your articles' keywords (articles)."),
  unreadable: z.number().describe("Prompt asks in the current window with no readable answer or a failed call: not counted, and not 'not cited'."),
});

export const AiGrowth = z.object({
  window: z.object({ current: DayWindowView, previous: DayWindowView }),
  engines: z.array(EngineAsksView).describe("One row per engine, never averaged across engines."),
  lastAskedAt: z.string().nullable().describe("The newest ask ever stored, of either family; null when the site was never asked about."),
  prompts: z.object({ total: z.number(), enabled: z.number() }).describe("The questions you chose (Growth → AI answers → Questions we ask)."),
  places: z
    .object({ open: z.number() })
    .nullable()
    .describe("Open places to reply in Today that a sampled answer cited; null when it could not be read."),
  placesFromSources: z.boolean().describe("Each visibility run sends the pages its answers cited to Today (the site's setting, on by default)."),
  sampled: z.literal(true),
  note: z.string(),
});
export type AiGrowth = z.infer<typeof AiGrowth>;

export const GrowthSummary = z.object({
  days: z.union([z.literal(7), z.literal(28)]).describe("The period length, in days."),
  generatedAt: z.string(),
  replies: ReplyStats.nullable().describe("Replies on X: the period against the one before; null when the posted replies could not be read."),
  google: GoogleGrowth,
  ai: AiGrowth,
});
export type GrowthSummary = z.infer<typeof GrowthSummary>;

export const AnswerSourceView = z.object({
  position: z.number(),
  url: z.string().describe("As the engine returned it, verbatim."),
  domain: z.string(),
  title: z.string().nullable(),
  opensPage: z.boolean().describe("False when the address is the engine's redirect rather than the page; the title names the site."),
  ours: z.boolean().describe("One of the site's own domains."),
  inToday: z.boolean().describe("This page is an open place to reply in Today."),
});

export const AiAnswerView = z.object({
  id: z.string(),
  kind: z.enum(["prompt", "article"]).describe("prompt: one of the questions you chose; article: the weekly check of an article's keyword."),
  question: z.string(),
  engine: z.string(),
  askedAt: z.string(),
  status: z.enum(["cited", "not_cited", "invalid", "error"]),
  counted: z.boolean().describe("Counted in the per-engine asks: a readable answer."),
  ourPosition: Count,
  citedUrl: z.string().nullable(),
  mentioned: z.boolean().nullable(),
  excerpt: z.string().nullable().describe("The start of the engine's answer as stored, not the whole answer."),
  sources: z.array(AnswerSourceView),
  sourcesKept: z.boolean().describe("False for an article check: it keeps the verdict and, when cited, the cited page, not the source list."),
  placesInToday: z.number(),
  promptId: z.string().nullable(),
  articleId: z.string().nullable(),
  error: z.string().nullable(),
});

export const AiAnswersPage = z.object({
  days: z.union([z.literal(7), z.literal(28)]),
  window: DayWindowView,
  engine: z.string().nullable().describe("The engine filter, or null for every engine."),
  engines: z.array(z.string()).describe("Engines with an answer in the window, for the filter."),
  total: z.number().describe("Answers in the window that match the filter."),
  offset: z.number(),
  nextOffset: z.number().nullable(),
  answers: z.array(AiAnswerView).describe("Newest first."),
  sampled: z.literal(true),
  note: z.string(),
});
export type AiAnswersPage = z.infer<typeof AiAnswersPage>;
