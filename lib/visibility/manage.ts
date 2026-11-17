import { randomUUID } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createBudget } from "@/lib/agents/contract";
import { proposePromptsAgent, type ProposedPrompt } from "@/lib/agents/propose-prompts";
import { runAgent, supabaseRecorder } from "@/lib/agents/runner";
import { contentLanguageName } from "@/lib/content-language";
import { inRequestBillingRefusal } from "@/lib/llm-billing-refusal";
import { getCitationProviders } from "@/lib/providers/citations/registry";
import { domainOf } from "@/lib/providers/citations/types";
import { finalizeSuggestions } from "./propose";
import { MAX_QUERIES_PER_BUSINESS, newQueries, normalizeQuery, type QueryInput } from "./queries";
import { activeEngines, mapQuery, QUERY_COLUMNS, type AeoQueryRecord } from "./read";
import { parseAeoSettings, type AeoSettings } from "./settings";
import { hasActiveRun, startRun } from "./store";

/**
 * AI Visibility's writes, one function each, called by its routes
 * (`/api/visibility/*`) and by the visibility tools
 * (lib/tools/write-visibility.ts), so the screen and the API cannot drift.
 *
 * Every function takes the caller's client and the site; `business_id` is
 * never taken from a body, and a change by id is scoped to the id, the site
 * and the user.
 */

type Row = Record<string, unknown>;

export type VisibilityFailure = { ok: false; status: 400 | 404 | 409 | 500 | 503; error: string };

// ── The prompt set ───────────────────────────────────────────────────────────

/** Adds prompts to the site's set; wordings already there are counted, not added. */
export async function addPrompts(input: {
  supabase: SupabaseClient;
  userId: string;
  businessId: string;
  queries: QueryInput[];
  source: "manual" | "keyword" | "suggested";
}): Promise<{ ok: true; added: number; duplicates: number; queries: AeoQueryRecord[] } | VisibilityFailure> {
  const { supabase, userId, businessId } = input;
  const { data: existing } = await supabase.from("aeo_queries").select("query").eq("business_id", businessId);
  const current = (existing ?? []).map((r) => r.query as string);

  const { fresh, duplicates } = newQueries(input.queries, current);
  const room = MAX_QUERIES_PER_BUSINESS - current.length;
  if (fresh.length > room) {
    return { ok: false, status: 409, error: `A site can hold ${MAX_QUERIES_PER_BUSINESS} prompts; ${room} more fit.` };
  }
  if (fresh.length === 0) return { ok: true, added: 0, duplicates, queries: [] };

  const { data, error } = await supabase
    .from("aeo_queries")
    .insert(
      fresh.map((q) => ({
        user_id: userId,
        business_id: businessId,
        query: q.query,
        cluster: q.cluster,
        intent: q.intent,
        source: input.source,
      }))
    )
    .select(QUERY_COLUMNS);
  if (error) return { ok: false, status: 500, error: error.message };

  return { ok: true, added: data?.length ?? 0, duplicates, queries: ((data ?? []) as Row[]).map(mapQuery) };
}

/** What may change on one prompt. A field left undefined is left as it is. */
export interface PromptPatch {
  query?: string;
  cluster?: string | null;
  intent?: string | null;
  enabled?: boolean;
}

export async function updatePrompt(input: {
  supabase: SupabaseClient;
  userId: string;
  businessId: string;
  id: string;
  patch: PromptPatch;
  now?: Date;
}): Promise<{ ok: true; query: AeoQueryRecord } | VisibilityFailure> {
  const patch: Row = { updated_at: (input.now ?? new Date()).toISOString() };
  if (input.patch.query !== undefined) patch.query = input.patch.query;
  if (input.patch.cluster !== undefined) patch.cluster = input.patch.cluster;
  if (input.patch.intent !== undefined) patch.intent = input.patch.intent;
  if (input.patch.enabled !== undefined) patch.enabled = input.patch.enabled;

  const { data, error } = await input.supabase
    .from("aeo_queries")
    .update(patch)
    .eq("id", input.id)
    .eq("business_id", input.businessId)
    .eq("user_id", input.userId)
    .select(QUERY_COLUMNS)
    .maybeSingle();
  if (error) {
    return error.code === "23505"
      ? { ok: false, status: 409, error: "That wording is already in the set." }
      : { ok: false, status: 500, error: error.message };
  }
  if (!data) return { ok: false, status: 404, error: "Prompt not found" };
  return { ok: true, query: mapQuery(data as Row) };
}

/** Takes a prompt out of the set. Its probes keep their history (query_id goes null). */
export async function deletePrompt(input: {
  supabase: SupabaseClient;
  userId: string;
  businessId: string;
  id: string;
}): Promise<{ ok: true; deleted: number } | VisibilityFailure> {
  const { error, count } = await input.supabase
    .from("aeo_queries")
    .delete({ count: "exact" })
    .eq("id", input.id)
    .eq("business_id", input.businessId)
    .eq("user_id", input.userId);
  if (error) return { ok: false, status: 500, error: error.message };
  if (!count) return { ok: false, status: 404, error: "Prompt not found" };
  return { ok: true, deleted: count };
}

/** Keywords considered by an import. A bulk import should seed a set, not fill the cap. */
export const MAX_KEYWORD_IMPORT = 50;

/**
 * Seeds the set from the site's own keywords. Deterministic and free: each
 * keyword becomes one prompt, verbatim, in the "keywords" cluster; no model
 * rewrites anything, because a prompt the owner did not see is a probe they
 * cannot interpret. What does not fit under the cap is counted as skipped.
 */
export async function importPromptsFromKeywords(input: {
  supabase: SupabaseClient;
  userId: string;
  businessId: string;
}): Promise<{ ok: true; added: number; duplicates: number; skipped: number } | VisibilityFailure> {
  const { supabase, userId, businessId } = input;
  const [{ data: keywords, error }, { data: existing }] = await Promise.all([
    supabase
      .from("keywords")
      .select("keyword")
      .eq("business_id", businessId)
      .order("created_at", { ascending: true })
      .limit(MAX_KEYWORD_IMPORT),
    supabase.from("aeo_queries").select("query").eq("business_id", businessId),
  ]);
  if (error) return { ok: false, status: 500, error: error.message };

  const current = (existing ?? []).map((r) => r.query as string);
  const candidates = (keywords ?? [])
    .map((k) => normalizeQuery(k.keyword as string))
    .filter((q) => q.length >= 3)
    .map((query) => ({ query }));

  const { fresh, duplicates } = newQueries(candidates, current);
  const room = Math.max(0, MAX_QUERIES_PER_BUSINESS - current.length);
  const toInsert = fresh.slice(0, room);
  if (toInsert.length === 0) return { ok: true, added: 0, duplicates, skipped: fresh.length };

  const { data, error: insertError } = await supabase
    .from("aeo_queries")
    .insert(
      toInsert.map((q) => ({
        user_id: userId,
        business_id: businessId,
        query: q.query,
        cluster: "keywords",
        source: "keyword",
      }))
    )
    .select("id");
  if (insertError) return { ok: false, status: 500, error: insertError.message };

  return { ok: true, added: data?.length ?? 0, duplicates, skipped: fresh.length - toInsert.length };
}

/** The most one suggestion may cost: one bounded model call. */
const SUGGEST_BUDGET_USD = 0.05;

/**
 * Founder-style prompts for the site, one model call, never written: the
 * owner picks which ones enter the set. Suggestions that read like keywords
 * or are already in the set are dropped (`discarded` counts them).
 *
 * A billing refusal is recorded and answered as a 503 in words; any other
 * failure is thrown for the caller to answer. The agent run is recorded by
 * the service role: `agent_runs` has no insert policy for users.
 */
export async function suggestPrompts(input: {
  supabase: SupabaseClient;
  admin: () => SupabaseClient;
  userId: string;
  businessId: string;
  /** Who asked, for the billing record. */
  source: string;
}): Promise<{ ok: true; prompts: ProposedPrompt[]; discarded: number } | VisibilityFailure> {
  const { supabase, userId, businessId } = input;
  const [{ data: business }, { data: existingRows }, { data: keywordRows }, { data: competitorRows }] =
    await Promise.all([
      supabase
        .from("businesses")
        .select("name, niche, description, website_url, content_language")
        .eq("id", businessId)
        .eq("user_id", userId)
        .maybeSingle(),
      supabase.from("aeo_queries").select("query").eq("business_id", businessId),
      supabase
        .from("keywords")
        .select("keyword")
        .eq("business_id", businessId)
        .order("created_at", { ascending: true })
        .limit(20),
      supabase.from("competitors").select("name, domain").eq("business_id", businessId).limit(20),
    ]);

  if (!business) {
    return { ok: false, status: 409, error: "Set up the business first. Suggestions are written from that profile." };
  }

  const existing = (existingRows ?? []).map((r) => r.query as string);
  const rawUrl = (business.website_url as string | null)?.trim() ?? "";
  const domain = rawUrl ? domainOf(/^[a-z]+:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`) || null : null;
  const name = (business.name as string | null)?.trim() || domain || "this business";
  const language = contentLanguageName(business.content_language as string | null);

  try {
    const proposed = await runAgent(
      proposePromptsAgent,
      {
        business: {
          name,
          niche: (business.niche as string | null) ?? null,
          description: (business.description as string | null) ?? null,
          domain,
        },
        language,
        existing,
        keywords: (keywordRows ?? []).map((k) => (k.keyword as string).trim()).filter(Boolean),
        competitors: (competitorRows ?? []).map((c) => ({
          name: (c.name as string | null) ?? null,
          domain: c.domain as string,
        })),
      },
      { userId, businessId, language, runId: randomUUID(), budget: createBudget(SUGGEST_BUDGET_USD) },
      supabaseRecorder(input.admin())
    );

    const prompts = finalizeSuggestions(proposed.prompts, existing);
    return { ok: true, prompts, discarded: proposed.prompts.length - prompts.length };
  } catch (error) {
    const refused = await inRequestBillingRefusal(input.admin, error, input.source);
    if (refused) return refused;
    throw error;
  }
}

// ── Settings and runs ────────────────────────────────────────────────────────

/** Stores the site's AI Visibility settings, already validated (`AeoSettings`). */
export async function saveAeoSettings(input: {
  supabase: SupabaseClient;
  userId: string;
  businessId: string;
  settings: AeoSettings;
}): Promise<{ ok: true; settings: AeoSettings } | VisibilityFailure> {
  const { error } = await input.supabase
    .from("businesses")
    .update({ aeo_settings: input.settings })
    .eq("id", input.businessId)
    .eq("user_id", input.userId);
  if (error) return { ok: false, status: 500, error: error.message };
  return { ok: true, settings: input.settings };
}

/** What one run would ask, before anything is asked: the number a person agrees to pay for. */
export interface VisibilityRunPlan {
  settings: AeoSettings;
  /** Engines the platform has keys for. */
  configuredEngines: string[];
  /** The ones a run asks: the site's choice among the configured, or all of them. */
  engines: string[];
  /** Enabled prompts in the set. */
  enabledPrompts: number;
  /** Prompts a run asks: the enabled ones, up to `maxQueriesPerRun`. */
  prompts: number;
  /** Paid probes: prompts × engines. */
  probes: number;
}

/**
 * The plan the run's own first step makes (lib/jobs/workflows/aeo-run.ts):
 * the enabled prompts up to the per-run ceiling, times the engines the site
 * chose among those configured. Read through the caller's client.
 */
export async function planVisibilityRun(input: {
  supabase: SupabaseClient;
  userId: string;
  businessId: string;
  /** Settings about to be saved, to plan with them rather than the stored ones. */
  settings?: AeoSettings;
}): Promise<VisibilityRunPlan> {
  const [{ data: business }, { count }] = await Promise.all([
    input.settings
      ? Promise.resolve({ data: null })
      : input.supabase
          .from("businesses")
          .select("aeo_settings")
          .eq("id", input.businessId)
          .eq("user_id", input.userId)
          .maybeSingle(),
    input.supabase
      .from("aeo_queries")
      .select("id", { count: "exact", head: true })
      .eq("business_id", input.businessId)
      .eq("enabled", true),
  ]);
  const settings = input.settings ?? parseAeoSettings((business as Row | null)?.aeo_settings);
  const configuredEngines = getCitationProviders().map((p) => p.name);
  const engines = activeEngines(configuredEngines, settings);
  const enabledPrompts = count ?? 0;
  const prompts = Math.min(enabledPrompts, settings.maxQueriesPerRun);
  return { settings, configuredEngines, engines, enabledPrompts, prompts, probes: prompts * engines.length };
}

export type StartVisibilityRunResult =
  | { ok: true; alreadyRunning: true }
  | { ok: true; alreadyRunning: false; runId: string; jobId: string }
  | { ok: false; status: 409; code: "no_engine" | "no_queries"; error: string };

/**
 * "Run now": the same durable job as the scheduled run (`startRun`), unless
 * one is already running for the site. Refused when no engine is configured
 * or the set has no enabled prompt. The count goes through the caller's
 * client, so it is also the ownership check; the run row and the job are
 * the service role's to write.
 */
export async function startVisibilityRun(input: {
  supabase: SupabaseClient;
  admin: SupabaseClient;
  userId: string;
  businessId: string;
}): Promise<StartVisibilityRunResult> {
  if (getCitationProviders().length === 0) {
    return { ok: false, status: 409, code: "no_engine", error: "No answer engine is configured on this platform yet." };
  }

  const { count } = await input.supabase
    .from("aeo_queries")
    .select("id", { count: "exact", head: true })
    .eq("business_id", input.businessId)
    .eq("enabled", true);
  if ((count ?? 0) === 0) {
    return { ok: false, status: 409, code: "no_queries", error: "Add at least one prompt before running." };
  }

  if (await hasActiveRun(input.admin, input.businessId)) return { ok: true, alreadyRunning: true };

  const { runId, jobId } = await startRun({
    supabase: input.admin,
    userId: input.userId,
    businessId: input.businessId,
    trigger: "manual",
  });
  return { ok: true, alreadyRunning: false, runId, jobId };
}
