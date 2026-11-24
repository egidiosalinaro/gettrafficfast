import { z } from "zod";
import {
  activeEngines,
  listQueries,
  listRuns,
  loadOverview,
  loadQueryDetail,
  loadVisibilitySettings,
  MAX_RUNS,
} from "@/lib/visibility/read";
import { AeoSettings } from "@/lib/visibility/settings";
import { describeVisibility, SAMPLE_LINE } from "@/lib/visibility/summary";
import { defineTool, ToolError } from "./tool";

/**
 * AI Visibility (`/growth/ai`) as tools: the dashboard, the prompt set,
 * one prompt's history, the runs and the settings. Every handler calls the
 * function the screens read with (lib/visibility/read.ts), so an agent and
 * the dashboard cannot read a different number from the same probes.
 *
 * The numbers are measurements and are labelled as what they are: rates are
 * per engine and never averaged across engines, null means "not measured"
 * (never 0, which means "asked and not cited"), and every answer says it is
 * a sample: each prompt asked once per engine per run, not every AI answer.
 * Reading asks no engine; only a run (not a tool here) does. No output
 * carries what a run cost the platform: that is the owner's, never the
 * customer's (owner's decision, 2026-11-14).
 */

const SAMPLED = {
  sampled: z.literal(true).describe("Citation data is sampled, not ground truth: no answer engine reports whether it cited you."),
  sampleNote: z.string(),
};
const sampled = { sampled: true as const, sampleNote: SAMPLE_LINE };

const Rate = z.number().nullable().describe("A share from 0 to 1, or null when nothing was measured. 0 means asked and not cited.");

const RunView = z.object({
  id: z.string(),
  status: z.string().describe("running, completed or failed."),
  trigger: z.string().describe("manual or schedule."),
  engines: z.array(z.string()),
  queryCount: z.number(),
  queryFingerprint: z.string().nullable(),
  plannedProbes: z.number(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  error: z.string().nullable(),
});

const EngineSummaryView = z.object({
  engine: z.string(),
  planned: z.number(),
  valid: z.number().describe("Probes with a readable answer: the rate's denominator."),
  cited: z.number(),
  mentioned: z.number().describe("Answers that named the brand without citing a page; never counted as cited."),
  invalid: z.number(),
  errors: z.number(),
  pending: z.number(),
  rate: Rate,
  coverage: Rate.describe("valid / planned, or null when nothing was planned."),
});

const RunSummaryView = z.object({
  runId: z.string(),
  engines: z.array(EngineSummaryView).describe("One entry per engine. There is deliberately no rate across engines."),
  planned: z.number(),
  valid: z.number(),
  cited: z.number(),
  invalid: z.number(),
  errors: z.number(),
  pending: z.number(),
  queriesMeasured: z.number(),
  queriesCited: z.number().describe("Prompts cited by at least one engine. A count, never a rate."),
});

const ComparisonView = z.object({
  previousRunId: z.string().nullable(),
  comparable: z.boolean().describe("False when the prompts or engines changed, or the previous run did not finish: no trend then."),
  reasons: z.array(z.string()),
  byEngine: z.array(
    z.object({
      engine: z.string(),
      rate: Rate,
      previousRate: Rate,
      previousCited: z.number().nullable().describe("The previous rate's cited answers; null with no previous run for this engine."),
      previousValid: z.number().nullable().describe("The previous rate's readable answers, its denominator; null with no previous run for this engine."),
      delta: z.number().nullable().describe("Percentage points; null unless both rates exist and the runs are comparable."),
    })
  ),
});

const Source = z.object({ url: z.string(), domain: z.string(), title: z.string() });
const Competitor = z.object({ domain: z.string(), name: z.string().nullable(), via: z.string() });
const RecurringDomainView = z.object({
  domain: z.string(),
  name: z.string().nullable(),
  count: z.number(),
  asSource: z.number(),
  asMention: z.number(),
});
const RecurringSourceView = z.object({ domain: z.string(), count: z.number(), url: z.string(), title: z.string() });

const ProbeFields = {
  queryId: z.string().nullable(),
  query: z.string(),
  cluster: z.string().nullable(),
  engine: z.string(),
  model: z.string().nullable(),
  status: z.string().describe("cited, not_cited, invalid (no readable answer), error or pending."),
  mentioned: z.boolean().nullable(),
  sourceUrl: z.string().nullable().describe("The site's page the engine cited."),
  position: z.number().nullable(),
  answerExcerpt: z.string().nullable().describe("An excerpt of the answer, never the whole of it."),
  sources: z.array(Source),
  competitors: z.array(Competitor),
  error: z.string().nullable(),
  latencyMs: z.number().nullable(),
  checkedAt: z.string().nullable(),
};

const QueryRowView = z.object({
  probeId: z.string(),
  ...ProbeFields,
  previousStatus: z.string().nullable(),
  change: z.string().describe("gained, lost, same, new or unknown, against the previous comparable run."),
});

const ProbeView = z.object({
  id: z.string(),
  runId: z.string(),
  ...ProbeFields,
  probeVersion: z.number(),
});

const PromptView = z.object({
  id: z.string(),
  query: z.string().describe("The prompt, verbatim."),
  cluster: z.string().nullable(),
  intent: z.string().nullable(),
  enabled: z.boolean().describe("Only enabled prompts are asked in a run."),
  source: z.string().describe("manual, keyword or suggested."),
  createdAt: z.string(),
});

const Identity = z.object({
  domains: z.array(z.string()).describe("What counts as this site being cited: its own domain, then the listed ones."),
  brandNames: z.array(z.string()),
});

export const getVisibilityOverview = defineTool({
  name: "get_visibility_overview",
  title: "Get AI visibility",
  description:
    "The AI Visibility dashboard: whether answer engines cited this site on its prompts in the latest run, per engine (rate null = not measured, 0 = asked and not cited; never averaged across engines), the comparison with the previous run when it is comparable, the domains cited instead, and the recent runs. The data is sampled: each prompt asked once per engine per run. includeRows adds one row per prompt and engine of the latest run.",
  input: z.object({ includeRows: z.boolean().default(false) }),
  output: z.object({
    business: z.object({ name: z.string().nullable(), websiteUrl: z.string().nullable() }),
    identity: Identity,
    settings: AeoSettings,
    configuredEngines: z.array(z.string()).describe("Engines the platform can ask."),
    activeEngines: z.array(z.string()).describe("Engines a run asks: the configured ones this site selected."),
    prompts: z.object({ total: z.number(), enabled: z.number(), clusters: z.array(z.string()) }),
    latestRun: RunView.nullable(),
    lastError: z.string().nullable().describe("A newer run that failed before asking anything."),
    lead: z
      .object({ answer: z.string(), instead: z.string().nullable(), note: z.string().nullable() })
      .nullable()
      .describe("The dashboard's lead sentences, one per engine."),
    summary: RunSummaryView.nullable(),
    comparison: ComparisonView.nullable(),
    competitors: z.array(RecurringDomainView),
    sources: z.array(RecurringSourceView),
    runs: z.array(RunView),
    rows: z.array(QueryRowView).nullable().describe("Set when includeRows is true."),
    ...SAMPLED,
  }),
  scope: "read",
  paid: false,
  async handler(ctx, input) {
    const o = await loadOverview(ctx.client, ctx.businessId);
    const lead =
      o.summary && o.comparison
        ? describeVisibility({
            subject: o.identity.domains[0] ?? "you",
            summary: o.summary,
            comparison: o.comparison,
            competitors: o.competitors,
          })
        : null;
    return {
      business: o.business,
      identity: o.identity,
      settings: o.settings,
      configuredEngines: o.configuredEngines,
      activeEngines: o.activeEngines,
      prompts: o.queries,
      latestRun: o.latestRun,
      lastError: o.lastError,
      lead,
      summary: o.summary,
      comparison: o.comparison,
      competitors: o.competitors,
      sources: o.sources,
      runs: o.runs,
      rows: input.includeRows ? o.rows : null,
      ...sampled,
    };
  },
});

export const listPrompts = defineTool({
  name: "list_prompts",
  title: "List prompts",
  description:
    "The questions this site's AI visibility is measured on (the prompt set), by cluster: each with its wording, intent, whether it is asked in runs, and where it came from. get_prompt_history reads one prompt's results.",
  input: z.object({}),
  output: z.object({ prompts: z.array(PromptView), total: z.number(), enabled: z.number() }),
  scope: "read",
  paid: false,
  async handler(ctx) {
    const listed = await listQueries(ctx.client, ctx.businessId);
    if (!listed.ok) throw new Error(`prompts: ${listed.error}`);
    return {
      prompts: listed.queries,
      total: listed.queries.length,
      enabled: listed.queries.filter((q) => q.enabled).length,
    };
  },
});

export const getPromptHistory = defineTool({
  name: "get_prompt_history",
  title: "Get a prompt's history",
  description:
    "One prompt's results over time, per engine (rate null = not measured; never averaged across engines): every probe newest first with the answer's excerpt and sources, the domains that keep being cited, this site's articles that answer it, and the replies posted for it. Sampled: each probe is one answer on one day.",
  input: z.object({ queryId: z.string().uuid().describe("A prompt's id, from list_prompts.") }),
  output: z.object({
    prompt: PromptView,
    history: z.array(
      z.object({
        engine: z.string(),
        points: z.array(
          z.object({
            runId: z.string(),
            checkedAt: z.string().nullable(),
            status: z.string(),
            position: z.number().nullable(),
            mentioned: z.boolean().nullable(),
          })
        ),
        rate: Rate,
        valid: z.number(),
        cited: z.number(),
      })
    ),
    probes: z.array(ProbeView),
    competitors: z.array(RecurringDomainView),
    sources: z.array(RecurringSourceView),
    articles: z.array(
      z.object({
        id: z.string(),
        title: z.string().nullable(),
        keyword: z.string(),
        publishedUrl: z.string().nullable(),
        status: z.string(),
        via: z.enum(["keyword", "cited"]).describe("keyword: written for this prompt; cited: an engine cited it for this prompt."),
      })
    ),
    placements: z.array(
      z.object({
        id: z.string(),
        surface: z.string(),
        title: z.string(),
        url: z.string(),
        status: z.string(),
        publishedUrl: z.string().nullable(),
        publishedAt: z.string().nullable(),
      })
    ),
    ...SAMPLED,
  }),
  scope: "read",
  paid: false,
  owns: { queryId: "aeo_queries" },
  async handler(ctx, input) {
    const detail = await loadQueryDetail(ctx.client, ctx.businessId, input.queryId);
    if (!detail) throw new ToolError("not_found", "No prompt with that queryId on this site.", 404);
    const { query, ...rest } = detail;
    return { prompt: query, ...rest, ...sampled };
  },
});

export const listVisibilityRuns = defineTool({
  name: "list_visibility_runs",
  title: "List visibility runs",
  description:
    "The site's AI visibility runs, newest first: when, manual or scheduled, status, engines, how many prompts and probes, and why it failed when it did. get_visibility_overview reads the latest one's results.",
  input: z.object({ limit: z.number().int().min(1).max(MAX_RUNS).default(12) }),
  output: z.object({ runs: z.array(RunView) }),
  scope: "read",
  paid: false,
  async handler(ctx, input) {
    return { runs: await listRuns(ctx.client, ctx.businessId, input.limit) };
  },
});

export const getVisibilitySettings = defineTool({
  name: "get_visibility_settings",
  title: "Get visibility settings",
  description:
    "Settings → AI Visibility: what counts as this site (domains and brand names), which engines a run asks (empty = every configured one), how often runs happen (weekly by default; off only when the person chose it), and the most prompts a run asks.",
  input: z.object({}),
  output: z.object({
    settings: AeoSettings,
    identity: Identity,
    configuredEngines: z.array(z.string()),
    activeEngines: z.array(z.string()),
    business: z.object({ name: z.string().nullable(), websiteUrl: z.string().nullable() }),
  }),
  scope: "read",
  paid: false,
  async handler(ctx) {
    const view = await loadVisibilitySettings(ctx.client, ctx.userId, ctx.businessId);
    if (!view) throw new ToolError("not_found", "This site is no longer part of the account.", 404);
    return {
      settings: view.settings,
      identity: view.identity,
      configuredEngines: view.configuredEngines,
      activeEngines: activeEngines(view.configuredEngines, view.settings),
      business: {
        name: (view.business.name as string | null) ?? null,
        websiteUrl: (view.business.websiteUrl as string | null) ?? null,
      },
    };
  },
});

export const VISIBILITY_READ_TOOLS = [
  getVisibilityOverview,
  listPrompts,
  getPromptHistory,
  listVisibilityRuns,
  getVisibilitySettings,
] as const;
