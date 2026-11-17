import { z } from "zod";
import { addKeywords, deleteKeywords, setKeywordStarred, suggestKeywords } from "@/lib/keywords/manage";
import type { PhraseOverlap } from "@/lib/keywords/overlap";
import { INTENT_DESCRIPTION, TOPIC_INTENTS, intentOf } from "@/lib/keywords/intent";
import { QUESTION_SOURCE } from "@/lib/keywords/questions";
import { KeywordSuggestion } from "@/lib/research/keywords";
import { defineTool, ToolError } from "./tool";
import { libRefusal } from "./write-guards";

/**
 * The keywords page's writes as tools (`/keywords`). Each handler calls the
 * function the page's route calls (lib/keywords/manage.ts) and maps its
 * result. The runner has already checked the key's scopes, the site, and
 * that every keyword id is a row of this account and this site (`owns`).
 */

type Row = Record<string, unknown>;

const KeywordId = z.string().uuid().describe("A keyword's id, from the site's keyword list.");

const LEVELS = ["Low", "Medium", "High"] as const;

/**
 * A stored keyword. Research figures are a model's estimates, not
 * measurements; a keyword whose source is "question" has none (all null).
 */
export const KeywordRecord = z.object({
  id: z.string(),
  keyword: z.string(),
  status: z.string().describe("available, queued (on the calendar), or what the calendar made of it."),
  starred: z.boolean(),
  searchVolume: z.number().nullable().describe("Estimated monthly searches, from the model that suggested it; null when unknown."),
  competition: z.string().nullable(),
  difficulty: z.number().nullable(),
  cpc: z.number().nullable(),
  opportunity: z.string().nullable(),
  articleId: z.string().nullable().describe("The calendar article written for it, once scheduled."),
  source: z
    .string()
    .nullable()
    .describe(
      '"question" when it was asked in a public thread (its figures are null: nothing is measured or estimated); "manual" for any other keyword added here; "autopilot" when Autopilot bought it. Null for a keyword added before 2026-11-14.'
    ),
  sourceUrl: z.string().nullable().describe("For a question: one thread that asks it."),
  intent: z.enum(TOPIC_INTENTS).describe(INTENT_DESCRIPTION),
  createdAt: z.string().nullable(),
});

export function mapKeyword(row: Row): z.infer<typeof KeywordRecord> {
  const num = (value: unknown) => (typeof value === "number" ? value : value === null || value === undefined ? null : Number(value));
  return {
    id: row.id as string,
    keyword: row.keyword as string,
    status: (row.status as string | null) ?? "available",
    starred: row.is_starred === true,
    searchVolume: num(row.search_volume),
    competition: (row.competition as string | null) ?? null,
    difficulty: num(row.difficulty),
    cpc: num(row.cpc),
    opportunity: (row.opportunity as string | null) ?? null,
    articleId: (row.article_id as string | null) ?? null,
    source: (row.source as string | null) ?? null,
    sourceUrl: (row.source_url as string | null) ?? null,
    intent: intentOf(row.intent, String(row.keyword ?? "")),
    createdAt: (row.created_at as string | null) ?? null,
  };
}

const IncomingKeyword = z.union([
  z.string().trim().min(1).max(200),
  z.object({
    keyword: z.string().trim().min(1).max(200),
    searchVolume: z.number().int().min(0).nullable().optional(),
    competition: z.enum(LEVELS).nullable().optional(),
    difficulty: z.number().min(0).max(100).nullable().optional(),
    cpc: z.number().min(0).nullable().optional(),
    opportunity: z.enum(LEVELS).nullable().optional(),
    source: z
      .literal(QUESTION_SOURCE)
      .optional()
      .describe("Set for a question from list_question_ideas: it is stored with no figures, as asked in a public thread."),
    sourceUrl: z.string().url().max(2000).optional().describe("With source: the question's sourceUrl, a thread found for this site."),
    intent: z
      .enum(TOPIC_INTENTS)
      .nullable()
      .optional()
      .describe("The kind of search, as suggest_keywords returns it or as you choose it. Left out, the rules decide it from the phrase."),
  }),
]);

/** A phrase left out because it overlaps a topic the site already has. */
export const KeywordOverlap = z.object({
  keyword: z.string().describe("The phrase that was not added, or not suggested."),
  reason: z
    .enum(["same_words", "similar_words", "contained", "title_covers", "same_serp"])
    .describe("same_words: equal once order, plural and stop words are gone. similar_words: most words in common. contained: one is the other plus a word or two. title_covers: a published article's title holds every word. same_serp: the stored results pages share most of their top 10."),
  why: z.string().describe("The reason in words."),
  duplicateOf: z
    .object({
      keywordId: z.string().nullable(),
      keyword: z.string().nullable(),
      status: z.string().nullable().describe("The overlapped keyword's status: available, queued, published."),
      articleId: z.string().nullable(),
      articleTitle: z.string().nullable(),
      publishedUrl: z.string().nullable().describe("Where its article is live, when it is."),
    })
    .nullable()
    .describe("The keyword or published article of the site it overlaps; null when it overlaps an earlier phrase of the same call."),
  duplicateOfPhrase: z.string().nullable().describe("The earlier phrase of the same call it overlaps, when that is the case."),
});

export function overlapView(o: PhraseOverlap): z.infer<typeof KeywordOverlap> {
  const of = o.duplicateOf;
  return {
    keyword: o.keyword,
    reason: o.reason,
    why: o.why,
    duplicateOf: of
      ? {
          keywordId: of.keywordId,
          keyword: of.keyword,
          status: of.status,
          articleId: of.articleId,
          articleTitle: of.articleTitle,
          publishedUrl: of.publishedUrl,
        }
      : null,
    duplicateOfPhrase: o.duplicateOfPhrase,
  };
}

export const addKeywordsTool = defineTool({
  name: "add_keywords",
  title: "Add keywords",
  description:
    "Adds keywords to this site's pool, available and unstarred. Each is a phrase, or an object as suggest_keywords returns it (its estimates are kept), or a question from list_question_ideas as { keyword, source: \"question\", sourceUrl } (stored with every figure null: asked in a public thread, nothing measured or estimated; sourceUrl must be a thread found for this site). A keyword the site already has is skipped and counted. A near-duplicate of a keyword the site has, of a published article, or of an earlier phrase of the same call (same words in another order or form, most words in common, one phrase inside the other) is NOT added either: it comes back in duplicates with what it overlaps, because two articles on one topic compete with each other. Pass allowDuplicates: true to add those anyway, once the person has seen them. Nothing is scheduled: schedule_keywords puts them on the calendar.",
  input: z.object({
    keywords: z.array(IncomingKeyword).min(1).max(100).describe("1 to 100 keywords."),
    allowDuplicates: z
      .boolean()
      .default(false)
      .describe("true adds near-duplicates too: the explicit override, for a person who saw the overlap and wants both."),
  }),
  output: z.object({
    added: z.number(),
    alreadyInList: z.number().describe("Keywords the site already had, letter for letter, skipped."),
    keywords: z.array(KeywordRecord).describe("The keywords added."),
    duplicates: z.array(KeywordOverlap).describe("Phrases not added because they overlap a topic the site already has. Empty with allowDuplicates."),
    message: z.string().nullable(),
  }),
  scope: "write",
  paid: false,
  async handler(ctx, input) {
    // One row per phrase: the table is unique on (site, keyword).
    const byPhrase = new Map<string, Exclude<(typeof input.keywords)[number], string>>();
    for (const k of input.keywords) {
      const keyword = typeof k === "string" ? { keyword: k } : k;
      if (!byPhrase.has(keyword.keyword)) byPhrase.set(keyword.keyword, keyword);
    }
    const keywords = [...byPhrase.values()];
    const result = await addKeywords({
      supabase: ctx.client,
      userId: ctx.userId,
      businessId: ctx.businessId,
      keywords,
      allowDuplicates: input.allowDuplicates,
    });
    if (!result.ok) {
      if (result.status === 409) {
        return { added: 0, alreadyInList: keywords.length, keywords: [], duplicates: [], message: "All keywords already exist" };
      }
      throw libRefusal(result);
    }
    return {
      added: result.keywords.length,
      alreadyInList: keywords.length - result.keywords.length - result.duplicates.length,
      keywords: result.keywords.map(mapKeyword),
      duplicates: result.duplicates.map(overlapView),
      message: result.message,
    };
  },
});

export const updateKeyword = defineTool({
  name: "update_keyword",
  title: "Star a keyword",
  description:
    "Stars or unstars one keyword of this site, the only change the keywords page makes to one. Its status and calendar article belong to the calendar tools.",
  input: z.object({ keywordId: KeywordId, starred: z.boolean() }),
  output: z.object({ keyword: KeywordRecord }),
  scope: "write",
  paid: false,
  owns: { keywordId: "keywords" },
  async handler(ctx, input) {
    const result = await setKeywordStarred({
      supabase: ctx.client,
      userId: ctx.userId,
      businessId: ctx.businessId,
      keywordId: input.keywordId,
      starred: input.starred,
    });
    if (!result.ok) throw libRefusal(result);
    return { keyword: mapKeyword(result.keyword) };
  },
});

export const deleteKeywordsTool = defineTool({
  name: "delete_keywords",
  title: "Delete keywords",
  description: "Deletes keywords from this site's pool, by id. Every id must be one of this site's keywords, or nothing is deleted.",
  input: z.object({ ids: z.array(KeywordId).min(1).max(200).describe("1 to 200 keyword ids.") }),
  output: z.object({ deleted: z.number() }),
  scope: "write",
  paid: false,
  destructive: true,
  owns: { ids: "keywords" },
  async handler(ctx, input) {
    const result = await deleteKeywords({
      supabase: ctx.client,
      userId: ctx.userId,
      businessId: ctx.businessId,
      ids: [...new Set(input.ids)],
    });
    if (!result.ok) throw libRefusal(result);
    return { deleted: result.deleted };
  },
});

export const suggestKeywordsTool = defineTool({
  name: "suggest_keywords",
  title: "Suggest keywords",
  description:
    "Keyword ideas for this site, one model call: similar to the seeds you give, or, with fromBusiness, from the site's own profile (niche, description, language). Nothing is saved; pass the ones worth keeping to add_keywords. An idea that overlaps a keyword the site has, a published article, or an earlier idea is left out of suggestions and listed in duplicates with what it overlaps. Ideas cover a mix of searches, each with its intent: comparisons, platform how-tos and problem questions beside the core topics. A product or platform is named only when the site's own data names it (its articles, the results pages it competes in, AI answers); a comparison naming any other product is left out and listed in refused. Volume, difficulty and CPC are the model's estimates, not measured data; a comparison, platform how-to or problem idea carries no volume and no CPC.",
  input: z.object({
    seeds: z.array(z.string().trim().min(1).max(100)).min(1).max(20).optional().describe("Keywords to find neighbours of."),
    fromBusiness: z.boolean().default(false).describe("Suggest from the site's profile instead of seeds."),
  }),
  output: z.object({
    suggestions: z.array(KeywordSuggestion.extend({ intent: z.enum(TOPIC_INTENTS).describe(INTENT_DESCRIPTION) })),
    duplicates: z.array(KeywordOverlap).describe("Ideas left out because they overlap a topic the site already has."),
    refused: z
      .array(z.object({ keyword: z.string(), names: z.array(z.string()), why: z.string() }))
      .describe("Comparisons left out because they name a product nothing in the site's data names (its articles, the results pages it competes in, AI answers, its own profile): a competitor is never invented."),
    estimated: z.literal(true).describe("The figures are a model's estimates, never measured; a comparison, platform how-to or problem idea carries no searchVolume and no cpc."),
  }),
  scope: "write",
  paid: true,
  async handler(ctx, input) {
    if (!input.fromBusiness && !input.seeds?.length) {
      throw new ToolError("invalid_input", "Give seeds, or set fromBusiness.", 400);
    }
    const result = await suggestKeywords({
      supabase: ctx.client,
      admin: ctx.admin,
      userId: ctx.userId,
      businessId: ctx.businessId,
      seeds: input.seeds,
      fromBusiness: input.fromBusiness,
      source: "tool.suggest_keywords",
    });
    if (!result.ok) throw libRefusal(result);
    return {
      suggestions: result.suggestions,
      duplicates: result.duplicates.map(overlapView),
      refused: result.refused,
      estimated: true as const,
    };
  },
});

export const WRITE_KEYWORD_TOOLS = [addKeywordsTool, updateKeyword, deleteKeywordsTool, suggestKeywordsTool] as const;
