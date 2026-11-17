import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { inRequestBillingRefusal } from "@/lib/llm-billing-refusal";
import { findSimilarKeywords, generateKeywordsFromBusiness, type KeywordSuggestion } from "@/lib/research/keywords";
import { pluralize } from "@/lib/utils";
import { classifyTopicIntent, parseTopicIntent } from "./intent";
import { loadNamedTools, settleSuggestions, type RefusedSuggestion, type SettledSuggestion } from "./named-tools";
import { findOverlaps, loadSiteTopics, type PhraseOverlap } from "./overlap";
import { QUESTION_SOURCE, threadHost } from "./questions";
import { MANUAL_SOURCE } from "./source";

/**
 * The keywords page's writes, one function each, called by its routes
 * (`/api/keywords/*`) and by the keyword tools (lib/tools/write-keywords.ts),
 * so the screen and the API cannot drift.
 *
 * Every function takes the caller's client (the person's RLS client, or an
 * API key's owner-scoped service role) and the site, and scopes every
 * statement to the site and the user: an id from another site is not found.
 */

type Row = Record<string, unknown>;

export type KeywordFailure = { ok: false; status: 400 | 404 | 409 | 500 | 503; error: string };

/** A keyword as the keywords page adds it: the research fields are optional. */
export interface IncomingKeyword {
  keyword: string;
  searchVolume?: number | null;
  competition?: string | null;
  difficulty?: number | null;
  cpc?: number | null;
  opportunity?: string | null;
  /**
   * "question": asked in a public thread discovery found for the site
   * (lib/keywords/questions.ts). Such a keyword has no research figures, so
   * any sent with it are not stored.
   */
  source?: string | null;
  /** The thread that asks it: required with `source`, and one of the site's discovered threads. */
  sourceUrl?: string | null;
  /**
   * The kind of search (lib/keywords/intent.ts). Kept when it is one of the
   * four, as a suggestion carries it or a person chose it; otherwise the
   * rules decide it from the phrase.
   */
  intent?: string | null;
}

export type AddKeywordsResult =
  | {
      ok: true;
      keywords: Row[];
      /** Set only when some were already in the list, or overlapped a topic: the sentence the page shows. */
      message: string | null;
      /**
       * Phrases NOT added because they overlap a keyword the site has, a
       * published article, or an earlier phrase of the same call
       * (lib/keywords/duplicates.ts). Empty when `allowDuplicates` was set.
       */
      duplicates: PhraseOverlap[];
    }
  | KeywordFailure;

/** The sentence said when phrases were left out for overlapping a topic. */
export function overlapMessage(duplicates: readonly PhraseOverlap[]): string {
  const first = duplicates[0];
  const other = first.duplicateOf?.keyword ?? first.duplicateOf?.articleTitle ?? first.duplicateOfPhrase;
  const example = other ? ` "${first.keyword}" overlaps "${other}".` : "";
  return `${pluralize(duplicates.length, "keyword was", "keywords were")} not added: ${
    duplicates.length === 1 ? "it overlaps" : "they overlap"
  } a topic you already have, and two articles on one topic compete with each other.${example}`;
}

const NOT_A_FOUND_THREAD =
  "A question keyword needs sourceUrl: the link of a thread found for this site (list_question_ideas gives it).";

/**
 * Adds keywords to the site's pool, available and unstarred. A keyword with
 * `source` "question" is stored with every research figure null and the
 * thread that asks it; its `sourceUrl` must be one of the site's discovered
 * threads (400 otherwise, nothing saved). Every other keyword is stored with
 * `source` "manual": a person added it. A keyword the
 * site already has (`keywords_business_id_keyword_key`) is skipped, and the
 * message says how many; when every one was there it is a 409.
 *
 * A phrase that is a near-duplicate of a keyword the site has, of a
 * published article, or of an earlier phrase of the same call is not added
 * and comes back in `duplicates` with what it overlaps, unless
 * `allowDuplicates` says the caller saw that and wants it anyway.
 */
export async function addKeywords(input: {
  supabase: SupabaseClient;
  userId: string;
  businessId: string;
  keywords: IncomingKeyword[];
  /** True adds near-duplicates too: the explicit override. */
  allowDuplicates?: boolean;
  /**
   * The platforms the site's data names (lib/keywords/named-tools.ts), when
   * the caller has read them: a how-to about one is a platform how-to.
   * Without them the rules still decide every other intent.
   */
  names?: readonly string[];
}): Promise<AddKeywordsResult> {
  const { supabase, userId, businessId } = input;

  let incoming = input.keywords;
  let duplicates: PhraseOverlap[] = [];
  if (!input.allowDuplicates) {
    const topics = await loadSiteTopics(supabase, businessId);
    if (!topics.ok) {
      console.error("Error reading the site's topics:", topics.error);
      return { ok: false, status: 500, error: "Failed to save keywords" };
    }
    const split = findOverlaps(
      topics,
      incoming.map((kw) => kw.keyword)
    );
    duplicates = split.overlaps;
    const overlapping = new Set(duplicates.map((d) => d.keyword));
    incoming = incoming.filter((kw) => !overlapping.has(kw.keyword.trim()));
    // Nothing left to add: not a failure, the answer says what each overlaps.
    if (incoming.length === 0) {
      return { ok: true, keywords: [], message: overlapMessage(duplicates), duplicates };
    }
  }
  const overlapNote = duplicates.length > 0 ? overlapMessage(duplicates) : null;

  const asked = incoming.filter((kw) => kw.source === QUESTION_SOURCE);
  if (asked.length > 0) {
    // "Asked in a public thread" is a claim: it holds only for a thread
    // discovery found for this site, so the link is checked, never trusted.
    const urls = [...new Set(asked.map((kw) => (typeof kw.sourceUrl === "string" ? kw.sourceUrl.trim() : "")))];
    if (urls.some((url) => !threadHost(url))) return { ok: false, status: 400, error: NOT_A_FOUND_THREAD };
    const { data: found, error: threadsError } = await supabase
      .from("placement_targets")
      .select("url")
      .eq("business_id", businessId)
      .in("url", urls);
    if (threadsError) {
      console.error("Error checking question threads:", threadsError);
      return { ok: false, status: 500, error: "Failed to save keywords" };
    }
    const known = new Set((found ?? []).map((row) => row.url as string));
    if (urls.some((url) => !known.has(url))) return { ok: false, status: 400, error: NOT_A_FOUND_THREAD };
  }

  const keywordsData = incoming.map((kw) => {
    const fromThread = kw.source === QUESTION_SOURCE;
    return {
      user_id: userId,
      business_id: businessId,
      keyword: kw.keyword.trim(),
      // A question from a thread has no research figures: null, never the
      // defaults a suggestion gets and never a number sent along with it.
      search_volume: fromThread ? null : kw.searchVolume || null,
      competition: fromThread ? null : kw.competition || "Medium",
      difficulty: fromThread ? null : kw.difficulty || 50,
      cpc: fromThread ? null : kw.cpc || null,
      opportunity: fromThread ? null : kw.opportunity || "Medium",
      status: "available",
      is_starred: false,
      // Where the topic came from, for the Content screen (lib/keywords/
      // source.ts): a question names its thread; anything else added here
      // was added by a person (on the screen, or with their API key).
      // Autopilot's own keywords are written by its sweep, not here.
      source: fromThread ? QUESTION_SOURCE : MANUAL_SOURCE,
      source_url: fromThread ? (kw.sourceUrl as string).trim() : null,
      // The kind of search, decided once, when the topic enters the pool.
      intent: parseTopicIntent(kw.intent) ?? classifyTopicIntent(kw.keyword, { names: input.names }),
    };
  });

  const { data, error } = await supabase.from("keywords").insert(keywordsData).select();
  if (!error) return { ok: true, keywords: (data ?? []) as Row[], message: overlapNote, duplicates };

  console.error("Error saving keywords:", error);
  // A unique violation: some are already in the list. Insert only the new ones.
  if (error.code !== "23505") return { ok: false, status: 500, error: "Failed to save keywords" };

  const existingKeywords = await supabase
    .from("keywords")
    .select("keyword")
    .eq("business_id", businessId)
    .in(
      "keyword",
      keywordsData.map((k) => k.keyword)
    );
  const existingSet = new Set(existingKeywords.data?.map((k) => k.keyword) || []);
  const newKeywords = keywordsData.filter((k) => !existingSet.has(k.keyword));
  if (newKeywords.length === 0) {
    // Some were in the list and the rest overlap a topic: nothing failed.
    if (overlapNote) return { ok: true, keywords: [], message: overlapNote, duplicates };
    return { ok: false, status: 409, error: "All keywords already exist" };
  }

  const { data: newData, error: newError } = await supabase.from("keywords").insert(newKeywords).select();
  if (newError || !newData) return { ok: false, status: 500, error: "Failed to save keywords" };

  return {
    ok: true,
    keywords: newData as Row[],
    message: `${pluralize(newData.length, "new keyword")} added.${
      keywordsData.length > newData.length
        ? ` ${pluralize(keywordsData.length - newData.length, "keyword was", "keywords were")} already in your list.`
        : ""
    }${overlapNote ? ` ${overlapNote}` : ""}`,
    duplicates,
  };
}

/**
 * The fields a person may change on a keyword from the keywords page, and
 * nothing else. The body used to be written as is, so a direct PATCH could set
 * `business_id`, `article_id`, `status` or `user_id` on a row. Status and the
 * article link belong to the calendar routes; the rest is not the client's.
 * Unknown fields are refused (400), not silently dropped.
 */
export const UpdateKeywordInput = z.object({
  keywordId: z.string().min(1),
  updates: z
    .object({
      is_starred: z.boolean(),
    })
    .strict(),
});

/** Stars or unstars one keyword of the site: the only change the page makes. */
export async function setKeywordStarred(input: {
  supabase: SupabaseClient;
  userId: string;
  businessId: string;
  keywordId: string;
  starred: boolean;
}): Promise<{ ok: true; keyword: Row } | KeywordFailure> {
  const { data, error } = await input.supabase
    .from("keywords")
    .update({ is_starred: input.starred })
    .eq("id", input.keywordId)
    .eq("business_id", input.businessId)
    .eq("user_id", input.userId)
    .select()
    .maybeSingle();
  if (error) {
    console.error("Error updating keyword:", error);
    return { ok: false, status: 500, error: "Failed to update keyword" };
  }
  if (!data) return { ok: false, status: 404, error: "Keyword not found" };
  return { ok: true, keyword: data as Row };
}

/** Deletes the site's keywords among `ids`; ids of another site are left alone. */
export async function deleteKeywords(input: {
  supabase: SupabaseClient;
  userId: string;
  businessId: string;
  ids: string[];
}): Promise<{ ok: true; deleted: number } | KeywordFailure> {
  const { error, count } = await input.supabase
    .from("keywords")
    .delete({ count: "exact" })
    .eq("business_id", input.businessId)
    .eq("user_id", input.userId)
    .in("id", input.ids);
  if (error) {
    console.error("Error deleting keywords:", error);
    return { ok: false, status: 500, error: "Failed to delete keywords" };
  }
  return { ok: true, deleted: count ?? 0 };
}

/**
 * Keyword ideas, one model call, never saved: the person picks which ones
 * to add. From `seeds` (similar keywords), or from the site's own profile
 * when `fromBusiness`. Business context always comes from the given site.
 *
 * A billing refusal is recorded and answered as a 503 in words; any other
 * failure is thrown, for the caller to answer as it always has.
 */
export async function suggestKeywords(input: {
  supabase: SupabaseClient;
  admin: () => SupabaseClient;
  userId: string;
  businessId: string | null;
  seeds: unknown;
  fromBusiness: boolean;
  /** Who asked, for the billing record: "api.keywords.suggest", "tool.suggest_keywords". */
  source: string;
}): Promise<
  | { ok: true; suggestions: SettledSuggestion[]; duplicates: PhraseOverlap[]; refused: RefusedSuggestion[] }
  | KeywordFailure
> {
  const { supabase, userId, businessId } = input;
  const { data: business } = businessId
    ? await supabase
        .from("businesses")
        .select("name, niche, description, website_url, content_language")
        .eq("id", businessId)
        .eq("user_id", userId)
        .maybeSingle()
    : { data: null };

  // What the site's data names: the only products a suggestion may name.
  // Three reads of the site's own rows, before the one model call.
  const names = businessId
    ? (
        await loadNamedTools(supabase, businessId, {
          businessName: business?.name ?? null,
          websiteUrl: business?.website_url ?? null,
        })
      ).map((tool) => tool.name)
    : [];
  const settle = (suggestions: KeywordSuggestion[]) =>
    settleSuggestions(suggestions, {
      names,
      businessName: business?.name ?? null,
      profile: [business?.niche, business?.description].filter(Boolean).join("\n"),
    });

  try {
    if (input.fromBusiness) {
      if (!business) {
        return {
          ok: false,
          status: 400,
          error: "Business information not found. Please set up your business in Settings first.",
        };
      }
      const suggestions = await generateKeywordsFromBusiness(
        business.niche || undefined,
        business.description || undefined,
        business.website_url || undefined,
        business.content_language || undefined,
        { businessName: business.name || undefined, names }
      );
      const { kept, refused } = settle(suggestions);
      return { ok: true, ...(await withoutOverlaps(supabase, businessId, kept)), refused };
    }

    const seeds = input.seeds;
    if (!seeds || !Array.isArray(seeds) || seeds.length === 0) {
      return { ok: false, status: 400, error: "Keywords array is required" };
    }
    const suggestions = await findSimilarKeywords(
      seeds,
      business?.niche || undefined,
      business?.description || undefined,
      business?.content_language || undefined
    );
    const { kept, refused } = settle(suggestions);
    return { ok: true, ...(await withoutOverlaps(supabase, businessId, kept)), refused };
  } catch (error) {
    const refused = await inRequestBillingRefusal(input.admin, error, input.source);
    if (refused) return refused;
    throw error;
  }
}

/**
 * Suggestions without the ones that overlap a topic the site already has
 * (or an earlier suggestion): those come back apart, each with what it
 * overlaps, so the person sees why an idea is not offered. When the site's
 * topics cannot be read the suggestions are returned whole: the add refuses
 * a duplicate anyway.
 */
async function withoutOverlaps<T extends KeywordSuggestion>(
  supabase: SupabaseClient,
  businessId: string | null,
  suggestions: T[]
): Promise<{ suggestions: T[]; duplicates: PhraseOverlap[] }> {
  if (!businessId || suggestions.length === 0) return { suggestions, duplicates: [] };
  const topics = await loadSiteTopics(supabase, businessId);
  if (!topics.ok) {
    console.error("Error reading the site's topics:", topics.error);
    return { suggestions, duplicates: [] };
  }
  const { overlaps } = findOverlaps(
    topics,
    suggestions.map((s) => s.keyword)
  );
  const overlapping = new Set(overlaps.map((o) => o.keyword));
  // A suggestion the site already has letter for letter stays out too.
  const stored = new Set(topics.keywords.map((k) => k.keyword));
  return {
    suggestions: suggestions.filter((s) => !overlapping.has(s.keyword.trim()) && !stored.has(s.keyword.trim())),
    duplicates: overlaps,
  };
}
