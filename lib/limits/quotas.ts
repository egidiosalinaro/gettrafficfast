import type { SupabaseClient } from "@supabase/supabase-js";
import { loadAccountActionUsage, type ActionUsage } from "./actions";
import { SPEND_CAP_CODE, checkAccountSpend, spendCapMessage } from "./spend";

/**
 * What the plan lets the customer do, in his own units (the owner's
 * decision, 2026-11-13): Settings → Plan and the `get_plan_usage` tool read
 * this, never a dollar amount.
 *
 * Only limits the code enforces, each from the number that enforces it:
 *
 * - the per-account daily caps on paid actions (lib/limits/actions.ts, the
 *   numbers of `TOOL_LIMITS`), and the draft and correction caps
 *   (`DAILY_DRAFT_CAP`, `DAILY_CORRECTION_CAP`, lib/paid-access.ts), each
 *   counted over a rolling 24 hours;
 * - one article a day on the site's calendar, which the database enforces
 *   (`unique (business_id, scheduled_date)`), shown for the calendar month;
 * - the daily limit for AI work: the account's spend ceiling
 *   (lib/limits/spend.ts), which stays invisible as an amount. The customer
 *   reads only whether it is reached and when it resets.
 *
 * A count that cannot be read is null ("could not be read"), never 0.
 */

export type QuotaPeriod = "day" | "month";

export interface Quota {
  /** The tool the cap holds (`draft_reply`), or `calendar_articles`. */
  id: string;
  label: string;
  /** Null when it could not be read: say so, never show 0. */
  used: number | null;
  limit: number;
  period: QuotaPeriod;
  /** How the period is counted. */
  window: "rolling_24_hours" | "calendar_month_utc";
}

export type AiWorkStatus =
  /** Under today's limit, or not measured at all (the guard lets work through). */
  | { state: "available"; message: null; resetsAt: null }
  | { state: "reached"; message: string; resetsAt: string | null }
  /** It could not be checked: new AI work waits until it can. */
  | { state: "unknown"; message: string; resetsAt: null };

export interface PlanUsage {
  quotas: Quota[];
  aiWork: AiWorkStatus;
}

export const CALENDAR_QUOTA_ID = "calendar_articles";

export const AI_WORK_UNKNOWN_MESSAGE =
  "Today's AI work could not be checked right now. Until it can, new AI work waits rather than run unchecked.";

/** The order Settings → Plan lists the daily limits in: the ones used every day first. */
const DAILY_ORDER = [
  "draft_reply",
  "correct_reply_draft",
  "generate_article",
  "run_reply_discovery",
  "run_visibility_check",
  "analyze_website",
  "suggest_keywords",
  "suggest_prompts",
];

function daysInMonth(now: Date): number {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The site's articles dated in `now`'s calendar month (UTC), or null when they could not be counted. */
export async function countCalendarArticles(
  client: SupabaseClient,
  userId: string,
  businessId: string,
  now: Date = new Date()
): Promise<number | null> {
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  try {
    const { count, error } = await client
      .from("articles")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("business_id", businessId)
      .gte("scheduled_date", isoDay(first))
      .lt("scheduled_date", isoDay(next));
    if (error) return null;
    return count ?? 0;
  } catch {
    return null;
  }
}

/** The daily caps as quotas, in the order the page lists them. */
export function dailyQuotas(usage: readonly ActionUsage[]): Quota[] {
  const rank = (tool: string) => {
    const index = DAILY_ORDER.indexOf(tool);
    return index === -1 ? DAILY_ORDER.length : index;
  };
  return [...usage]
    .sort((a, b) => rank(a.tool) - rank(b.tool))
    .map((row) => ({ id: row.tool, label: row.label, used: row.used, limit: row.cap, period: "day", window: "rolling_24_hours" }));
}

/**
 * The account's quotas and whether today's AI work is open, read through
 * the service role with the user spelled out on every query (the plan card
 * after the session check, `get_plan_usage` with the caller's user). Not
 * the person's session client: whether today's AI work is open is counted on
 * `agent_runs.cost_usd`, which the customer's role cannot select. Only the
 * verdict leaves this function, never an amount. `businessId` adds the
 * site's calendar; without a site there is no calendar to count.
 */
export async function loadPlanUsage(
  client: SupabaseClient,
  userId: string,
  businessId: string | null,
  now: Date = new Date()
): Promise<PlanUsage> {
  const [usage, calendar, spend] = await Promise.all([
    loadAccountActionUsage(client, userId, now),
    businessId ? countCalendarArticles(client, userId, businessId, now) : Promise.resolve(undefined),
    checkAccountSpend(client, userId, now),
  ]);

  const quotas: Quota[] = [];
  if (calendar !== undefined) {
    quotas.push({
      id: CALENDAR_QUOTA_ID,
      label: "Articles on this month's calendar, one a day",
      used: calendar,
      limit: daysInMonth(now),
      period: "month",
      window: "calendar_month_utc",
    });
  }
  quotas.push(...dailyQuotas(usage));

  let aiWork: AiWorkStatus;
  if (spend.ok) aiWork = { state: "available", message: null, resetsAt: null };
  else if (spend.code === SPEND_CAP_CODE) {
    aiWork = { state: "reached", message: spendCapMessage(spend.freesAt), resetsAt: spend.freesAt.toISOString() };
  } else aiWork = { state: "unknown", message: AI_WORK_UNKNOWN_MESSAGE, resetsAt: null };

  return { quotas, aiWork };
}
