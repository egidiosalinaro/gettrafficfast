import type { SupabaseClient } from "@supabase/supabase-js";
import { MANUAL_JOB_PRIORITY } from "@/lib/jobs/types";
import { PLACEMENT_DISCOVERY } from "@/lib/jobs/workflows/placement-discovery";
import { PRODUCE_ARTICLE } from "@/lib/jobs/workflows/produce-article";
import { AEO_RUN } from "@/lib/visibility/store";
import { DAILY_CORRECTION_CAP, DAILY_DRAFT_CAP, draftsStartedToday } from "@/lib/paid-access";
import { correctionsToday } from "@/lib/placements/feedback";
import { isMissingRelation } from "@/lib/supabase/errors";
import { TOOL_CALLS_TABLE, dailyCapOf, recordToolCall } from "@/lib/tools/usage";

/**
 * The per-account daily caps on paid actions (docs/API.md "Account limits").
 *
 * The per-key caps (TOOL_LIMITS, lib/tools/usage.ts) hold one API key; an
 * account may hold 20 keys and the screens are not keys at all, so on their
 * own they let an account start twenty times a key's cap. These hold the
 * account: the same numbers, counted across every key, every session and
 * the screens, over a rolling 24 hours.
 *
 * What is counted, from the cleanest record of each:
 *
 * - an action that starts a job (`run_reply_discovery`, `generate_article`,
 *   `run_visibility_check`) counts the account's jobs of that type asked
 *   for by a person or an agent (`MANUAL_JOB_PRIORITY`; the crons' own
 *   scheduled jobs are not actions and are bounded by their sweeps). The
 *   route and the tool enqueue the same job, so each start is counted once
 *   whoever asked; a call that found one already running started nothing
 *   and counts nothing;
 * - an action that only answers (`analyze_website`, each `suggest_*`)
 *   counts the account's successful calls of that tool in `tool_calls`: the
 *   runner records an API call, and the screen's route records its own
 *   (`recordScreenAction`, with no key), so neither surface escapes it.
 *
 * Drafts and corrections keep the account caps they already had
 * (DAILY_DRAFT_CAP, DAILY_CORRECTION_CAP in lib/paid-access.ts).
 *
 * Counting is not transactional: calls in flight at the same moment can pass
 * a cap by the calls in flight, as with the per-key caps. A count that cannot
 * be read refuses the action (fail closed: an unreadable count must not
 * become an unlimited budget); `tool_calls` not being there at all (the
 * migration not applied) lets it through with a warning.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Actions that start a job, and its type. */
const JOB_ACTIONS: Readonly<Record<string, string>> = {
  run_reply_discovery: PLACEMENT_DISCOVERY,
  generate_article: PRODUCE_ARTICLE,
  run_visibility_check: AEO_RUN,
};

/** How each capped action reads in a sentence and on Settings → Plan. */
const ACTION_NOUNS: Readonly<Record<string, { plural: string; label: string }>> = {
  run_reply_discovery: { plural: "reply discovery runs", label: "Reply discovery runs" },
  generate_article: { plural: "article generations", label: "Articles generated on demand" },
  run_visibility_check: { plural: "AI Visibility runs", label: "AI Visibility runs" },
  analyze_website: { plural: "site analyses", label: "Site analyses" },
  suggest_keywords: { plural: "keyword suggestions", label: "Keyword suggestions" },
  suggest_prompts: { plural: "prompt suggestions", label: "Prompt suggestions" },
};

/** The capped actions, in the order Settings → Plan lists them. */
export const ACCOUNT_CAPPED_ACTIONS = [
  "generate_article",
  "run_reply_discovery",
  "run_visibility_check",
  "analyze_website",
  "suggest_keywords",
  "suggest_prompts",
] as const;

export type ActionSource = { kind: "jobs"; jobType: string } | { kind: "tool_calls" };

/** The account's daily cap on `tool`: the per-key number, held across the account. Null when it has none. */
export function accountDailyCapOf(tool: string): number | null {
  return dailyCapOf(tool);
}

/** Where `tool`'s uses are counted, or null for a tool with no account cap. */
export function accountActionSource(tool: string): ActionSource | null {
  if (accountDailyCapOf(tool) === null) return null;
  const jobType = JOB_ACTIONS[tool];
  return jobType ? { kind: "jobs", jobType } : { kind: "tool_calls" };
}

function nounOf(tool: string): { plural: string; label: string } {
  return ACTION_NOUNS[tool] ?? { plural: `${tool} calls`, label: tool };
}

const lastWarned = new Map<string, number>();
function warnOnce(kind: string, fields: Record<string, unknown>) {
  const now = Date.now();
  if (now - (lastWarned.get(kind) ?? 0) < 60_000) return;
  lastWarned.set(kind, now);
  console.warn(JSON.stringify({ level: "warn", event: `account_caps.${kind}`, ...fields }));
}

/** For tests: forget which warnings were sent. */
export function resetActionWarnings() {
  lastWarned.clear();
}

export type ActionCount =
  | { ok: true; count: number }
  /** The table is not there: callers let the action through. */
  | { ok: false; reason: "missing"; detail: string }
  | { ok: false; reason: "unreadable"; detail: string };

/** How many times the account started `tool` in the 24 hours before `now`. */
export async function countAccountActions(
  client: SupabaseClient,
  userId: string,
  tool: string,
  now: Date = new Date()
): Promise<ActionCount> {
  const source = accountActionSource(tool);
  if (!source) return { ok: true, count: 0 };
  const since = new Date(now.getTime() - DAY_MS).toISOString();
  try {
    const query =
      source.kind === "jobs"
        ? client
            .from("jobs")
            .select("id", { count: "exact", head: true })
            .eq("user_id", userId)
            .eq("type", source.jobType)
            .gte("priority", MANUAL_JOB_PRIORITY)
            .gte("created_at", since)
        : client
            .from(TOOL_CALLS_TABLE)
            .select("id", { count: "exact", head: true })
            .eq("user_id", userId)
            .eq("tool", tool)
            .eq("status", "ok")
            .gte("created_at", since);
    const { count, error } = await query;
    if (error) {
      const detail = String((error as { message?: unknown }).message ?? error).slice(0, 300);
      return isMissingRelation(error) ? { ok: false, reason: "missing", detail } : { ok: false, reason: "unreadable", detail };
    }
    return { ok: true, count: count ?? 0 };
  } catch (error) {
    return { ok: false, reason: "unreadable", detail: (error instanceof Error ? error.message : String(error)).slice(0, 300) };
  }
}

export type ActionVerdict =
  | { ok: true }
  | { ok: false; code: "cap_reached"; message: string; count: number; cap: number }
  | { ok: false; code: "unreadable"; message: string };

export const ACTION_COUNT_UNREADABLE_MESSAGE =
  "Today's usage could not be checked, so nothing was started. Try again in a minute.";

/** Whether the account may start `tool` once more today. */
export async function checkAccountAction(
  client: SupabaseClient,
  userId: string,
  tool: string,
  now: Date = new Date()
): Promise<ActionVerdict> {
  const cap = accountDailyCapOf(tool);
  if (cap === null) return { ok: true };
  const counted = await countAccountActions(client, userId, tool, now);
  if (!counted.ok) {
    if (counted.reason === "missing") {
      warnOnce("unavailable", { tool, detail: "per-account caps not enforced: a table they count is missing", error: counted.detail });
      return { ok: true };
    }
    console.error(JSON.stringify({ level: "error", event: "account_caps.unreadable", user_id: userId, tool, error: counted.detail }));
    return { ok: false, code: "unreadable", message: ACTION_COUNT_UNREADABLE_MESSAGE };
  }
  if (counted.count < cap) return { ok: true };
  return {
    ok: false,
    code: "cap_reached",
    count: counted.count,
    cap,
    message: `This account has started ${counted.count} ${nounOf(tool).plural} in the last 24 hours, its daily limit of ${cap} across the screens and every API key. It opens up again within a day.`,
  };
}

/**
 * Records a screen's successful paid call in `tool_calls` under the tool's
 * name, with no key, so the account cap counts it with the API's. For the
 * routes whose action leaves no other trace (analyse a site, suggest
 * keywords, suggest prompts). Never throws and never delays the answer.
 */
export function recordScreenAction(
  admin: () => SupabaseClient,
  params: { userId: string; businessId: string | null; tool: string; startedAt: Date; durationMs: number }
): void {
  recordToolCall(admin, {
    userId: params.userId,
    businessId: params.businessId,
    apiKeyId: null,
    tool: params.tool,
    status: "ok",
    costUsd: null,
    durationMs: params.durationMs,
    at: params.startedAt,
  });
}

// ── Settings → Plan ─────────────────────────────────────────────────────

export interface ActionUsage {
  tool: string;
  label: string;
  /** Null when it could not be read: the page says so rather than show 0. */
  used: number | null;
  cap: number;
}

/**
 * Today's use of every capped paid action, the account caps that already
 * existed (drafts, corrections) included, for Settings → Plan.
 */
export async function loadAccountActionUsage(
  client: SupabaseClient,
  userId: string,
  now: Date = new Date()
): Promise<ActionUsage[]> {
  const capped = await Promise.all(
    ACCOUNT_CAPPED_ACTIONS.map(async (tool): Promise<ActionUsage> => {
      const counted = await countAccountActions(client, userId, tool, now);
      return { tool, label: nounOf(tool).label, used: counted.ok ? counted.count : null, cap: accountDailyCapOf(tool) ?? 0 };
    })
  );
  const [drafts, corrections] = await Promise.all([
    draftsStartedToday(client, userId, now).catch(() => null),
    correctionsToday(client, userId, now).catch(() => null),
  ]);
  return [
    ...capped,
    { tool: "draft_reply", label: "Reply drafts", used: drafts, cap: DAILY_DRAFT_CAP },
    { tool: "correct_reply_draft", label: "Draft corrections", used: corrections, cap: DAILY_CORRECTION_CAP },
  ];
}
