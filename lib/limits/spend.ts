import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingRelation } from "@/lib/supabase/errors";
import { estimateUnmeasuredRunUsd } from "./estimates";

/**
 * The daily AI spend ceiling, per account (docs/API.md "Account limits",
 * docs/AGENT_RUNTIME.md "When the account reaches its limit for AI work").
 *
 * What is counted: the model cost the account's agent runs recorded
 * (`agent_runs.cost_usd`) over a rolling 24 hours, every site and every
 * caller together (the screens, every API key, the crons and the worker).
 * A run whose cost was not recorded counts at a conservative estimate
 * (lib/limits/estimates.ts), never as $0, and the estimated part is kept
 * apart so the owner's costs page can say it is an estimate. Searches,
 * answer-engine probes and images are not model runs and are not in this
 * figure; the per-account action caps (lib/limits/actions.ts) bound them.
 *
 * The ceiling protects the platform and is never shown to the customer in
 * dollars (the owner's decision, 2026-11-13): a subscriber pays a fixed
 * price, so at the ceiling he reads "today's limit for AI work" and when it
 * resets. The ceiling is the account's own (`account_limits.daily_spend_usd`,
 * $1 to $100, set by a platform owner on /settings/costs,
 * lib/limits/settings.ts), else `ACCOUNT_DAILY_SPEND_USD`, else $5.
 *
 * Reading it, the rule for money: a spend that cannot be read refuses the
 * paid action (the worker holds the job for 5 minutes instead). A table
 * that is not there at all (a migration not applied yet) is a warning and
 * lets the action through, as the per-key limits do (lib/tools/usage.ts):
 * the guard itself must not take the product down.
 */

export const DEFAULT_DAILY_SPEND_USD = 5;
export const MIN_DAILY_SPEND_USD = 1;
export const MAX_DAILY_SPEND_USD = 100;
export const SPEND_WINDOW_MS = 24 * 60 * 60 * 1000;
export const ACCOUNT_LIMITS_TABLE = "account_limits";

/** Agent runs read per page, and the most pages one reading reads. */
const PAGE_SIZE = 1000;
const MAX_PAGES = 10;

export const SPEND_CAP_CODE = "spend_cap_reached";

/** "$5", "$7.50": a ceiling as people type it. */
export function formatLimitUsd(usd: number): string {
  return Number.isInteger(usd) ? `$${usd}` : `$${usd.toFixed(2)}`;
}

/** "$0.42": a spend, always to the cent. */
export function formatSpendUsd(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "14:05 UTC on Nov 15": when a limit frees, the same on the server and in the browser. */
export function formatResetTime(at: Date): string {
  const hh = String(at.getUTCHours()).padStart(2, "0");
  const mm = String(at.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm} UTC on ${MONTHS[at.getUTCMonth()]} ${at.getUTCDate()}`;
}

/** "at about 14:05 UTC on Nov 15", or "within 24 hours" when the moment is not known. */
function whenItFrees(freesAt: Date | null): string {
  return freesAt ? `at about ${formatResetTime(freesAt)}` : "within 24 hours";
}

/**
 * What a person and an agent read when the ceiling is reached: in the
 * customer's terms, with when it resets, never the amount. The ceiling is
 * the platform's protection, not something the customer buys or sets.
 */
export function spendCapMessage(freesAt: Date | null): string {
  return `You've reached today's limit for AI work. It resets ${whenItFrees(freesAt)}.`;
}

/**
 * Written to `jobs.last_error` (and, through `onPause`, to an article's)
 * when the worker holds a job for the ceiling. It is not a failure, and no
 * surface reads it as a provider's.
 */
export function spendHeldMessage(freesAt: Date | null): string {
  return `Waiting: today's limit for AI work is reached. This resumes on its own ${whenItFrees(freesAt)}.`;
}

/** What they read when the spend could not be checked: nothing was started. */
export const SPEND_UNREADABLE_MESSAGE =
  "Today's AI work could not be checked, so nothing was started. Try again in a minute.";

// ── Warnings, throttled ────────────────────────────────────────────────────

const lastWarned = new Map<string, number>();

function warn(kind: string, fields: Record<string, unknown>) {
  const now = Date.now();
  if (now - (lastWarned.get(kind) ?? 0) < 60_000) return;
  lastWarned.set(kind, now);
  console.warn(JSON.stringify({ level: "warn", event: `spend.${kind}`, ...fields }));
}

/** For tests: forget which warnings were sent. */
export function resetSpendWarnings() {
  lastWarned.clear();
}

function messageOf(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message).slice(0, 300);
  return String(error).slice(0, 300);
}

// ── The ceiling ────────────────────────────────────────────────────────────

let warnedEnvValue: string | null = null;

/**
 * ACCOUNT_DAILY_SPEND_USD, or $5. A value that is not a finite number above
 * zero falls back to $5 with a log line, as AGENT_BUDGET_USD does: a NaN
 * ceiling compares false against every spend and would never stop one.
 */
export function globalDailySpendUsd(raw: string | undefined = process.env.ACCOUNT_DAILY_SPEND_USD): number {
  const text = (raw ?? "").trim();
  if (!text) return DEFAULT_DAILY_SPEND_USD;
  const value = Number(text);
  if (Number.isFinite(value) && value > 0) return value;
  if (warnedEnvValue !== text) {
    warnedEnvValue = text;
    console.error(
      JSON.stringify({ level: "error", event: "spend.invalid_env", value: text.slice(0, 40), fallback_usd: DEFAULT_DAILY_SPEND_USD })
    );
  }
  return DEFAULT_DAILY_SPEND_USD;
}

export type CeilingSource = "account" | "env" | "default";

export interface SpendCeiling {
  usd: number;
  /** Where it came from: the account's own setting, the environment, or the default. */
  source: CeilingSource;
}

/** Thrown when a reading failed for a reason other than a missing table. */
export class SpendUnreadable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpendUnreadable";
  }
}

/** The ceiling every account without its own has: the environment's, else the default. */
export function globalCeiling(raw: string | undefined = process.env.ACCOUNT_DAILY_SPEND_USD): SpendCeiling {
  const text = (raw ?? "").trim();
  const value = Number(text);
  if (text && Number.isFinite(value) && value > 0) return { usd: value, source: "env" };
  return { usd: globalDailySpendUsd(text), source: "default" };
}

const envCeiling = () => globalCeiling();

/**
 * The account's ceiling. Its own row when it has one; without
 * `account_limits` (the migration not applied yet), the global one with a
 * warning. Throws SpendUnreadable for any other failure.
 */
export async function readDailySpendCeiling(client: SupabaseClient, userId: string): Promise<SpendCeiling> {
  let result: { data: unknown; error: unknown };
  try {
    result = await client.from(ACCOUNT_LIMITS_TABLE).select("daily_spend_usd").eq("user_id", userId).maybeSingle();
  } catch (error) {
    throw new SpendUnreadable(`account_limits: ${messageOf(error)}`);
  }
  if (result.error) {
    if (isMissingRelation(result.error)) {
      warn("limits_table_missing", { detail: "account_limits is missing: the global ceiling applies to every account" });
      return envCeiling();
    }
    throw new SpendUnreadable(`account_limits: ${messageOf(result.error)}`);
  }
  const stored = Number((result.data as { daily_spend_usd?: unknown } | null)?.daily_spend_usd);
  if (Number.isFinite(stored) && stored >= MIN_DAILY_SPEND_USD && stored <= MAX_DAILY_SPEND_USD) {
    return { usd: stored, source: "account" };
  }
  return envCeiling();
}

// ── The spend ──────────────────────────────────────────────────────────────

export interface AccountSpend {
  ceiling: SpendCeiling;
  /** Model cost the runs recorded. */
  measuredUsd: number;
  measuredRuns: number;
  /** The conservative estimate for the runs that recorded no cost. */
  estimatedUsd: number;
  unmeasuredRuns: number;
  /** measuredUsd + estimatedUsd. */
  totalUsd: number;
  /** At or above the ceiling. */
  reached: boolean;
  /**
   * When enough of the window will have passed for the total to fall back
   * under the ceiling, new spend aside: the moment the run that crossed it
   * leaves the 24 hours. Null while under the ceiling.
   */
  freesAt: Date | null;
  /** Since when the window counts. */
  since: Date;
}

export type SpendReading =
  | { ok: true; spend: AccountSpend }
  /** A table the reading needs is not there: callers fail open. */
  | { ok: false; reason: "missing"; detail: string }
  /** Anything else: callers fail closed. */
  | { ok: false; reason: "unreadable"; detail: string };

export interface RunRow {
  agent: string | null;
  model: string | null;
  cost_usd: number | string | null;
  created_at: string;
}

interface PageQuery {
  eq(column: string, value: unknown): PageQuery;
  gte(column: string, value: unknown): PageQuery;
  order(column: string, options: { ascending: boolean }): PageQuery;
  range(from: number, to: number): PromiseLike<{ data: unknown; error: unknown }>;
}

const round6 = (n: number) => Number(n.toFixed(6));

export interface RunTally {
  measuredUsd: number;
  measuredRuns: number;
  estimatedUsd: number;
  unmeasuredRuns: number;
  totalUsd: number;
  /** When the run that took the total to `ceilingUsd` leaves the window; null while under it. */
  freesAt: Date | null;
}

/**
 * One account's runs, NEWEST FIRST, summed against `ceilingUsd`: what was
 * measured, what is estimated (a null cost is never $0), and when the run
 * that took the total to the ceiling leaves the 24 hours. Pure: the account's
 * reading below and the owner's costs page (lib/limits/platform-costs.ts)
 * both count with it, so the two cannot disagree on an account's spend.
 */
export function tallyRuns(rows: readonly RunRow[], ceilingUsd: number, now: Date): RunTally {
  let measuredUsd = 0;
  let measuredRuns = 0;
  let estimatedUsd = 0;
  let unmeasuredRuns = 0;
  let cumulative = 0;
  let freesAt: Date | null = null;
  for (const row of rows) {
    const recorded = row.cost_usd === null || row.cost_usd === undefined ? null : Number(row.cost_usd);
    let cost: number;
    if (recorded !== null && Number.isFinite(recorded) && recorded >= 0) {
      cost = recorded;
      measuredUsd += cost;
      measuredRuns += 1;
    } else {
      cost = estimateUnmeasuredRunUsd(row.agent, row.model);
      estimatedUsd += cost;
      unmeasuredRuns += 1;
    }
    cumulative += cost;
    // Newest first: the run that takes the total to the ceiling is the
    // one whose leaving the window brings it back under.
    if (!freesAt && cumulative >= ceilingUsd) {
      const at = new Date(row.created_at).getTime();
      freesAt = new Date((Number.isFinite(at) ? at : now.getTime()) + SPEND_WINDOW_MS);
    }
  }
  const totalUsd = measuredUsd + estimatedUsd;
  return {
    measuredUsd: round6(measuredUsd),
    measuredRuns,
    estimatedUsd: round6(estimatedUsd),
    unmeasuredRuns,
    totalUsd: round6(totalUsd),
    freesAt: totalUsd >= ceilingUsd ? freesAt : null,
  };
}

/**
 * The account's spend over the last 24 hours, newest run first, with the
 * ceiling it is held to. Reads through the service role (the screens'
 * routes and the plan card after the session check, the worker, the crons
 * and the tool runner) and always filters on `user_id`. Never the person's
 * session client: `agent_runs.cost_usd` is not selectable by the customer's
 * role (migration 20261114160000_hide_costs_from_customers), so that read
 * fails and the spend reads as unreadable.
 */
export async function readAccountSpend(
  client: SupabaseClient,
  userId: string,
  now: Date = new Date()
): Promise<SpendReading> {
  const since = new Date(now.getTime() - SPEND_WINDOW_MS);
  let ceiling: SpendCeiling;
  try {
    ceiling = await readDailySpendCeiling(client, userId);
  } catch (error) {
    return { ok: false, reason: "unreadable", detail: messageOf(error) };
  }

  const runs: RunRow[] = [];
  let complete = false;

  for (let page = 0; page < MAX_PAGES; page++) {
    let result: { data: unknown; error: unknown };
    try {
      const query = client
        .from("agent_runs")
        .select("agent, model, cost_usd, created_at") as unknown as PageQuery;
      result = await query
        .eq("user_id", userId)
        .gte("created_at", since.toISOString())
        .order("created_at", { ascending: false })
        .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
    } catch (error) {
      return { ok: false, reason: "unreadable", detail: `agent_runs: ${messageOf(error)}` };
    }
    if (result.error) {
      return isMissingRelation(result.error)
        ? { ok: false, reason: "missing", detail: `agent_runs: ${messageOf(result.error)}` }
        : { ok: false, reason: "unreadable", detail: `agent_runs: ${messageOf(result.error)}` };
    }

    const rows = (Array.isArray(result.data) ? result.data : []) as RunRow[];
    runs.push(...rows);
    if (rows.length < PAGE_SIZE) {
      complete = true;
      break;
    }
  }

  const tally = tallyRuns(runs, ceiling.usd, now);
  const reached = tally.totalUsd >= ceiling.usd;
  // Past the pages read, the total is a floor: enough to say the ceiling
  // is reached, not enough to say it is not.
  if (!complete && !reached) {
    return { ok: false, reason: "unreadable", detail: `more than ${PAGE_SIZE * MAX_PAGES} agent runs in 24 hours` };
  }

  return { ok: true, spend: { ceiling, ...tally, reached, since } };
}

// ── The check every paid action makes ──────────────────────────────────────

export type SpendVerdict =
  /** May spend. `spend` is null when it is not measured at all (a missing table: fail open). */
  | { ok: true; spend: AccountSpend | null }
  | { ok: false; code: typeof SPEND_CAP_CODE; message: string; ceilingUsd: number; freesAt: Date }
  | { ok: false; code: "spend_unreadable"; message: string; detail: string };

/**
 * Whether the account may start something that spends. At or above the
 * ceiling: `spend_cap_reached`, with when the window frees. Unreadable:
 * `spend_unreadable` (fail closed). A missing table: allowed, with a
 * throttled warning (fail open).
 */
export async function checkAccountSpend(
  client: SupabaseClient,
  userId: string,
  now: Date = new Date()
): Promise<SpendVerdict> {
  const reading = await readAccountSpend(client, userId, now);
  if (!reading.ok) {
    if (reading.reason === "missing") {
      warn("ceiling_unavailable", { detail: "spend ceiling not enforced: agent_runs cannot be found", error: reading.detail });
      return { ok: true, spend: null };
    }
    console.error(JSON.stringify({ level: "error", event: "spend.unreadable", user_id: userId, error: reading.detail }));
    return { ok: false, code: "spend_unreadable", message: SPEND_UNREADABLE_MESSAGE, detail: reading.detail };
  }
  const { spend } = reading;
  if (!spend.reached) return { ok: true, spend };
  const freesAt = spend.freesAt && spend.freesAt.getTime() > now.getTime() ? spend.freesAt : new Date(now.getTime() + 5 * 60_000);
  return { ok: false, code: SPEND_CAP_CODE, message: spendCapMessage(freesAt), ceilingUsd: spend.ceiling.usd, freesAt };
}
