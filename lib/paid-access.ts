import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { hasActiveSubscription } from "@/lib/subscription";
import { PLACEMENT_DRAFT } from "@/lib/jobs/workflows/placement-draft";
import { correctionsToday } from "@/lib/placements/feedback";
import { SITE_URL } from "@/lib/site";
import { billingDisabled } from "@/lib/billing-mode";

/**
 * The server-side half of the paywall.
 *
 * `requireAppAccess` (lib/app-access.ts) keeps a lapsed account out of the
 * screens, but a screen is not the only way to reach an API route: anyone
 * signed in can POST to it directly. Every route that makes a paid provider
 * call (a model, a SERP, an answer engine) or enqueues a job that will, asks
 * this guard first, and it decides with the same `hasActiveSubscription` the
 * UI gate uses, so the two can never disagree about who has paid.
 *
 * Each check comes in two forms: a `…Denial` that answers with data (the
 * tool layer turns it into its own error shape, for the API and MCP,
 * `lib/tools/`), and a `require…` that answers with the route's response.
 * Same decision, same sentence.
 */

export const SUBSCRIPTION_REQUIRED_MESSAGE =
  "This needs an active GetTrafficFast subscription. Choose a plan to continue.";

/**
 * Public pages about the plan. The pricing page is named on the public docs
 * only (/docs/mcp); a tool's refusal and the MCP instructions name the
 * account's own Billing page, because an app listed in an agent directory
 * may not show plans or promote one (registry rules, 2026-11-16).
 */
export const PRICING_URL = `${SITE_URL}/pricing`;
export const BILLING_URL = `${SITE_URL}/settings/billing`;

/**
 * The one answer every tool gives a caller whose account has no active plan
 * (none yet, ended, cancelled, unpaid), over MCP and the REST runner alike
 * (lib/tools/runner.ts, docs/API.md "Without a plan"). Code
 * `subscription_required`, HTTP 402. Factual, not promotional: it says what
 * is true and where the owner manages it, never a price, never "upgrade" or
 * "buy". Stable: the public docs and the MCP instructions quote it.
 */
export const PLAN_REQUIRED_MESSAGE = `This GetTrafficFast account has no active plan, so its tools are unavailable. The account owner can manage the plan at ${BILLING_URL}.`;

export const PLAN_REQUIRED_HINT =
  "The plan is checked on every call: once the account has an active plan, this same connection or key works again, with nothing to reconnect. Calling again before then gets the same answer.";

/**
 * Draft jobs a single account may start in a rolling 24 hours. Each one is up
 * to a few quality-tier model calls, so this is the ceiling on what one
 * account can spend on drafting in a day, whatever the UI does. Generous for
 * a person working an inbox by hand; a wall for a script.
 */
export const DAILY_DRAFT_CAP = 60;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Why a call may not spend, as data. */
export interface AccessDenial {
  status: 401 | 402 | 429;
  code: string;
  error: string;
  href?: string;
}

function denialResponse(denial: AccessDenial): NextResponse {
  const body: Record<string, unknown> = { error: denial.error, code: denial.code };
  if (denial.href) body.href = denial.href;
  return NextResponse.json(body, { status: denial.status });
}

/**
 * Null when the user may spend, otherwise why not: 401 without a user, 402
 * without a live subscription. `client` is what the subscription is read
 * through; the request's session when omitted.
 */
export async function paidAccessDenial(
  user: { id: string } | null | undefined,
  client?: SupabaseClient
): Promise<AccessDenial | null> {
  if (!user) return { status: 401, code: "unauthorized", error: "Unauthorized" };
  if (!(await hasActiveSubscription(user.id, client))) {
    return { status: 402, code: "subscription_required", error: SUBSCRIPTION_REQUIRED_MESSAGE, href: "/pricing" };
  }
  return null;
}

/**
 * Null when the user may spend, otherwise the response to return as is:
 * 401 without a session, 402 without a live subscription.
 */
export async function requirePaidAccess(
  user: { id: string } | null | undefined,
  client?: SupabaseClient
): Promise<NextResponse | null> {
  const denial = await paidAccessDenial(user, client);
  return denial ? denialResponse(denial) : null;
}

/** How many draft jobs this user started in the last 24 hours. */
export async function draftsStartedToday(
  supabase: SupabaseClient,
  userId: string,
  now: Date = new Date()
): Promise<number> {
  const since = new Date(now.getTime() - DAY_MS).toISOString();
  const { count, error } = await supabase
    .from("jobs")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("type", PLACEMENT_DRAFT)
    .gte("created_at", since);
  // Fail closed: an unreadable count must not become an unlimited budget.
  if (error) throw new Error(`Could not count today's drafts: ${error.message}`);
  return count ?? 0;
}

/**
 * Null while the user is under the daily draft cap, otherwise a 429 with a
 * sentence a person can act on. Counted per user across all their sites:
 * the budget is the account's, not the site's.
 */
export async function draftCapacityDenial(
  supabase: SupabaseClient,
  userId: string,
  now: Date = new Date()
): Promise<AccessDenial | null> {
  const started = await draftsStartedToday(supabase, userId, now);
  if (started < DAILY_DRAFT_CAP) return null;
  return {
    status: 429,
    code: "draft_limit",
    error: `You have started ${DAILY_DRAFT_CAP} drafts in the last 24 hours, which is the daily limit. The ones already written are in your inbox; new drafts open up again within a day.`,
  };
}

/** `draftCapacityDenial` as the route's response. */
export async function requireDraftCapacity(
  supabase: SupabaseClient,
  userId: string,
  now: Date = new Date()
): Promise<NextResponse | null> {
  const denial = await draftCapacityDenial(supabase, userId, now);
  return denial ? denialResponse(denial) : null;
}

/**
 * Corrections a single account may ask for in a rolling 24 hours ("Fix with
 * a note" on a draft). A correction is one model call inside the request, not
 * a draft job, so it has its own ceiling rather than a share of
 * DAILY_DRAFT_CAP, which counts jobs. Each call is capped at $0.05
 * (lib/placements/correct.ts), so this bounds one account at $5 a day.
 */
export const DAILY_CORRECTION_CAP = 100;

/**
 * Null while the user is under the daily correction cap, otherwise a 429
 * with a sentence a person can act on. Counted per user across all their
 * sites, from the notes stored before each call (`draft_feedback`).
 */
export async function correctionCapacityDenial(
  supabase: SupabaseClient,
  userId: string,
  now: Date = new Date()
): Promise<AccessDenial | null> {
  const asked = await correctionsToday(supabase, userId, now);
  if (asked < DAILY_CORRECTION_CAP) return null;
  return {
    status: 429,
    code: "correction_limit",
    error: `You have asked for ${DAILY_CORRECTION_CAP} corrections in the last 24 hours, which is the daily limit. You can still edit a draft by hand; corrections open up again within a day.`,
  };
}

/** `correctionCapacityDenial` as the route's response. */
export async function requireCorrectionCapacity(
  supabase: SupabaseClient,
  userId: string,
  now: Date = new Date()
): Promise<NextResponse | null> {
  const denial = await correctionCapacityDenial(supabase, userId, now);
  return denial ? denialResponse(denial) : null;
}

/**
 * The subscription statuses that carry access: the two `hasActiveSubscription`
 * (lib/subscription.ts) reads.
 */
const LIVE_SUBSCRIPTION_STATUSES = ["active", "trialing"];

/**
 * The paywall's question for code with no session: the generation cron and
 * anything else on the service role, where `hasActiveSubscription` (which
 * reads through the request's cookie-bound client) would see no row at all.
 *
 * The same rule, so the cron and the screens cannot disagree about who has
 * paid: an `active` or `trialing` row whose period has not ended, or that has
 * no period end (a trial can lack one). Any such row is enough; a canceled row
 * next to a live one does not count against it.
 *
 * Throws when the read fails, so a caller can tell "not subscribed" from
 * "could not tell", and fail closed with the right reason.
 */
export async function hasPaidAccess(
  supabase: SupabaseClient,
  userId: string,
  now: Date = new Date()
): Promise<boolean> {
  // The same switch as hasActiveSubscription, so a deployment without
  // billing (lib/billing-mode.ts) runs its sweeps for every owner too.
  if (billingDisabled()) return true;
  const { data, error } = await supabase
    .from("subscriptions")
    .select("status, current_period_end")
    .eq("user_id", userId)
    .in("status", LIVE_SUBSCRIPTION_STATUSES);
  if (error) throw new Error(`Could not read the subscription: ${error.message}`);
  return (data ?? []).some((row) => {
    const end = row.current_period_end as string | null;
    return !end || new Date(end).getTime() > now.getTime();
  });
}

/** Why a sweep left an owner out. */
export type UnpaidReason = "no_active_subscription" | "subscription_unreadable";

export interface PaidOwners {
  /** True when the owner pays, else why not. Read once per owner per sweep. */
  verdict(userId: string): Promise<true | UnpaidReason>;
}

/**
 * `hasPaidAccess` for a cron that sweeps many owners on the service role:
 * each owner is read once per run, and a subscription that cannot be read
 * counts as not paid (fail closed: the work waits for the next run rather
 * than being paid for unverified), with its own reason so the log tells the
 * two apart.
 */
export function paidOwners(supabase: SupabaseClient, now: Date = new Date()): PaidOwners {
  const verdicts = new Map<string, Promise<true | UnpaidReason>>();
  return {
    verdict(userId) {
      let verdict = verdicts.get(userId);
      if (!verdict) {
        verdict = hasPaidAccess(supabase, userId, now).then(
          (paid): true | UnpaidReason => (paid ? true : "no_active_subscription"),
          (): UnpaidReason => "subscription_unreadable"
        );
        verdicts.set(userId, verdict);
      }
      return verdict;
    },
  };
}

/**
 * The line a sweep writes for each owner it left out because they do not
 * pay, so a lapsed account's stalled work is visible in the logs rather than
 * silently missing: `{"event":"cron.unpaid_skipped","cron":…,"user_id":…}`.
 */
export function logUnpaidSkip(
  cron: string,
  fields: { user_id: string; business_id?: string | null; reason: UnpaidReason } & Record<string, unknown>
): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level: fields.reason === "subscription_unreadable" ? "warn" : "info",
    event: "cron.unpaid_skipped",
    cron,
    ...fields,
  });
  if (fields.reason === "subscription_unreadable") console.warn(line);
  else console.log(line);
}
