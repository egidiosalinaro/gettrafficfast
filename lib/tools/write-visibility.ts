import { z } from "zod";
import {
  addPrompts,
  deletePrompt,
  importPromptsFromKeywords,
  planVisibilityRun,
  saveAeoSettings,
  startVisibilityRun,
  suggestPrompts,
  updatePrompt,
  type VisibilityRunPlan,
} from "@/lib/visibility/manage";
import { findPlacesFromRun } from "@/lib/visibility/places";
import { MAX_QUERIES_PER_BUSINESS, QueryInput } from "@/lib/visibility/queries";
import type { AeoQueryRecord } from "@/lib/visibility/read";
import { AEO_INTENTS, AeoSettings } from "@/lib/visibility/settings";
import { MAX_NEW_TARGETS_PER_RUN } from "@/lib/visibility/sources-to-targets";
import { JobView, readJob, runJobWithin, WaitSeconds } from "./jobs";
import { defineTool, ToolError } from "./tool";
import {
  changesOf,
  Confirm,
  libRefusal,
  partialOf,
  requireConfirmation,
  requireScopes,
  storedSettings,
  strictSettings,
} from "./write-guards";

/**
 * AI Visibility's writes as tools (`/growth/ai`, `/growth/ai/settings`). Each handler calls the
 * function the screen's route calls (lib/visibility/manage.ts).
 *
 * Two of them switch spending on, and say so before they do: a run asks
 * every prompt of the set to every engine, each a paid probe, and a cadence
 * does that on a schedule. Both answer `confirmation_required` with the
 * number of probes until they are sent again with `confirm: true`
 * (AGENTS.md §12: cost never switches itself on).
 */

const PromptId = z.string().uuid().describe("A prompt's id, from the site's prompt set.");

export const PromptRecord = z.object({
  id: z.string(),
  query: z.string(),
  cluster: z.string().nullable(),
  intent: z.string().nullable(),
  enabled: z.boolean(),
  source: z.string().describe("manual, keyword (imported) or suggested."),
  createdAt: z.string().nullable(),
});

/** A stored prompt in the declared shape. */
const toPrompt = (q: AeoQueryRecord): z.infer<typeof PromptRecord> => ({ ...q, createdAt: q.createdAt ?? null });

const Cluster = z.string().trim().max(60).nullable().describe("A group name for the prompt; null for none.");
const Intent = z.enum(AEO_INTENTS).nullable();

const Plan = z
  .object({
    engines: z.array(z.string()).describe("The answer engines a run asks."),
    prompts: z.number().describe("Enabled prompts a run asks, up to maxQueriesPerRun."),
    probes: z.number().describe("Probes per run (one question asked of one engine): prompts × engines."),
  })
  .describe("What one run asks, before anything is asked.");

const planOf = (plan: VisibilityRunPlan) => ({ engines: plan.engines, prompts: plan.prompts, probes: plan.probes });

const probesSentence = (plan: VisibilityRunPlan) =>
  `${plan.prompts} prompt${plan.prompts === 1 ? "" : "s"} × ${plan.engines.length} engine${plan.engines.length === 1 ? "" : "s"} (${plan.engines.join(", ") || "none"}) = ${plan.probes} probe${plan.probes === 1 ? "" : "s"}`;

// ── The prompt set ───────────────────────────────────────────────────────────

export const addPromptsTool = defineTool({
  name: "add_prompts",
  title: "Add prompts",
  description: `Adds prompts (questions a customer would ask an AI assistant) to this site's visibility set, all in one cluster if given. Wordings already in the set are counted, not added. A site holds at most ${MAX_QUERIES_PER_BUSINESS}. Nothing is asked until a run.`,
  input: z.object({
    queries: z.array(QueryInput.shape.query).min(1).max(MAX_QUERIES_PER_BUSINESS).describe("The prompts, 3 to 200 characters each."),
    cluster: Cluster.optional(),
    intent: Intent.optional(),
    source: z.enum(["manual", "keyword", "suggested"]).default("manual").describe("suggested when they came from suggest_prompts."),
  }),
  output: z.object({ added: z.number(), duplicates: z.number(), prompts: z.array(PromptRecord) }),
  scope: "write",
  paid: false,
  async handler(ctx, input) {
    const queries = input.queries.map((query) => QueryInput.parse({ query, cluster: input.cluster, intent: input.intent }));
    const result = await addPrompts({
      supabase: ctx.client,
      userId: ctx.userId,
      businessId: ctx.businessId,
      queries,
      source: input.source,
    });
    if (!result.ok) throw libRefusal(result);
    return { added: result.added, duplicates: result.duplicates, prompts: result.queries.map(toPrompt) };
  },
});

export const updatePromptTool = defineTool({
  name: "update_prompt",
  title: "Edit a prompt",
  description:
    "Changes one prompt of this site's set: its wording, cluster, intent, or whether runs ask it (enabled). Fields left out stay as they are. Runs before and after a wording change are not comparable over that prompt.",
  input: z.object({
    promptId: PromptId,
    query: QueryInput.shape.query.optional(),
    cluster: Cluster.optional(),
    intent: Intent.optional(),
    enabled: z.boolean().optional(),
  }),
  output: z.object({ prompt: PromptRecord }),
  scope: "write",
  paid: false,
  owns: { promptId: "aeo_queries" },
  async handler(ctx, input) {
    const result = await updatePrompt({
      supabase: ctx.client,
      userId: ctx.userId,
      businessId: ctx.businessId,
      id: input.promptId,
      patch: {
        query: input.query,
        cluster: input.cluster === undefined ? undefined : input.cluster || null,
        intent: input.intent,
        enabled: input.enabled,
      },
    });
    if (!result.ok) throw libRefusal(result);
    return { prompt: toPrompt(result.query) };
  },
});

export const deletePromptTool = defineTool({
  name: "delete_prompt",
  title: "Delete a prompt",
  description: "Takes one prompt out of this site's set. Its past probes keep their history; only the wording leaves the set.",
  input: z.object({ promptId: PromptId }),
  output: z.object({ deleted: z.number() }),
  scope: "write",
  paid: false,
  destructive: true,
  owns: { promptId: "aeo_queries" },
  async handler(ctx, input) {
    const result = await deletePrompt({ supabase: ctx.client, userId: ctx.userId, businessId: ctx.businessId, id: input.promptId });
    if (!result.ok) throw libRefusal(result);
    return { deleted: result.deleted };
  },
});

export const importPromptsFromKeywordsTool = defineTool({
  name: "import_prompts_from_keywords",
  title: "Import prompts from keywords",
  description:
    "Seeds this site's prompt set from its own keywords (the oldest 50): each keyword becomes one prompt, verbatim, in the keywords cluster. No model is asked. What would not fit under the cap is counted as skipped.",
  input: z.object({}),
  output: z.object({ added: z.number(), duplicates: z.number(), skipped: z.number() }),
  scope: "write",
  paid: false,
  async handler(ctx) {
    const result = await importPromptsFromKeywords({ supabase: ctx.client, userId: ctx.userId, businessId: ctx.businessId });
    if (!result.ok) throw libRefusal(result);
    return { added: result.added, duplicates: result.duplicates, skipped: result.skipped };
  },
});

export const suggestPromptsTool = defineTool({
  name: "suggest_prompts",
  title: "Suggest prompts",
  description:
    "Proposes prompts a founder's customers would ask an AI assistant, from this site's profile, keywords and competitors: one bounded model call. Nothing is saved; add the ones worth tracking with add_prompts (source: suggested).",
  input: z.object({}),
  output: z.object({
    prompts: z.array(
      z.object({ query: z.string(), cluster: z.string().nullable(), intent: z.string(), why: z.string().describe("Why it is worth asking.") })
    ),
    discarded: z.number().describe("Proposals dropped as keyword-like or already in the set."),
  }),
  scope: "write",
  paid: true,
  async handler(ctx) {
    const result = await suggestPrompts({
      supabase: ctx.client,
      admin: ctx.admin,
      userId: ctx.userId,
      businessId: ctx.businessId,
      source: "tool.suggest_prompts",
    });
    if (!result.ok) throw libRefusal(result);
    return { prompts: result.prompts, discarded: result.discarded };
  },
});

// ── Settings and runs ────────────────────────────────────────────────────────

const RUNS_PER_MONTH = { weekly: 4, monthly: 1 } as const;

export const updateVisibilitySettings = defineTool({
  name: "update_visibility_settings",
  title: "Change visibility settings",
  description:
    "Changes this site's AI Visibility settings: brand names and extra domains that count as the site being cited, which engines to ask (empty: every configured one), the cadence (off, weekly, monthly), the most prompts a run asks, and placesFromSources (after each run, pages the answers cited where the site was not become reply targets; on by default, no model, nothing drafted). Fields left out stay as they are. Turning a cadence on schedules runs that ask the engines on their own: it needs the spend scope and confirm: true, and without confirm answers confirmation_required with the probes per run.",
  input: z.object({ ...partialOf(AeoSettings.shape), confirm: Confirm }),
  output: z.object({ settings: AeoSettings, plan: Plan }),
  scope: "write",
  paid: false,
  async handler(ctx, input) {
    const stored = (await storedSettings(ctx)).aeo;
    const settings = strictSettings(AeoSettings, { ...stored, ...changesOf(input) });
    const plan = await planVisibilityRun({ supabase: ctx.client, userId: ctx.userId, businessId: ctx.businessId, settings });

    if (stored.cadence === "off" && settings.cadence !== "off") {
      requireScopes(ctx, ["spend"], "Turning on scheduled visibility runs");
      const perMonth = plan.probes * RUNS_PER_MONTH[settings.cadence];
      requireConfirmation(
        input.confirm,
        `A ${settings.cadence} cadence starts runs on a schedule: each run asks ${probesSentence(plan)}, about ${perMonth} a month.`,
        "Ask the person, then send the same call with confirm: true. cadence: off stops it."
      );
    }

    const saved = await saveAeoSettings({ supabase: ctx.client, userId: ctx.userId, businessId: ctx.businessId, settings });
    if (!saved.ok) throw libRefusal(saved);
    return { settings: saved.settings, plan: planOf(plan) };
  },
});

/** As long as the Run now route runs a run inline. */
const RUN_BUDGET_MS = 50_000;

export const runVisibilityCheck = defineTool({
  name: "run_visibility_check",
  title: "Run a visibility check",
  description:
    "Asks the answer engines this site's enabled prompts now, as Run now does, and records whether each answer cites the site: every prompt × engine pair is one probe. Without confirm: true it runs nothing and answers confirmation_required with the planned probe count. With it, answers with the run's job after up to waitSeconds; get_job says how it ended. Citations are sampled answers, not a ranking the engines publish.",
  input: z.object({ confirm: Confirm, waitSeconds: WaitSeconds }),
  output: z.object({
    runId: z.string().nullable(),
    jobId: z.string().nullable(),
    alreadyRunning: z.boolean(),
    status: z.string(),
    plan: Plan,
    job: JobView.nullable(),
  }),
  scope: "write",
  paid: true,
  async handler(ctx, input) {
    const plan = await planVisibilityRun({ supabase: ctx.client, userId: ctx.userId, businessId: ctx.businessId });
    if (plan.configuredEngines.length === 0) {
      throw new ToolError("unavailable", "No answer engine is configured on this platform yet.", 503);
    }
    if (plan.engines.length === 0) {
      throw new ToolError(
        "prerequisite_missing",
        "None of the engines this site's settings choose is configured on this platform.",
        409,
        `Choose among ${plan.configuredEngines.join(", ")} with update_visibility_settings (engines), or leave engines empty for all of them.`
      );
    }
    if (plan.prompts === 0) {
      throw new ToolError("prerequisite_missing", "Add at least one prompt before running.", 409, "add_prompts, or import_prompts_from_keywords.");
    }
    requireConfirmation(
      input.confirm,
      `This run asks ${probesSentence(plan)}.`,
      "Ask the person, then send the same call with confirm: true to run it."
    );

    const admin = ctx.admin();
    const started = await startVisibilityRun({ supabase: ctx.client, admin, userId: ctx.userId, businessId: ctx.businessId });
    if (!started.ok) {
      throw started.code === "no_engine"
        ? new ToolError("unavailable", started.error, 503)
        : new ToolError("prerequisite_missing", started.error, 409);
    }

    let runId: string | null = null;
    let jobId: string | null = null;
    if (started.alreadyRunning) {
      // Follow the run already going rather than start a second one.
      const { data } = await admin
        .from("aeo_runs")
        .select("id, job_id")
        .eq("business_id", ctx.businessId)
        .eq("user_id", ctx.userId)
        .eq("status", "running")
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      runId = (data?.id as string | undefined) ?? null;
      jobId = (data?.job_id as string | undefined) ?? null;
    } else {
      runId = started.runId;
      jobId = started.jobId;
      await runJobWithin(admin, jobId, { budgetMs: RUN_BUDGET_MS, waitMs: input.waitSeconds * 1000 });
    }

    const job = jobId ? await readJob(ctx.client, ctx.businessId, jobId) : null;
    return {
      runId,
      jobId,
      alreadyRunning: started.alreadyRunning,
      status: job?.status ?? "running",
      plan: planOf(plan),
      job,
    };
  },
});

export const findPlacesFromLastRun = defineTool({
  name: "find_places_from_last_run",
  title: "Find places from the last run",
  description: `Turns the sources this site's latest finished visibility run recorded into reply targets: pages an answer engine cited for one of the site's prompts in an answer that did not cite the site, where a person can take part (a thread, a post, an issue, an awesome-list) or ask to be listed (a "best X tools" article, kind listicle, which takes no draft). Own and competitor pages are left out. The stored probes are read: no engine or model is asked. At most ${MAX_NEW_TARGETS_PER_RUN} new targets per call, the most cited first; calling again takes the next ones. A page already in the inbox is never duplicated. Every run already does this as its last step while placesFromSources is on (the default); call this to do it by hand, for a latest run that finished with it off, or to take the pages a run left past the cap. Sampled: a citation is one answer on one day, per engine, not a promise the engine reads the page. Nothing is drafted or sent.`,
  input: z.object({}),
  output: z.object({
    runId: z.string().describe("The run whose answers were read."),
    candidates: z.number().describe("Distinct pages that are places, before the cap."),
    created: z.number().describe("New targets in the reply inbox."),
    linked: z.number().describe("Targets the inbox already held, now carrying this run's citation."),
    deferred: z.number().describe("New pages past the cap, left for the next call."),
    dropped: z
      .object({ own_site: z.number(), competitor: z.number(), not_a_place: z.number(), unread: z.number() })
      .describe("Distinct cited pages left out: the site's own, a known competitor's, a page with nowhere to take part, and sources that could not be read back to a page."),
    rejected: z.record(z.string(), z.number()).describe("Places an inbox rule turned down, by rule (archived, not_public, promotional, …)."),
    targets: z.array(
      z.object({
        id: z.string(),
        surface: z.string(),
        kind: z.string().describe("listicle: ask the author to be listed; anything else takes a reply."),
        url: z.string(),
        title: z.string(),
        prompt: z.string().describe("The first prompt whose sampled answer cited the page."),
        engines: z.array(z.string()).describe("The engines whose answer to that prompt cited it."),
      })
    ),
  }),
  scope: "write",
  paid: false,
  async handler(ctx) {
    const result = await findPlacesFromRun({
      supabase: ctx.client,
      admin: ctx.admin(),
      userId: ctx.userId,
      businessId: ctx.businessId,
    });
    if (!result.ok) {
      throw result.code === "no_run"
        ? new ToolError("prerequisite_missing", result.error, 409, "run_visibility_check, then call this again.")
        : new ToolError("not_found", "This site is no longer on the account.", 404);
    }
    // The output schema keeps the declared fields and drops `ok`.
    return result;
  },
});

export const WRITE_VISIBILITY_TOOLS = [
  addPromptsTool,
  updatePromptTool,
  deletePromptTool,
  importPromptsFromKeywordsTool,
  suggestPromptsTool,
  updateVisibilitySettings,
  runVisibilityCheck,
  findPlacesFromLastRun,
] as const;
