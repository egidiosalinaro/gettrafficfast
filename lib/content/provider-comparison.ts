/**
 * The article rotation, read back: what each provider arm did, agent by
 * agent and article by article (docs/CONTENT_PIPELINE.md, "The provider
 * rotation"). Pure: lib/articles/provider-comparison.ts reads the rows and
 * hands them over.
 *
 * It reports and does not judge. No field names a winner, and the rules of
 * CLAUDE.md for measurements hold throughout:
 *
 * - an average or a rate over nothing is `null`, never 0;
 * - a run the fallback answered is counted (`fallbackRuns`) and left out of
 *   every average of the arm it ran under, because it measures the other
 *   provider: a day the arm's account refused for billing shows up there;
 * - an arm with fewer than `MIN_SAMPLES` articles, or an agent with fewer
 *   runs, says `enoughSamples: false`;
 * - the audit score is given by the same provider that wrote the article
 *   that day (`auditJudgedBySameProvider`), so it is not a neutral measure.
 *   The count of deterministic gate issues before the revision is: code
 *   computes it, the same way on both arms.
 */

/** Below this many articles on an arm (or runs of an agent), nothing should be read into the numbers. */
export const MIN_SAMPLES = 10;

/** Search traffic is compared over the first 28 days after publication. */
export const DOWNSTREAM_WINDOW_DAYS = 28;

export interface ComparisonCall {
  provider: string | null;
  model: string | null;
  /** Not the model the tier is configured for: a step down the provider's chain, or the second provider. */
  fallback: boolean;
}

export interface ComparisonRun {
  jobId: string;
  agent: string;
  status: "completed" | "failed";
  /** Null when the run did not record a cost. */
  costUsd: number | null;
  latencyMs: number | null;
  /** Who answered each call; null when it was not recorded (a failed run, a row from before the column). */
  calls: ComparisonCall[] | null;
}

/**
 * How one production job ended:
 * - `settled`: a draft was validated and the article left `generating`;
 * - `skipped`: the research said an article cannot rank, nothing was written;
 * - `failed`: no usable draft (validation failed every attempt, or no provider answered);
 * - `unfinished`: still queued or running, or stopped for a reason that is not the providers' (a lapsed subscription).
 */
export type ComparisonOutcome = "settled" | "skipped" | "failed" | "unfinished";

export interface ComparisonJob {
  jobId: string;
  articleId: string | null;
  /** The arm stored by the job's `arm` step; null for a job that ran without a rotation. */
  arm: string | null;
  createdAt: string;
  outcome: ComparisonOutcome;
  /** How it settled; null when it did not, or when it was settled outside the `settle` step. */
  settledAs: "generated" | "needs_review" | null;
  /** Issues the deterministic gates raised on the first draft; null when no draft was validated. */
  gateIssuesBeforeRevision: number | null;
  /** Whether the gates or the audit found something to fix; null when the job never got that far. */
  revisionNeeded: boolean | null;
  /** Words in the draft that was kept. */
  wordCount: number | null;
  /** The audit's score of the draft that was kept; null when the audit did not run. */
  auditScore: number | null;
}

export interface ComparisonPublication {
  articleId: string;
  /** The day of the first successful delivery, YYYY-MM-DD. */
  publishedOn: string;
  /** The day the article was last rewritten by a refresh, if it was. */
  refreshedOn: string | null;
}

export interface ComparisonMetric {
  articleId: string;
  capturedOn: string;
  impressions: number;
  clicks: number;
  /** Search Console's average position that day; null when it gave none. */
  position: number | null;
}

export interface ComparisonInput {
  jobs: ComparisonJob[];
  runs: ComparisonRun[];
  publications: ComparisonPublication[];
  /** Search Console rows only. */
  metrics: ComparisonMetric[];
  /** The newest day Search Console was ingested through; null when it is not connected or never synced. */
  syncedThrough: string | null;
}

export interface AgentComparison {
  agent: string;
  /** Completed runs every call of which the arm's own provider answered. */
  samples: number;
  /** Completed runs the other provider answered, in whole or in part. Not in any average. */
  fallbackRuns: number;
  /** Runs that failed: nobody answered, or the answer was unusable. Cost unknown, not in any average. */
  failedRuns: number;
  /** Completed runs with no record of who answered. Not in any average. */
  unattributedRuns: number;
  /** Among `samples`, runs where the provider stepped down its own model chain. */
  steppedDownRuns: number;
  avgCostUsd: number | null;
  avgDurationMs: number | null;
  /** The models that answered the sampled runs, by first call. */
  models: { model: string; runs: number }[];
  enoughSamples: boolean;
}

export interface ArticlesComparison {
  /** Production jobs that ended: settled, skipped or failed. An article regenerated counts once per job. */
  count: number;
  settled: number;
  skipped: number;
  failed: number;
  /** (skipped + failed) / count. */
  skippedOrFailedRate: number | null;
  /** Among drafts that were checked: the share where the gates or the audit found something to fix. */
  neededRevisionRate: number | null;
  /** Among articles settled by the pipeline: the share that ended `needs_review`. */
  needsReviewRate: number | null;
  /** Computed by code, not by a model: the neutral yardstick. */
  avgGateIssuesBeforeRevision: number | null;
  avgWordCount: number | null;
  /** Average audit score, over the articles whose audit the arm's own provider answered. */
  auditScore: number | null;
  auditScoreSamples: number;
  /** The provider that wrote the article also scored it. Not a neutral measure. */
  auditJudgedBySameProvider: true;
}

export interface DownstreamComparison {
  windowDays: number;
  /** Articles of this arm whose first 28 days are fully ingested. */
  measuredArticles: number;
  /** Published articles of this arm still inside their first 28 days, or not ingested that far. */
  waitingArticles: number;
  /** Published articles left out: regenerated after publication or refreshed inside the window, so the page is not the arm's draft. */
  excludedArticles: number;
  impressions: number | null;
  clicks: number | null;
  impressionsPerArticle: number | null;
  clicksPerArticle: number | null;
  /** Weighted by impressions across the measured articles; null when none was shown. */
  averagePosition: number | null;
}

export interface ArmComparison {
  provider: string;
  enoughSamples: boolean;
  articles: ArticlesComparison;
  agents: AgentComparison[];
  downstream: DownstreamComparison;
}

export interface ProviderComparison {
  minSamples: number;
  /** True only when at least two arms have `minSamples` articles each. */
  enoughSamples: boolean;
  auditJudgedBySameProvider: true;
  arms: ArmComparison[];
  notes: string[];
}

export const COMPARISON_NOTES: readonly string[] = [
  "No winner is declared: these are counts and averages per provider arm, to be read by a person.",
  "A run answered by the fallback provider is counted in fallbackRuns and left out of the averages of the arm it ran under: it measures the other provider. Days when the arm's account refused for billing appear there.",
  "The audit score is given by the same provider that wrote the article that day, so it is not a neutral measure. avgGateIssuesBeforeRevision is computed by code and is.",
  "neededRevisionRate counts what the gates and the audit found; the audit's part is the arm's own judgement.",
  `With fewer than ${MIN_SAMPLES} articles on an arm, enoughSamples is false and the numbers describe too little to compare.`,
  `Search traffic is Search Console's, over the first ${DOWNSTREAM_WINDOW_DAYS} days after publication, only for articles whose ${DOWNSTREAM_WINDOW_DAYS} days are fully ingested; null means not measured, 0 means measured and not shown.`,
  "null means not measured; 0 means measured and zero.",
];

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function average(values: number[], digits: number): number | null {
  if (values.length === 0) return null;
  return round(values.reduce((sum, v) => sum + v, 0) / values.length, digits);
}

function rate(hits: number, of: number): number | null {
  return of === 0 ? null : round(hits / of, 4);
}

function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day.slice(0, 10)}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** How a completed run is counted on `arm`. */
function attributionOf(run: ComparisonRun, arm: string): "sample" | "fallback" | "unattributed" {
  if (!run.calls || run.calls.length === 0 || run.calls.some((call) => !call.provider)) return "unattributed";
  return run.calls.every((call) => call.provider === arm) ? "sample" : "fallback";
}

function compareAgents(runs: ComparisonRun[], arm: string): AgentComparison[] {
  const byAgent = new Map<string, ComparisonRun[]>();
  for (const run of runs) byAgent.set(run.agent, [...(byAgent.get(run.agent) ?? []), run]);

  return [...byAgent.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([agent, agentRuns]) => {
      const samples: ComparisonRun[] = [];
      let fallbackRuns = 0;
      let failedRuns = 0;
      let unattributedRuns = 0;
      for (const run of agentRuns) {
        if (run.status === "failed") {
          failedRuns++;
          continue;
        }
        const kind = attributionOf(run, arm);
        if (kind === "sample") samples.push(run);
        else if (kind === "fallback") fallbackRuns++;
        else unattributedRuns++;
      }

      const models = new Map<string, number>();
      for (const run of samples) {
        const model = run.calls?.[0]?.model ?? "unknown";
        models.set(model, (models.get(model) ?? 0) + 1);
      }

      return {
        agent,
        samples: samples.length,
        fallbackRuns,
        failedRuns,
        unattributedRuns,
        steppedDownRuns: samples.filter((run) => run.calls?.some((call) => call.fallback)).length,
        avgCostUsd: average(
          samples.flatMap((run) => (run.costUsd === null ? [] : [run.costUsd])),
          6
        ),
        avgDurationMs: average(
          samples.flatMap((run) => (run.latencyMs === null ? [] : [run.latencyMs])),
          0
        ),
        models: [...models.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([model, count]) => ({ model, runs: count })),
        enoughSamples: samples.length >= MIN_SAMPLES,
      };
    });
}

function compareArticles(jobs: ComparisonJob[], runsByJob: Map<string, ComparisonRun[]>, arm: string): ArticlesComparison {
  const ended = jobs.filter((job) => job.outcome !== "unfinished");
  const settled = ended.filter((job) => job.outcome === "settled");
  const skipped = ended.filter((job) => job.outcome === "skipped").length;
  const failed = ended.filter((job) => job.outcome === "failed").length;

  const checked = ended.filter((job) => job.revisionNeeded !== null);
  const settledByPipeline = settled.filter((job) => job.settledAs !== null);

  // The score counts only where the arm's own provider gave it: an audit the
  // fallback answered is the other provider's opinion.
  const scored = settled.filter((job) => {
    if (job.auditScore === null) return false;
    const audits = (runsByJob.get(job.jobId) ?? []).filter((run) => run.agent === AUDIT_AGENT && run.status === "completed");
    return audits.length > 0 && audits.every((run) => attributionOf(run, arm) === "sample");
  });

  const numbers = (pick: (job: ComparisonJob) => number | null, from: ComparisonJob[]) =>
    from.flatMap((job) => {
      const value = pick(job);
      return value === null ? [] : [value];
    });

  return {
    count: ended.length,
    settled: settled.length,
    skipped,
    failed,
    skippedOrFailedRate: rate(skipped + failed, ended.length),
    neededRevisionRate: rate(checked.filter((job) => job.revisionNeeded).length, checked.length),
    needsReviewRate: rate(
      settledByPipeline.filter((job) => job.settledAs === "needs_review").length,
      settledByPipeline.length
    ),
    avgGateIssuesBeforeRevision: average(numbers((job) => job.gateIssuesBeforeRevision, ended), 2),
    avgWordCount: average(numbers((job) => job.wordCount, settled), 0),
    auditScore: average(numbers((job) => job.auditScore, scored), 1),
    auditScoreSamples: scored.length,
    auditJudgedBySameProvider: true,
  };
}

/** The audit agent's name in `agent_runs` (lib/agents/aeo.ts). */
export const AUDIT_AGENT = "aeo-audit";

function compareDownstream(
  arm: string,
  latestSettled: Map<string, ComparisonJob>,
  input: ComparisonInput
): DownstreamComparison {
  const metricsByArticle = new Map<string, ComparisonMetric[]>();
  for (const metric of input.metrics) {
    metricsByArticle.set(metric.articleId, [...(metricsByArticle.get(metric.articleId) ?? []), metric]);
  }

  let measured = 0;
  let waiting = 0;
  let excluded = 0;
  let impressions = 0;
  let clicks = 0;
  let positionWeight = 0;
  let positionSum = 0;

  for (const publication of input.publications) {
    const job = latestSettled.get(publication.articleId);
    if (!job || job.arm !== arm) continue;

    const first = publication.publishedOn.slice(0, 10);
    const last = addDays(first, DOWNSTREAM_WINDOW_DAYS - 1);
    // The page must be this job's draft for the whole window.
    const regeneratedAfter = job.createdAt.slice(0, 10) > first;
    const refreshedInside = publication.refreshedOn !== null && publication.refreshedOn.slice(0, 10) <= last;
    if (regeneratedAfter || refreshedInside) {
      excluded++;
      continue;
    }
    if (!input.syncedThrough || input.syncedThrough.slice(0, 10) < last) {
      waiting++;
      continue;
    }

    measured++;
    for (const metric of metricsByArticle.get(publication.articleId) ?? []) {
      const day = metric.capturedOn.slice(0, 10);
      if (day < first || day > last) continue;
      impressions += metric.impressions;
      clicks += metric.clicks;
      if (metric.position !== null && metric.impressions > 0) {
        positionWeight += metric.impressions;
        positionSum += metric.position * metric.impressions;
      }
    }
  }

  return {
    windowDays: DOWNSTREAM_WINDOW_DAYS,
    measuredArticles: measured,
    waitingArticles: waiting,
    excludedArticles: excluded,
    impressions: measured === 0 ? null : impressions,
    clicks: measured === 0 ? null : clicks,
    impressionsPerArticle: measured === 0 ? null : round(impressions / measured, 1),
    clicksPerArticle: measured === 0 ? null : round(clicks / measured, 1),
    averagePosition: positionWeight === 0 ? null : round(positionSum / positionWeight, 1),
  };
}

export function compareProviders(input: ComparisonInput): ProviderComparison {
  const runsByJob = new Map<string, ComparisonRun[]>();
  for (const run of input.runs) runsByJob.set(run.jobId, [...(runsByJob.get(run.jobId) ?? []), run]);

  // The job whose draft an article carries: its latest settled one, with or
  // without an arm. An article last written without a rotation belongs to
  // no arm, whatever an earlier job was.
  const latestSettled = new Map<string, ComparisonJob>();
  for (const job of input.jobs) {
    if (job.outcome !== "settled" || !job.articleId) continue;
    const current = latestSettled.get(job.articleId);
    if (!current || job.createdAt > current.createdAt) latestSettled.set(job.articleId, job);
  }

  const providers = [...new Set(input.jobs.flatMap((job) => (job.arm ? [job.arm] : [])))].sort();

  const arms = providers.map((provider): ArmComparison => {
    const jobs = input.jobs.filter((job) => job.arm === provider);
    const runs = jobs.flatMap((job) => runsByJob.get(job.jobId) ?? []);
    const articles = compareArticles(jobs, runsByJob, provider);
    return {
      provider,
      enoughSamples: articles.count >= MIN_SAMPLES,
      articles,
      agents: compareAgents(runs, provider),
      downstream: compareDownstream(provider, latestSettled, input),
    };
  });

  return {
    minSamples: MIN_SAMPLES,
    enoughSamples: arms.length >= 2 && arms.every((arm) => arm.enoughSamples),
    auditJudgedBySameProvider: true,
    arms,
    notes: [...COMPARISON_NOTES],
  };
}
