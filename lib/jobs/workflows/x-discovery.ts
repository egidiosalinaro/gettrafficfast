import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import { createBudget } from "@/lib/agents/contract";
import { runAgent, supabaseRecorder } from "@/lib/agents/runner";
import { placementQualifyAgent } from "@/lib/agents/placement-qualify";
import { draftCapacityDenial } from "@/lib/paid-access";
import { xApiClientFromEnv } from "@/lib/providers/x/api";
import { domainOf } from "@/lib/providers/serp/types";
import { topicsFor } from "@/lib/placements/expertise";
import { applyRuleRejections, applyVerdicts, loadRedditArchivedBelow, toThreads, type TargetRow } from "@/lib/placements/qualification";
import { startDraft } from "@/lib/placements/runs";
import { draftPrerequisite } from "@/lib/placements/workflow";
import { xNoiseRule } from "@/lib/placements/x-conversation";
import { X_SEARCH_SOURCE, searchXForBusiness } from "@/lib/placements/x-search";
import { excerptWithReferenced, isReadPost, loadReferenced } from "@/lib/placements/referenced";
import { parseVoiceSettings } from "@/lib/voice/settings";
import { StepIncomplete, type StepContext, type Workflow, type WorkflowStep } from "@/lib/jobs/types";
import {
  TARGET_COLUMNS,
  businessBrandNames,
  loadBusiness,
  loadExpertise,
  qualifyProgress,
} from "./placement-discovery";

/** The X pre-filter's shape rules, which a post quoting a post GTF read is spared. */
const QUOTE_SHAPE_RULES = new Set(["x_too_short", "x_link_share", "x_broadcast"]);

/**
 * The daily X search for one site, as a durable job
 * (docs/PLACEMENTS.md, "Fresh posts and reply numbers from the X API").
 *
 *   search   — up to three searches of X for posts of the last 12 hours on
 *              the site's topics, each under the platform's monthly cap
 *              (lib/placements/x-search.ts). Checkpointed: a resumed job
 *              never pays for its searches twice.
 *   rules    — the deterministic rules, then the X pre-filter (adverts,
 *              link shares, list dumps, statements to nobody), on what
 *              this search stored: rules only, before any paid judgement.
 *   qualify  — the qualifying agent, on the survivors, the way the weekly
 *              discovery judges its finds, under a small budget.
 *   draft    — drafts for the best qualified finds, at most five a run,
 *              through the same `startDraft` "Draft it" uses, so each one
 *              asks the daily draft cap and the About you prerequisite.
 *
 * Only on a site whose owner turned "Find posts on X" on, and only when the
 * platform has the X API on. Nothing is posted: a person replies through X's
 * own web intent, as with every other row.
 */

export const X_DISCOVERY = "x-post-discovery";

/** Rows the rules and the qualifier look at per run: what three searches can store. */
const MAX_ROWS = 60;
/** Rows the qualifier judges per run, and per call. */
const MAX_QUALIFY = 30;
const BATCH_SIZE = 10;
/** Model dollars per run for the judging. The budget throws rather than overspending. */
const QUALIFY_BUDGET_USD = 0.15;
/** Time a qualification batch is assumed to need before the deadline. */
const BATCH_TIME_MS = 25_000;
/** Drafts started per run: the best of the day, not every find. */
export const X_AUTO_DRAFTS_PER_RUN = 5;

function readInput(input: Record<string, unknown>): { businessId: string } {
  const businessId = typeof input.businessId === "string" ? input.businessId : "";
  if (!businessId) throw new Error(`${X_DISCOVERY} needs businessId`);
  return { businessId };
}

async function openFinds(supabase: SupabaseClient, businessId: string, status: string, now: Date, source: string): Promise<TargetRow[]> {
  const { data } = await supabase
    .from("placement_targets")
    .select(TARGET_COLUMNS)
    .eq("business_id", businessId)
    .eq("surface", "x")
    .eq("found_via", source)
    .eq("status", status)
    .gt("fresh_until", now.toISOString())
    .order("created_at", { ascending: false })
    .limit(MAX_ROWS);
  return ((data ?? []) as TargetRow[]).map((r) => ({ ...r, kind: r.kind || "post" }));
}

async function ruleContext(ctx: StepContext, business: { website_url: string | null }, businessId: string, now: Date) {
  const { keywords, entities } = await loadExpertise(ctx.supabase, businessId, 20);
  const own = business.website_url ? domainOf(business.website_url) : "";
  return {
    keywords,
    entities,
    rules: {
      now,
      ownDomains: own ? [own] : [],
      expertise: [...keywords, ...entities],
      redditArchivedBelow: await loadRedditArchivedBelow(ctx.supabase, now),
    },
  };
}

/**
 * The steps after a search, shared by every X search that stores rows with
 * its own `found_via` (the daily search, the close-accounts trial): the
 * rules and the X pre-filter, the qualifier, the drafts.
 */
export function xFindSteps(source: string): WorkflowStep[] {
  return [
    {
      name: "rules",
      async run(ctx) {
        const { businessId } = readInput(ctx.input);
        const business = await loadBusiness(ctx.supabase, businessId);
        if (!business) return { skipped: "business not found" };
        const now = new Date();
        const rows = await openFinds(ctx.supabase, businessId, "discovered", now, source);
        if (rows.length === 0) return { considered: 0, rejected: 0 };
        const { rules } = await ruleContext(ctx, business, businessId, now);
        // The shared rules, then the X pre-filter (adverts, link shares, list
        // dumps, statements to nobody): rules alone, before any paid judgement.
        // A drop is a stored rejection naming its rule, like every rules one.
        const language = business.content_language ?? "en";
        // A post that quotes a post GTF read is commentary on it ("The subtle
        // art of naming" over a listing): its own few words and the quote's
        // link are not a link share, a statement to nobody or too short. The
        // shape rules give way; the advert and list rules still hold, and the
        // qualifier reads the quote beside the post (referenced.ts).
        const referenced = await loadReferenced(ctx.supabase, businessId, rows.map((row) => row.id));
        const applied = await applyRuleRejections({
          supabase: ctx.supabase,
          rows,
          ctx: rules,
          extra: (row) => {
            const outcome = xNoiseRule(row, language);
            const quotes = isReadPost(referenced?.get(row.id)?.quoted);
            return outcome?.status === "rejected" && quotes && QUOTE_SHAPE_RULES.has(outcome.rule) ? null : outcome;
          },
        });
        console.log(
          JSON.stringify({
            ts: new Date().toISOString(),
            level: "info",
            event: "x_prefilter",
            business_id: businessId,
            considered: rows.length,
            passed: applied.survivors.length,
            by_rule: applied.byRule,
          })
        );
        return { considered: rows.length, rejected: applied.rejected, byRule: applied.byRule };
      },
    },
    {
      name: "qualify",
      async run(ctx) {
        const { businessId } = readInput(ctx.input);
        const business = await loadBusiness(ctx.supabase, businessId);
        if (!business) return { skipped: "business not found" };
        const now = new Date();
        const progress = await qualifyProgress(ctx.supabase, ctx.job.id);
        const cap = MAX_QUALIFY - progress.judged;
        const rows = (await openFinds(ctx.supabase, businessId, "discovered", now, source)).slice(0, Math.max(0, cap));
        if (rows.length === 0) return { judged: 0, qualified: 0, rejected: 0, undecided: 0 };

        const brandNames = businessBrandNames(business);
        const { keywords, entities } = await ruleContext(ctx, business, businessId, now);
        const agentCtx = {
          userId: business.user_id,
          businessId,
          jobId: ctx.job.id,
          language: business.content_language ?? "en",
          runId: randomUUID(),
          budget: createBudget(Math.max(0, QUALIFY_BUDGET_USD - progress.spentUsd)),
          signal: ctx.signal,
        };
        const recorder = supabaseRecorder(ctx.supabase);
        const totals = { judged: 0, qualified: 0, rejected: 0, undecided: 0 };
        const deadline = ctx.deadline ?? Date.now() + 120_000;

        for (let i = 0; i < rows.length; i += BATCH_SIZE) {
          if (deadline - Date.now() < BATCH_TIME_MS) throw new StepIncomplete(`${rows.length - i} posts still to judge`);
          const batch = rows.slice(i, i + BATCH_SIZE);
          // A post is judged with what it quotes and answers (referenced.ts):
          // "Naming is the hardest part of shipping" means nothing without its quote.
          const referenced = await loadReferenced(ctx.supabase, businessId, batch.map((row) => row.id));
          const judged = batch.map((row) => ({ ...row, excerpt: excerptWithReferenced(row.excerpt, referenced?.get(row.id) ?? null) }));
          const output = await runAgent(
            placementQualifyAgent,
            {
              business: { name: business.name ?? "the business", niche: business.niche, domain: business.website_url },
              mode: "judge",
              refusedAngles: [],
              expertise: topicsFor(keywords, entities, brandNames),
              aboutWriter: parseVoiceSettings(business.voice_settings).aboutYou,
              tier: "fast",
              language: agentCtx.language,
              threads: toThreads(judged, now),
            },
            agentCtx,
            recorder
          );
          const applied = await applyVerdicts({ supabase: ctx.supabase, rows: batch, verdicts: output.verdicts, now, brandNames });
          totals.judged += batch.length;
          totals.qualified += applied.qualified;
          totals.rejected += applied.rejected;
          totals.undecided += applied.undecided;
        }
        return totals;
      },
    },
    {
      name: "draft",
      async run(ctx) {
        const { businessId } = readInput(ctx.input);
        const business = await loadBusiness(ctx.supabase, businessId);
        if (!business) return { skipped: "business not found" };
        const voice = parseVoiceSettings(business.voice_settings);
        const prerequisite = draftPrerequisite(business.name ?? "the business", voice);
        if (prerequisite) return { started: 0, skipped: "About you is empty: drafts are refused until it says how you use the product" };

        const now = new Date();
        const { data } = await ctx.supabase
          .from("placement_targets")
          .select("id, qualify_score")
          .eq("business_id", businessId)
          .eq("surface", "x")
          .eq("found_via", source)
          .eq("status", "qualified")
          .gt("fresh_until", now.toISOString())
          .order("qualify_score", { ascending: false, nullsFirst: false })
          .limit(MAX_ROWS);
        const candidates = (data ?? []) as Array<{ id: string }>;
        if (candidates.length === 0) return { started: 0 };

        // A row that already has a draft (a person tapped Draft it) is left alone.
        const { data: drafted } = await ctx.supabase
          .from("placements")
          .select("target_id")
          .in("target_id", candidates.map((c) => c.id));
        const hasDraft = new Set(((drafted ?? []) as Array<{ target_id: string }>).map((r) => r.target_id));

        let started = 0;
        let capped = false;
        for (const candidate of candidates) {
          if (started >= X_AUTO_DRAFTS_PER_RUN) break;
          if (hasDraft.has(candidate.id)) continue;
          if (await draftCapacityDenial(ctx.supabase, business.user_id, now)) {
            capped = true;
            break;
          }
          const result = await startDraft({
            supabase: ctx.supabase,
            userId: business.user_id,
            businessId,
            targetId: candidate.id,
            scheduled: true,
          });
          if (result.jobId) started += 1;
        }
        return { started, ...(capped ? { skipped: "the daily draft limit is reached" } : {}) };
      },
    },
  ];
}

export const xDiscoveryWorkflow: Workflow = {
  type: X_DISCOVERY,
  steps: [
    {
      name: "search",
      async run(ctx) {
        const { businessId } = readInput(ctx.input);
        const business = await loadBusiness(ctx.supabase, businessId);
        if (!business) return { skipped: "business not found" };
        if (!parseVoiceSettings(business.voice_settings).findPostsOnX) return { skipped: "Find posts on X is off for this site" };
        const client = xApiClientFromEnv();
        if (!client) return { skipped: "the X API is not turned on for this deployment" };
        const { keywords, entities } = await loadExpertise(ctx.supabase, businessId, 20);
        const outcome = await searchXForBusiness({
          supabase: ctx.supabase,
          client,
          business,
          keywords,
          entities,
          brandNames: businessBrandNames(business),
          signal: ctx.signal,
        });
        return { ...outcome, notes: outcome.notes.slice(0, 10) };
      },
    },
    ...xFindSteps(X_SEARCH_SOURCE),
  ],
};
