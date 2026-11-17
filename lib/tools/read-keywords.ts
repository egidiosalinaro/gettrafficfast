import { z } from "zod";
import { BEST_PICK_RULE, KEYWORD_SORT_COLUMNS, bestPicks, isBestPick, sortKeywords } from "@/lib/keywords/picks";
import { INTENT_DESCRIPTION, TOPIC_INTENTS, intentOf } from "@/lib/keywords/intent";
import { ASKED_IN_PUBLIC, QUESTION_IDEAS_DEFAULT, QUESTION_IDEAS_MAX } from "@/lib/keywords/questions";
import { OVERLAP_NOTE, loadOverlappingTopics } from "@/lib/keywords/overlap";
import { loadKeywords, loadQuestionIdeas, type KeywordRow } from "@/lib/keywords/read";
import { defineTool, type ToolContext } from "./tool";

/**
 * The keyword pool (`/keywords`) as tools: the list with the screen's
 * search, status filter and column sort (`list_keywords`), and the best
 * picks the screen offers to queue in one click (`recommend_keywords`), and
 * the questions asked in the public threads discovery found, as keyword
 * ideas (`list_question_ideas`).
 *
 * Both read the pool through lib/keywords/read.ts and apply the rules in
 * lib/keywords/picks.ts, the page's own. Every metric is a model's
 * estimate, never measured: the output says so. Free.
 */

export const ESTIMATES_NOTE =
  "searchVolume, competition, difficulty, cpc and opportunity are a model's estimates, not measured data. A keyword whose source is \"question\" has none of them (null): it was asked in a public thread, and nothing about it is measured or estimated.";

export const QUESTION_IDEAS_NOTE =
  "Questions taken from the titles of public threads discovery found for this site. threadCount counts those threads; it is not search volume. No volume, difficulty or CPC exists for a question, measured or estimated.";

/** A stored number, or null; Postgres numerics may arrive as strings. */
function num(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

export const KeywordView = z.object({
  id: z.string(),
  keyword: z.string(),
  searchVolume: z.number().nullable().describe("Estimated monthly searches; null when unknown."),
  competition: z.string().nullable().describe("Low, Medium or High (estimate)."),
  difficulty: z.number().nullable().describe("0 to 100 (estimate)."),
  cpc: z.number().nullable().describe("Estimated cost per click in USD; null when unknown."),
  opportunity: z.string().nullable().describe("Low, Medium or High (estimate)."),
  status: z.string(),
  starred: z.boolean(),
  articleId: z.string().nullable().describe("Set once the keyword is on the calendar."),
  publishedUrl: z.string().nullable().describe("Where its article went live."),
  bestPick: z.boolean().describe(BEST_PICK_RULE),
  source: z
    .string()
    .nullable()
    .describe(
      '"question": asked in a public thread; "autopilot": bought by Autopilot\'s top-up; "manual": added by a person or their key. Null for a keyword added before 2026-11-14, when the source was not recorded.'
    ),
  sourceUrl: z.string().nullable().describe("For a question: one thread that asks it."),
  intent: z.enum(TOPIC_INTENTS).describe(`${INTENT_DESCRIPTION} A keyword stored before 2026-11-15 reads the rules' verdict.`),
  createdAt: z.string().nullable(),
});

/** A pool row with the fields the rules read, typed. */
function poolEntry(row: KeywordRow) {
  return {
    row,
    opportunity: str(row.opportunity),
    difficulty: num(row.difficulty),
    search_volume: num(row.search_volume),
    cpc: num(row.cpc),
    article_id: row.article_id ?? null,
  };
}
type PoolEntry = ReturnType<typeof poolEntry>;

function keywordView(k: PoolEntry): z.infer<typeof KeywordView> {
  return {
    id: k.row.id as string,
    keyword: String(k.row.keyword ?? ""),
    searchVolume: k.search_volume,
    competition: str(k.row.competition),
    difficulty: k.difficulty,
    cpc: k.cpc,
    opportunity: k.opportunity,
    status: String(k.row.status ?? ""),
    starred: k.row.is_starred === true,
    articleId: k.article_id,
    publishedUrl: k.row.published_url ?? null,
    bestPick: isBestPick(k),
    source: str(k.row.source),
    sourceUrl: str(k.row.source_url),
    intent: intentOf(k.row.intent, String(k.row.keyword ?? "")),
    createdAt: str(k.row.created_at),
  };
}

async function readPool(ctx: ToolContext, query: { search?: string; status?: string }): Promise<PoolEntry[]> {
  const pool = await loadKeywords(ctx.client, ctx.businessId, query);
  if (!pool.ok) throw new Error(`keywords: ${String((pool.error as { message?: string })?.message ?? pool.error)}`);
  return pool.keywords.map(poolEntry);
}

const SORTS = ["created_at", ...KEYWORD_SORT_COLUMNS] as const;

export const listKeywords = defineTool({
  name: "list_keywords",
  title: "List keywords",
  description: `The site's keyword pool, newest first unless sorted, as the Keywords screen shows it. search matches part of the keyword (any case); status filters (available, queued, published); starred keeps the starred ones. sort by created_at, opportunity, difficulty, search_volume or cpc, direction desc by default; unknown values sort last. Pages of limit, continued with nextCursor. ${ESTIMATES_NOTE}`,
  input: z.object({
    search: z.string().trim().min(1).max(100).optional(),
    status: z.string().trim().min(1).max(40).optional(),
    starred: z.boolean().optional(),
    sort: z.enum(SORTS).default("created_at"),
    direction: z.enum(["asc", "desc"]).default("desc"),
    cursor: z.string().regex(/^\d{1,6}$/, "a nextCursor from a previous page").optional(),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  output: z.object({
    keywords: z.array(KeywordView),
    total: z.number().describe("Keywords matching the filters, across every page."),
    nextCursor: z.string().nullable(),
    estimatesNote: z.string(),
  }),
  scope: "read",
  paid: false,
  async handler(ctx, input) {
    let pool = await readPool(ctx, { search: input.search, status: input.status });
    if (input.starred !== undefined) pool = pool.filter((k) => (k.row.is_starred === true) === input.starred);
    if (input.sort === "created_at") {
      // Read newest first; ascending is the same list the other way round.
      if (input.direction === "asc") pool = [...pool].reverse();
    } else {
      pool = sortKeywords(pool, { column: input.sort, dir: input.direction });
    }
    const offset = input.cursor ? Number(input.cursor) : 0;
    const page = pool.slice(offset, offset + input.limit);
    const next = offset + page.length;
    return {
      keywords: page.map(keywordView),
      total: pool.length,
      nextCursor: next < pool.length ? String(next) : null,
      estimatesNote: ESTIMATES_NOTE,
    };
  },
});

export const recommendKeywords = defineTool({
  name: "recommend_keywords",
  title: "Recommend keywords",
  description: `The keyword pool's best picks, the ones the Keywords screen offers to queue in one click: ${BEST_PICK_RULE} In the pool's order, newest first. Reads the pool only: no model is asked. ${ESTIMATES_NOTE}`,
  input: z.object({ limit: z.number().int().min(1).max(100).default(10) }),
  output: z.object({
    keywords: z.array(KeywordView),
    total: z.number().describe("Best picks in the pool."),
    rule: z.string(),
    estimatesNote: z.string(),
  }),
  scope: "read",
  paid: false,
  async handler(ctx, input) {
    const picks = bestPicks(await readPool(ctx, {}));
    return {
      keywords: picks.slice(0, input.limit).map(keywordView),
      total: picks.length,
      rule: BEST_PICK_RULE,
      estimatesNote: ESTIMATES_NOTE,
    };
  },
});

export const QuestionIdeaView = z.object({
  question: z.string().describe("The question as asked, cleaned of the site's own suffixes."),
  threadCount: z.number().describe("How many of this site's discovered threads ask it. Not search volume."),
  sourceUrl: z.string().describe("The most recent thread that asks it; pass it to add_keywords as sourceUrl."),
  host: z.string().describe("That thread's host: reddit.com, quora.com…"),
  surface: z.string(),
  community: z.string().nullable(),
  postedAt: z.string().nullable().describe("When that thread was posted; null when its date is unknown."),
  basis: z.string().describe(`Always "${ASKED_IN_PUBLIC}": what stands where a number would.`),
});

export const listQuestionIdeas = defineTool({
  name: "list_question_ideas",
  title: "List question ideas",
  description: `Questions people ask: keyword ideas taken from the titles of the public threads discovery found for this site (Reddit, Quora, X, Hacker News, LinkedIn…), the same posts list_reply_inbox works from. Near-duplicates are folded into one, questions a keyword or an article of the site already covers are left out, and the rest are ranked by how many distinct threads ask them, then by recency. Reads the site's own rows: no model is asked. Nothing is saved: add one with add_keywords as { keyword: question, source: "question", sourceUrl }. An empty list means discovery has found no question yet: run_reply_discovery finds conversations. ${QUESTION_IDEAS_NOTE}`,
  input: z.object({ limit: z.number().int().min(1).max(QUESTION_IDEAS_MAX).default(QUESTION_IDEAS_DEFAULT) }),
  output: z.object({
    questions: z.array(QuestionIdeaView),
    note: z.string(),
  }),
  scope: "read",
  paid: false,
  async handler(ctx, input) {
    const ideas = await loadQuestionIdeas(ctx.client, ctx.businessId, { limit: input.limit });
    if (!ideas.ok) throw new Error(`question ideas: ${String((ideas.error as { message?: string })?.message ?? ideas.error)}`);
    return {
      questions: ideas.questions.map((q) => ({ ...q, basis: ASKED_IN_PUBLIC })),
      note: QUESTION_IDEAS_NOTE,
    };
  },
});

export const OverlapClusterView = z.object({
  members: z.array(
    z.object({
      keywordId: z.string(),
      keyword: z.string(),
      status: z.string().describe("The keyword's status: available, queued, published."),
      article: z
        .object({
          id: z.string(),
          status: z.string(),
          title: z.string().nullable(),
          publishedUrl: z.string().nullable(),
          scheduledDate: z.string().nullable(),
        })
        .nullable()
        .describe("Its calendar article; null while the keyword is only in the pool."),
      searchConsole: z
        .object({
          impressions: z.number().nullable().describe("Counted by Search Console over the days stored; null when it has no Search Console data. Never 0 for not measured."),
          clicks: z.number().nullable(),
          position: z.number().nullable().describe("Average position weighted by impressions; lower is better; null when none was measured."),
          days: z.number().describe("Days of Search Console data behind the numbers. 0 means not measured."),
        })
        .nullable()
        .describe("Null when the keyword has no article."),
    })
  ),
  reasons: z
    .array(z.enum(["same_words", "similar_words", "contained", "title_covers", "same_serp"]))
    .describe("The signals that joined the members: the words, or the stored results pages (same_serp)."),
  keeperKeywordId: z.string().nullable().describe("The member whose article to keep; null when nothing published or measured can tell."),
  keeperBasis: z
    .enum(["most_impressions", "best_position", "only_published", "not_measured", "nothing_published"])
    .describe("What the suggestion rests on."),
  recommendation: z.string().describe("The suggestion in words. A suggestion only."),
});

export const listDuplicateKeywords = defineTool({
  name: "list_duplicate_keywords",
  title: "List overlapping topics",
  description:
    "Clusters of this site's keywords that are near-duplicates of each other (the same words in another order or form, most words in common, one phrase inside the other, or, where both have a stored results page, at least 6 of the top 10 results in common): articles written for them compete with each other in search. Each member comes with its article, what Search Console counted for it (impressions, clicks, average position; null when not measured) and the cluster with the member to keep: most impressions, then best position. Reads the site's own rows: no model is asked, nothing is fetched. It changes nothing: no keyword or article is deleted, merged or redirected; the owner decides. \"Overlapping topics\" on the Keywords screen.",
  input: z.object({ limit: z.number().int().min(1).max(100).default(50) }),
  output: z.object({
    clusters: z.array(OverlapClusterView),
    total: z.number().describe("Clusters found, before limit."),
    note: z.string(),
  }),
  scope: "read",
  paid: false,
  async handler(ctx, input) {
    const read = await loadOverlappingTopics(ctx.client, ctx.businessId);
    if (!read.ok) throw new Error(`overlapping topics: ${String((read.error as { message?: string })?.message ?? read.error)}`);
    return { clusters: read.clusters.slice(0, input.limit), total: read.clusters.length, note: OVERLAP_NOTE };
  },
});

export const KEYWORD_READ_TOOLS = [listKeywords, recommendKeywords, listQuestionIdeas, listDuplicateKeywords] as const;
