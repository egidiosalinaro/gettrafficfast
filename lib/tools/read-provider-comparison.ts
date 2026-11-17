import { z } from "zod";
import {
  DEFAULT_COMPARISON_DAYS,
  loadProviderComparison,
  withoutCosts,
  MAX_COMPARISON_DAYS,
} from "@/lib/articles/provider-comparison";
import { defineTool } from "./tool";

/**
 * The article rotation as a tool: what each provider arm did on this site,
 * read through lib/articles/provider-comparison.ts, the function
 * `GET /api/articles/provider-comparison` calls.
 *
 * It answers counts and averages and names no winner. CLAUDE.md's rules for
 * measurements are in the schema: an average over nothing is null, a run
 * the fallback answered is counted apart and left out of the averages, the
 * audit score says who gave it, and `enoughSamples` says when there is too
 * little to read. Asks no model: free.
 */

const AgentView = z.object({
  agent: z.string().describe("The agent's name as agent_runs records it: serp-analysis, outline, writing, article-revision, aeo-audit, image-brief, video-select, knowledge-extract, internal-links."),
  samples: z.number().describe("Completed runs the arm's own provider answered. The averages are over these only."),
  fallbackRuns: z.number().describe("Completed runs the other provider answered (the arm's provider failed or its account refused). They measure the other provider and are in no average."),
  failedRuns: z.number().describe("Runs where nobody gave a usable answer; in no average."),
  unattributedRuns: z.number().describe("Completed runs with no record of who answered; in no average."),
  steppedDownRuns: z.number().describe("Among samples: the provider answered with a model further down its own chain."),
  avgDurationMs: z.number().nullable().describe("Milliseconds per sampled run. Null when samples is 0."),
  models: z.array(z.object({ model: z.string(), runs: z.number() })),
  enoughSamples: z.boolean(),
});

const ArmView = z.object({
  provider: z.string().describe("The arm: the provider every article agent asked first for these jobs."),
  enoughSamples: z.boolean().describe("False under 10 articles on this arm."),
  articles: z.object({
    count: z.number().describe("Production jobs that ended (settled, skipped or failed). A regenerated article counts once per job."),
    settled: z.number(),
    skipped: z.number().describe("The research said an article cannot rank; nothing was written."),
    failed: z.number(),
    skippedOrFailedRate: z.number().nullable(),
    neededRevisionRate: z.number().nullable().describe("Share of checked drafts where the gates or the audit found something to fix. The audit's part is the arm's own judgement."),
    needsReviewRate: z.number().nullable().describe("Share of settled articles that ended needs_review."),
    avgGateIssuesBeforeRevision: z.number().nullable().describe("Issues the deterministic gates raised on the first draft. Computed by code: the neutral yardstick."),
    avgWordCount: z.number().nullable(),
    auditScore: z.number().nullable().describe("Average audit score, given by the same provider that wrote the article. Not a neutral measure."),
    auditScoreSamples: z.number(),
    auditJudgedBySameProvider: z.literal(true),
  }),
  agents: z.array(AgentView),
  downstream: z.object({
    windowDays: z.number(),
    measuredArticles: z.number().describe("Articles whose first 28 days after publication are fully ingested from Search Console."),
    waitingArticles: z.number().describe("Published, but the 28 days are not over or not ingested yet."),
    excludedArticles: z.number().describe("Published, but regenerated after publication or refreshed inside the 28 days: the page is not this arm's draft."),
    impressions: z.number().nullable().describe("Search Console's count over the first 28 days, summed. Null when measuredArticles is 0."),
    clicks: z.number().nullable(),
    impressionsPerArticle: z.number().nullable(),
    clicksPerArticle: z.number().nullable(),
    averagePosition: z.number().nullable().describe("Weighted by impressions; null when no measured article was shown."),
  }),
});

export const compareArticleProviders = defineTool({
  name: "compare_article_providers",
  title: "Compare article providers",
  description:
    "The article rotation read back for this site: for each provider arm (the provider the article agents asked first on the day a job started), per agent the runs it answered, the runs the fallback answered instead (counted apart, in no average), duration per run; per arm the articles written, the share that needed a revision, ended needs_review, were skipped or failed, the deterministic gate issues before the revision, word count and the audit score; and Search Console's impressions, clicks and position over the first 28 days for the articles that have 28 days of data. Declares no winner. The audit score is given by the provider that wrote the article (auditJudgedBySameProvider), so it is not neutral. Null means not measured; enoughSamples is false under 10 articles per arm.",
  input: z.object({
    days: z
      .number()
      .int()
      .min(1)
      .max(MAX_COMPARISON_DAYS)
      .default(DEFAULT_COMPARISON_DAYS)
      .describe(`How far back to read production jobs, in days (${DEFAULT_COMPARISON_DAYS} by default, at most ${MAX_COMPARISON_DAYS}).`),
  }),
  output: z.object({
    minSamples: z.number(),
    enoughSamples: z.boolean().describe("True only when at least two arms have minSamples articles each."),
    auditJudgedBySameProvider: z.literal(true),
    arms: z.array(ArmView),
    notes: z.array(z.string()),
    window: z.object({
      days: z.number(),
      since: z.string(),
      jobsRead: z.number(),
      jobsWithArm: z.number().describe("Jobs that ran under a rotation; the others are in no arm."),
      truncated: z.boolean().describe("The window held more jobs than one answer reads; the newest were read."),
    }),
    rotation: z.object({
      configured: z.array(z.string()).nullable().describe("The rotation configured now; null when there is none."),
      today: z.string().nullable().describe("The arm a job starting now would get."),
    }),
  }),
  scope: "read",
  paid: false,
  async handler(ctx, input) {
    // No cost per run: what the platform pays is the owner's (lib/owner.ts).
    return withoutCosts(
      await loadProviderComparison({
        client: ctx.client,
        admin: ctx.admin(),
        businessId: ctx.businessId,
        days: input.days,
      })
    );
  },
});

export const PROVIDER_COMPARISON_TOOLS = [compareArticleProviders] as const;
