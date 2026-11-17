import type { CitationSource } from "@/lib/providers/citations/types";
import type { CompetitorSighting } from "./verdict";

/**
 * Turning stored probes into what the dashboard shows. Every function here is
 * pure and every one has the same job as lib/lifecycle/results.ts: keep "we
 * have not measured this" distinguishable from "we measured it and the answer
 * is no". Rates are per engine and null over nothing; runs are compared only
 * when they asked the same questions of the same engines, and the UI is told
 * when they did not.
 */

export type ProbeState = "pending" | "cited" | "not_cited" | "invalid" | "error";

export interface ProbeRecord {
  id: string;
  runId: string;
  queryId: string | null;
  query: string;
  cluster: string | null;
  engine: string;
  model: string | null;
  status: ProbeState;
  cited: boolean | null;
  sourceUrl: string | null;
  position: number | null;
  mentioned: boolean | null;
  answerExcerpt: string | null;
  sources: CitationSource[];
  competitors: CompetitorSighting[];
  error: string | null;
  latencyMs: number | null;
  probeVersion: number;
  checkedAt: string | null;
}

export interface RunRecord {
  id: string;
  status: "running" | "completed" | "failed";
  trigger: "manual" | "schedule";
  engines: string[];
  queryCount: number;
  queryFingerprint: string | null;
  plannedProbes: number;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

export interface EngineSummary {
  engine: string;
  planned: number;
  /** Probes with a readable answer: cited + not cited. The rate's denominator. */
  valid: number;
  cited: number;
  mentioned: number;
  invalid: number;
  errors: number;
  pending: number;
  /** cited / valid, or null when nothing valid was measured. Never 0 for "unmeasured". */
  rate: number | null;
  /** valid / planned, or null when nothing was planned. */
  coverage: number | null;
}

export interface RunSummary {
  runId: string;
  engines: EngineSummary[];
  planned: number;
  valid: number;
  cited: number;
  invalid: number;
  errors: number;
  pending: number;
  /** Distinct queries with at least one valid probe. */
  queriesMeasured: number;
  /** Distinct queries cited by at least one engine. A count, never a rate. */
  queriesCited: number;
}

function emptyEngine(engine: string): EngineSummary {
  return {
    engine,
    planned: 0,
    valid: 0,
    cited: 0,
    mentioned: 0,
    invalid: 0,
    errors: 0,
    pending: 0,
    rate: null,
    coverage: null,
  };
}

export function summarizeRun(run: Pick<RunRecord, "id">, probes: ProbeRecord[]): RunSummary {
  const engines = new Map<string, EngineSummary>();
  const measuredQueries = new Set<string>();
  const citedQueries = new Set<string>();

  for (const probe of probes) {
    const bucket = engines.get(probe.engine) ?? emptyEngine(probe.engine);
    bucket.planned += 1;
    switch (probe.status) {
      case "cited":
        bucket.valid += 1;
        bucket.cited += 1;
        measuredQueries.add(probe.query);
        citedQueries.add(probe.query);
        break;
      case "not_cited":
        bucket.valid += 1;
        measuredQueries.add(probe.query);
        break;
      case "invalid":
        bucket.invalid += 1;
        break;
      case "error":
        bucket.errors += 1;
        break;
      default:
        bucket.pending += 1;
    }
    if (probe.mentioned) bucket.mentioned += 1;
    engines.set(probe.engine, bucket);
  }

  const list = [...engines.values()]
    .map((e) => ({
      ...e,
      rate: e.valid === 0 ? null : e.cited / e.valid,
      coverage: e.planned === 0 ? null : e.valid / e.planned,
    }))
    .sort((a, b) => a.engine.localeCompare(b.engine));

  const sum = (key: keyof Pick<EngineSummary, "planned" | "valid" | "cited" | "invalid" | "errors" | "pending">) =>
    list.reduce((acc, e) => acc + e[key], 0);

  return {
    runId: run.id,
    engines: list,
    planned: sum("planned"),
    valid: sum("valid"),
    cited: sum("cited"),
    invalid: sum("invalid"),
    errors: sum("errors"),
    pending: sum("pending"),
    queriesMeasured: measuredQueries.size,
    queriesCited: citedQueries.size,
  };
}

export interface EngineTrend {
  engine: string;
  rate: number | null;
  previousRate: number | null;
  /**
   * The previous rate's own counts: cited answers over readable ones. Null
   * with no previous run, or when it did not ask this engine. A rate is shown
   * as a count below `MIN_PROBES_FOR_PERCENT` (lib/format.ts), so the screen
   * needs them to say "last run 1 of 3" rather than "last run 33%".
   */
  previousCited: number | null;
  previousValid: number | null;
  /** Percentage points, positive when up. Null unless both rates exist AND the runs are comparable. */
  delta: number | null;
}

export interface RunComparison {
  previousRunId: string | null;
  comparable: boolean;
  /** Human-readable reasons the runs must not be read as a trend. */
  reasons: string[];
  byEngine: EngineTrend[];
}

export const SAMPLE_LINE =
  "Each prompt was asked once, on the prompts you set. Not every AI answer.";

export interface VisibilityLead {
  /** Did they cite this site? One sentence per engine, never an average. */
  answer: string;
  /** Who the engines cited when this site was not, or null when there is nothing to name. */
  instead: string | null;
  /** Why no up/down is drawn, or null when a trend is shown or there is no previous run. */
  note: string | null;
}

/**
 * The sentence the dashboard leads with.
 *
 * The rates stay per engine and a missing rate stays missing. A changed
 * prompt list withholds the arrow and says so in the note; it does not
 * replace the answer with the reason.
 */
export function describeVisibility(input: {
  subject: string;
  summary: RunSummary;
  comparison: RunComparison;
  competitors: RecurringDomain[];
}): VisibilityLead {
  const subject = input.subject.trim() || "you";
  const engines = input.summary.engines;
  const answer =
    engines.length === 0
      ? "This run asked nothing, so nothing was measured."
      : engines.map((engine) => engineSentence(engine, subject)).join(" ");

  const measured = engines.some((engine) => engine.valid > 0);
  const fullyCited = measured && engines.every((engine) => engine.valid === 0 || engine.cited === engine.valid);
  const top = fullyCited ? [] : input.competitors.slice(0, 3).map((c) => c.name ?? c.domain);

  return {
    answer,
    instead: citedInstead(top),
    note: comparisonNote(input.comparison),
  };
}

function engineSentence(engine: EngineSummary, subject: string): string {
  const name = engine.engine ? engine.engine.charAt(0).toUpperCase() + engine.engine.slice(1) : "The engine";
  if (engine.valid === 0) {
    return `${name} returned no readable answer, so nothing was measured for it.`;
  }
  const mention =
    engine.mentioned > 0
      ? ` It named ${subject} in ${engine.mentioned === 1 ? "one answer" : `${engine.mentioned} answers`} without citing a page.`
      : "";
  if (engine.cited === 0) {
    const where = engine.valid === 1 ? "on the one prompt it answered" : `on any of the ${engine.valid} prompts it answered`;
    return `${name} did not cite ${subject} ${where}.${mention}`;
  }
  if (engine.cited === engine.valid) {
    const where = engine.valid === 1 ? "on the one prompt it answered" : `on all ${engine.valid} prompts it answered`;
    return `${name} cited ${subject} ${where}.${mention}`;
  }
  return `${name} cited ${subject} on ${engine.cited} of ${engine.valid} prompts it answered.${mention}`;
}

function citedInstead(names: string[]): string | null {
  if (names.length === 0) return null;
  if (names.length === 1) return `Cited instead, most often: ${names[0]}.`;
  if (names.length === 2) return `Cited instead, most often: ${names[0]} and ${names[1]}.`;
  return `Cited instead, most often: ${names[0]}, ${names[1]} and ${names[2]}.`;
}

function comparisonNote(comparison: RunComparison): string | null {
  if (!comparison.previousRunId || comparison.comparable) return null;
  const parts = comparison.reasons.map((reason) => {
    if (/query set changed/i.test(reason)) {
      return "The prompt list changed since the last run, so this is not shown as up or down.";
    }
    if (/engines/i.test(reason)) {
      return "Different engines were asked last time, so the two results are not a trend.";
    }
    if (/did not finish/i.test(reason)) {
      return "The previous run did not finish, so it is not used as a trend.";
    }
    return reason;
  });
  return parts.join(" ");
}

/**
 * Whether the previous run can be read as a baseline for this one.
 *
 * Only over the same question set (fingerprint) and the same engines, and
 * only if the previous run finished: a half-run has a rate over a biased
 * subset. When any of that differs the rates are still shown side by side,
 * but no delta is computed and the reasons are spelled out.
 */
export function compareRuns(
  current: { run: RunRecord; summary: RunSummary },
  previous: { run: RunRecord; summary: RunSummary } | null
): RunComparison {
  if (!previous) {
    return {
      previousRunId: null,
      comparable: false,
      reasons: ["No previous run to compare with."],
      byEngine: current.summary.engines.map((e) => ({
        engine: e.engine,
        rate: e.rate,
        previousRate: null,
        previousCited: null,
        previousValid: null,
        delta: null,
      })),
    };
  }

  const reasons: string[] = [];
  if (previous.run.status !== "completed") {
    reasons.push("The previous run did not finish, so its rate covers a partial set.");
  }
  if (
    !current.run.queryFingerprint ||
    !previous.run.queryFingerprint ||
    current.run.queryFingerprint !== previous.run.queryFingerprint
  ) {
    reasons.push("The query set changed between the two runs.");
  }
  const engineKey = (engines: string[]) => [...engines].sort().join(",");
  if (engineKey(current.run.engines) !== engineKey(previous.run.engines)) {
    reasons.push("The engines asked changed between the two runs.");
  }

  const comparable = reasons.length === 0;
  const previousByEngine = new Map(previous.summary.engines.map((e) => [e.engine, e]));

  return {
    previousRunId: previous.run.id,
    comparable,
    reasons,
    byEngine: current.summary.engines.map((e) => {
      const before = previousByEngine.get(e.engine);
      const previousRate = before?.rate ?? null;
      return {
        engine: e.engine,
        rate: e.rate,
        previousRate,
        previousCited: before?.cited ?? null,
        previousValid: before?.valid ?? null,
        delta:
          comparable && e.rate !== null && previousRate !== null
            ? Math.round((e.rate - previousRate) * 100)
            : null,
      };
    }),
  };
}

export type ProbeChange = "gained" | "lost" | "same" | "new" | "unknown";

export interface QueryRow {
  probeId: string;
  queryId: string | null;
  query: string;
  cluster: string | null;
  engine: string;
  model: string | null;
  status: ProbeState;
  mentioned: boolean | null;
  sourceUrl: string | null;
  position: number | null;
  answerExcerpt: string | null;
  sources: CitationSource[];
  competitors: CompetitorSighting[];
  error: string | null;
  latencyMs: number | null;
  checkedAt: string | null;
  previousStatus: ProbeState | null;
  change: ProbeChange;
}

/**
 * The per-probe table, each row carrying what the same question got from the
 * same engine in the previous run. "unknown" covers every case where one side
 * was not a readable answer — an error last week and a citation this week is
 * not a gain, it is one measurement.
 */
export function queryRows(current: ProbeRecord[], previous: ProbeRecord[]): QueryRow[] {
  const key = (p: Pick<ProbeRecord, "query" | "engine">) =>
    `${p.query.toLowerCase()}\u0000${p.engine}`;
  const before = new Map(previous.map((p) => [key(p), p]));

  return current
    .map((probe) => {
      const prior = before.get(key(probe)) ?? null;
      return {
        probeId: probe.id,
        queryId: probe.queryId,
        query: probe.query,
        cluster: probe.cluster,
        engine: probe.engine,
        model: probe.model,
        status: probe.status,
        mentioned: probe.mentioned,
        sourceUrl: probe.sourceUrl,
        position: probe.position,
        answerExcerpt: probe.answerExcerpt,
        sources: probe.sources,
        competitors: probe.competitors,
        error: probe.error,
        latencyMs: probe.latencyMs,
        checkedAt: probe.checkedAt,
        previousStatus: prior?.status ?? null,
        change: changeBetween(prior?.status ?? null, probe.status),
      };
    })
    .sort((a, b) => a.query.localeCompare(b.query) || a.engine.localeCompare(b.engine));
}

export function changeBetween(previous: ProbeState | null, current: ProbeState): ProbeChange {
  const readable = (s: ProbeState | null) => s === "cited" || s === "not_cited";
  if (previous === null) return "new";
  if (!readable(previous) || !readable(current)) return "unknown";
  if (previous === current) return "same";
  return current === "cited" ? "gained" : "lost";
}

export interface RecurringDomain {
  domain: string;
  name: string | null;
  /** Probes in which it appeared, out of the valid probes considered. */
  count: number;
  asSource: number;
  asMention: number;
}

/**
 * Domains that keep coming back across a query's (or a business's) probes,
 * most frequent first. Counted per probe, so a source listed twice in one
 * answer counts once.
 */
export function recurringCompetitors(probes: ProbeRecord[], limit = 10): RecurringDomain[] {
  const tally = new Map<string, RecurringDomain>();
  for (const probe of probes) {
    if (probe.status !== "cited" && probe.status !== "not_cited") continue;
    const seen = new Set<string>();
    for (const c of probe.competitors) {
      if (seen.has(c.domain)) continue;
      seen.add(c.domain);
      const entry = tally.get(c.domain) ?? {
        domain: c.domain,
        name: c.name,
        count: 0,
        asSource: 0,
        asMention: 0,
      };
      entry.count += 1;
      if (c.via === "source") entry.asSource += 1;
      else entry.asMention += 1;
      if (!entry.name && c.name) entry.name = c.name;
      tally.set(c.domain, entry);
    }
  }
  return [...tally.values()]
    .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain))
    .slice(0, limit);
}

export interface RecurringSource {
  domain: string;
  count: number;
  /** One example URL, the most recent seen. */
  url: string;
  title: string;
}

/** Every domain the engines cited, ours included, most frequent first. */
export function recurringSources(probes: ProbeRecord[], limit = 10): RecurringSource[] {
  const tally = new Map<string, RecurringSource>();
  const ordered = [...probes].sort((a, b) =>
    (a.checkedAt ?? "").localeCompare(b.checkedAt ?? "")
  );
  for (const probe of ordered) {
    if (probe.status !== "cited" && probe.status !== "not_cited") continue;
    const seen = new Set<string>();
    for (const source of probe.sources) {
      if (!source.domain || seen.has(source.domain)) continue;
      seen.add(source.domain);
      const entry = tally.get(source.domain) ?? {
        domain: source.domain,
        count: 0,
        url: source.url,
        title: source.title,
      };
      entry.count += 1;
      entry.url = source.url;
      entry.title = source.title || entry.title;
      tally.set(source.domain, entry);
    }
  }
  return [...tally.values()]
    .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain))
    .slice(0, limit);
}

export interface EngineHistoryPoint {
  runId: string;
  checkedAt: string | null;
  status: ProbeState;
  position: number | null;
  mentioned: boolean | null;
}

export interface EngineHistory {
  engine: string;
  points: EngineHistoryPoint[];
  /** Share of readable probes that cited us, or null when none were readable. */
  rate: number | null;
  valid: number;
  cited: number;
}

/** A query's probe history, per engine, oldest first. */
export function queryHistory(probes: ProbeRecord[]): EngineHistory[] {
  const byEngine = new Map<string, EngineHistory>();
  const ordered = [...probes].sort((a, b) =>
    (a.checkedAt ?? "").localeCompare(b.checkedAt ?? "")
  );
  for (const probe of ordered) {
    const history = byEngine.get(probe.engine) ?? {
      engine: probe.engine,
      points: [],
      rate: null,
      valid: 0,
      cited: 0,
    };
    history.points.push({
      runId: probe.runId,
      checkedAt: probe.checkedAt,
      status: probe.status,
      position: probe.position,
      mentioned: probe.mentioned,
    });
    if (probe.status === "cited" || probe.status === "not_cited") {
      history.valid += 1;
      if (probe.status === "cited") history.cited += 1;
    }
    byEngine.set(probe.engine, history);
  }
  return [...byEngine.values()]
    .map((h) => ({ ...h, rate: h.valid === 0 ? null : h.cited / h.valid }))
    .sort((a, b) => a.engine.localeCompare(b.engine));
}
