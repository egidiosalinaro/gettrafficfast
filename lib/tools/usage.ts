import { after } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * `tool_calls`: the audit log of the API and MCP, and the per-key limits
 * read from it (docs/API.md "Limits and the audit log").
 *
 * The runner (lib/tools/runner.ts) records every call it runs, a session's
 * or a key's, with its outcome (`ok` or the error code), how long it took
 * and, when the tool measured it, what it cost. It reads the same table to
 * hold each API key to two limits:
 *
 * - a burst: at most `perMinute` calls in any 60 seconds, whatever the tool;
 * - a daily cap per paid tool, per key, over a rolling 24 hours.
 *
 * Both are per key on top of the account's own limits, which hold whatever
 * the caller: 60 drafts and 100 corrections a day (lib/paid-access.ts), the
 * same daily caps as below counted across every key and the screens, and
 * the daily AI spend ceiling (lib/limits/). Rows older than 90 days are
 * deleted by a daily sweep (lib/tools/retention.ts). An app connected over
 * OAuth (claude.ai) is held to the same two per-key limits, counted on its
 * `oauth_client_id` for that account (`LimitSubject`).
 *
 * Neither the record nor the limits can fail a call. The insert is sent
 * without waiting for it and kept alive past the response (`after`); a
 * count that cannot be read (the migration not applied yet, a database
 * hiccup) lets the call through with a warning. Failing closed would turn
 * a missing audit table into an outage of the whole API; the account caps
 * and the paywall still hold either way.
 */

export const TOOL_CALLS_TABLE = "tool_calls";

/**
 * The per-key limits, in one place. The daily numbers are also the
 * account's own caps, counted across every key and the screens
 * (lib/limits/actions.ts). Changing one is changing the API's contract:
 * docs/API.md lists them, and the public docs read them from here
 * (components/docs/docs-limits.ts).
 */
export const TOOL_LIMITS = {
  /** Calls one key may make in any 60 seconds, whatever the tool. */
  perMinute: 60,
  /** Successful calls of one tool one key may make in a rolling 24 hours, by tool name. */
  dailyByTool: {
    run_reply_discovery: 10,
    generate_article: 10,
    analyze_website: 10,
    run_visibility_check: 4,
    // One model call each, and an article can be pushed once in 28 days.
    push_article: 10,
  } as Readonly<Record<string, number>>,
  /** The same, for each tool whose name starts with the prefix (each tool has its own count). */
  dailyByPrefix: {
    suggest_: 30,
  } as Readonly<Record<string, number>>,
  /**
   * Paid tools with no per-key cap, because the function the route calls
   * already caps the account per day (DAILY_DRAFT_CAP covers draft_reply
   * and the draft add_x_post starts; DAILY_CORRECTION_CAP covers
   * correct_reply_draft), or caps each row for good (find_reply_link: six
   * searches per posted reply, ever, LINK_SEARCH_MAX_ATTEMPTS, under the
   * platform's monthly X cap). A new paid tool goes in dailyByTool or here:
   * tests/tools/usage.test.ts refuses one that is in neither.
   */
  cappedPerAccount: ["draft_reply", "add_x_post", "correct_reply_draft", "find_reply_link"] as readonly string[],
} as const;

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The daily cap one key has on `tool`, or null when it has none. */
export function dailyCapOf(tool: string): number | null {
  const exact = TOOL_LIMITS.dailyByTool[tool];
  if (exact !== undefined) return exact;
  for (const [prefix, cap] of Object.entries(TOOL_LIMITS.dailyByPrefix)) {
    if (tool.startsWith(prefix)) return cap;
  }
  return null;
}

export interface LimitDenial {
  code: "rate_limited" | "cap_reached";
  message: string;
  /** For `rate_limited`: when to try again. */
  retryAfterSeconds?: number;
}

// ── Warnings, throttled ────────────────────────────────────────────────────

const lastWarned = new Map<string, number>();

/**
 * A warning at most once a minute per kind and process: with the table
 * missing, every call would otherwise log the same line.
 */
function warn(kind: string, fields: Record<string, unknown>) {
  const now = Date.now();
  if (now - (lastWarned.get(kind) ?? 0) < MINUTE_MS) return;
  lastWarned.set(kind, now);
  console.warn(JSON.stringify({ level: "warn", event: `tool.${kind}`, ...fields }));
}

/** For tests: forget which warnings were sent. */
export function resetUsageWarnings() {
  lastWarned.clear();
}

function messageOf(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message).slice(0, 300);
  return String(error).slice(0, 300);
}

// ── Counting ───────────────────────────────────────────────────────────────

type Narrow = (query: CountQuery) => CountQuery;
interface CountQuery {
  eq(column: string, value: unknown): CountQuery;
  gte(column: string, value: unknown): CountQuery;
  then: PromiseLike<{ count: number | null; error: unknown }>["then"];
}

/**
 * What a limit counts on: an API key (by its id, a bare string), or an app
 * connected over OAuth for one account (`oauth_client_id` and `user_id`):
 * a connected app is held to the same limits as a key.
 */
export type LimitSubject = string | { oauthClientId: string; userId: string };

const subjectNoun = (subject: LimitSubject) => (typeof subject === "string" ? "key" : "connected app");

/** Rows of this subject since `since` matching `narrow`; null when the table cannot be read. */
async function countCalls(admin: () => SupabaseClient, subject: LimitSubject, since: Date, narrow: Narrow = (q) => q): Promise<number | null> {
  try {
    const query = admin().from(TOOL_CALLS_TABLE).select("id", { count: "exact", head: true }) as unknown as CountQuery;
    const scoped =
      typeof subject === "string"
        ? query.eq("api_key_id", subject)
        : query.eq("oauth_client_id", subject.oauthClientId).eq("user_id", subject.userId);
    const base = scoped.gte("created_at", since.toISOString());
    const { count, error } = await narrow(base);
    if (error) {
      warn("limits_unavailable", { error: messageOf(error), detail: "per-key limits not enforced: tool_calls cannot be read" });
      return null;
    }
    return count ?? 0;
  } catch (error) {
    warn("limits_unavailable", { error: messageOf(error), detail: "per-key limits not enforced: tool_calls cannot be read" });
    return null;
  }
}

/**
 * Null while the key is under its burst limit, else the refusal. Counts
 * every call of the key in the last minute, refused ones included: a client
 * that keeps hammering stays limited until it slows down.
 */
export async function burstDenial(admin: () => SupabaseClient, subject: LimitSubject, now: Date): Promise<LimitDenial | null> {
  const made = await countCalls(admin, subject, new Date(now.getTime() - MINUTE_MS));
  if (made === null || made < TOOL_LIMITS.perMinute) return null;
  return {
    code: "rate_limited",
    message: `This ${subjectNoun(subject)} made ${made} calls in the last minute; the limit is ${TOOL_LIMITS.perMinute} a minute.`,
    retryAfterSeconds: 60,
  };
}

/**
 * Null while the key is under its daily cap on `tool` (or the tool has
 * none), else the refusal. Counts the key's successful calls of that tool
 * in the last 24 hours: a call that was refused started nothing.
 */
export async function dailyCapDenial(
  admin: () => SupabaseClient,
  subject: LimitSubject,
  tool: string,
  now: Date
): Promise<LimitDenial | null> {
  const cap = dailyCapOf(tool);
  if (cap === null) return null;
  const made = await countCalls(admin, subject, new Date(now.getTime() - DAY_MS), (q) => q.eq("tool", tool).eq("status", "ok"));
  if (made === null || made < cap) return null;
  return {
    code: "cap_reached",
    message: `This ${subjectNoun(subject)} has called ${tool} ${made} times in the last 24 hours, its daily cap of ${cap}.`,
  };
}

// ── Recording ──────────────────────────────────────────────────────────────

export interface ToolCallRecord {
  userId: string;
  businessId: string | null;
  apiKeyId: string | null;
  /** The app an OAuth caller connected through; absent or null otherwise. */
  oauthClientId?: string | null;
  tool: string;
  /** `ok`, or the error code the call answered with. */
  status: string;
  /** What the call measurably cost; null when it measured nothing. */
  costUsd: number | null;
  durationMs: number;
  at: Date;
}

/**
 * Writes the call's audit row without waiting for it, and keeps the
 * function alive until it is written (`after`). Never throws and never
 * delays the answer; a row that cannot be written is a warning.
 */
export function recordToolCall(admin: () => SupabaseClient, record: ToolCallRecord): void {
  let pending: Promise<void>;
  try {
    const insert = admin()
      .from(TOOL_CALLS_TABLE)
      .insert({
        user_id: record.userId,
        business_id: record.businessId,
        api_key_id: record.apiKeyId,
        // Named only when set: a key's or a session's row is written exactly as before.
        ...(record.oauthClientId ? { oauth_client_id: record.oauthClientId } : {}),
        tool: record.tool.slice(0, 64),
        status: record.status.slice(0, 40),
        cost_usd: record.costUsd,
        duration_ms: Math.max(0, Math.round(record.durationMs)),
        created_at: record.at.toISOString(),
      });
    pending = Promise.resolve(insert).then(
      ({ error }) => {
        if (error) warn("call_not_recorded", { error: messageOf(error), tool: record.tool });
      },
      (error) => warn("call_not_recorded", { error: messageOf(error), tool: record.tool })
    );
  } catch (error) {
    warn("call_not_recorded", { error: messageOf(error), tool: record.tool });
    return;
  }
  try {
    after(() => pending);
  } catch {
    // Outside a request (a script, a test): the insert is already on its way.
  }
}

// ── What a job cost ────────────────────────────────────────────────────────

/**
 * The model cost a finished job recorded (`agent_runs.cost_usd`), for a tool
 * that waited for it to report. Null when nothing was recorded or it cannot
 * be read: "not measured", never 0. Searches and images are not in
 * `agent_runs`, so this is the model's share of what the job cost.
 */
export async function jobModelCostUsd(admin: SupabaseClient, jobId: string): Promise<number | null> {
  try {
    const { data, error } = await admin.from("agent_runs").select("cost_usd").eq("job_id", jobId);
    if (error || !data || data.length === 0) return null;
    const total = (data as Array<{ cost_usd: unknown }>).reduce((sum, row) => sum + (Number(row.cost_usd) || 0), 0);
    return Number(total.toFixed(6));
  } catch {
    return null;
  }
}

/**
 * Reports a job's model cost on the call's audit row once the job has
 * finished; a job still running when the call answers reports nothing.
 */
export async function reportJobCost(
  reportCost: ((usd: number) => void) | undefined,
  admin: SupabaseClient,
  job: { jobId: string; status: string } | null
): Promise<void> {
  if (!reportCost || !job || (job.status !== "completed" && job.status !== "failed")) return;
  const cost = await jobModelCostUsd(admin, job.jobId);
  if (cost !== null) reportCost(cost);
}

// ── Reading it back (Settings → API keys) ──────────────────────────────────

export interface KeyUsage {
  calls: number;
}

/**
 * Each key's calls in the last `days` days, through the person's own client
 * (RLS: their own rows), aggregated in the database (`tool_call_counts`).
 * Null when it cannot be read, so the page can say so rather than show zeros.
 *
 * Calls only: what a call costs the platform is never the customer's
 * (owner's decision, 2026-11-14), down to the column. `tool_call_counts`
 * reads no cost; the older `tool_call_usage`, which sums `cost_usd`, is
 * executable by the service role only, and `tool_calls.cost_usd` is not
 * selectable by the customer's role (migration
 * 20261114160000_hide_costs_from_customers).
 */
export async function loadKeyUsage(
  supabase: SupabaseClient,
  days = 7,
  now: Date = new Date()
): Promise<Map<string, KeyUsage> | null> {
  const since = new Date(now.getTime() - days * DAY_MS);
  try {
    const { data, error } = await supabase.rpc("tool_call_counts", { p_since: since.toISOString() });
    if (error || !Array.isArray(data)) return null;
    const usage = new Map<string, KeyUsage>();
    for (const row of data as Array<Record<string, unknown>>) {
      if (typeof row.api_key_id !== "string") continue;
      usage.set(row.api_key_id, { calls: Number(row.calls) || 0 });
    }
    return usage;
  } catch {
    return null;
  }
}
