import type { SupabaseClient } from "@supabase/supabase-js";
import * as Sentry from "@sentry/nextjs";
import { claimDailyAlert } from "@/lib/llm-billing";
import { escapeText } from "@/lib/media/figures";
import { operatorEmailAddress, sendNotificationEmail } from "@/lib/notifications/email";
import {
  monthOf,
  nextMonthStart,
  readProviderSpend,
  reserveProviderSpend,
  settleProviderSpend,
} from "@/lib/limits/provider-spend";
import { formatLimitUsd, formatSpendUsd } from "@/lib/limits/spend";
import {
  X_REFERENCED_PER_POST_MAX,
  XApiError,
  isXApiEnabled,
  lookupWorstCaseUsd,
  roundUsd,
  searchWorstCaseUsd,
  userLookupWorstCaseUsd,
  xMonthlyCapUsd,
  type XApiClient,
  type XCallResult,
} from "@/lib/providers/x/api";

/**
 * The X API's money: what a run may spend, the hard monthly cap, the
 * billing pause, and the one operator alert (docs/PLACEMENTS.md, "Fresh
 * posts and reply numbers from the X API").
 *
 * Every call to X goes through `meteredXCall`, which, in this order:
 *   1. refuses when the platform has not opted in (`X_API_ENABLED=1` and a
 *      token): the key alone spends nothing;
 *   2. refuses while X's billing pause holds (one `provider_pauses` row of
 *      kind "x-api", an hour, renewed by every billing refusal);
 *   3. reserves the call's worst case (results asked for × the unit price)
 *      in the month's ledger, and refuses when that would cross the cap
 *      (`X_API_MONTHLY_CAP_USD`, default $20), alerting the operator once a
 *      month;
 *   4. makes the call and settles the ledger to the estimate of what X
 *      returned.
 *
 * The cap is platform-wide, whatever the number of businesses: it protects
 * the bill, not a customer's share.
 */

/** The ledger's and the pause's key for this vendor. */
export const X_SPEND_PROVIDER = "x-api";
export const X_PAUSE_KIND = "x-api";
export const X_PAUSE_MS = 60 * 60 * 1000;

// ── The plan: what one day costs at most ────────────────────────────────────

/** Searches per business per daily run. */
export const X_SEARCH_QUERIES_PER_RUN = 3;
/**
 * `max_results` per search: X's floor. 20 until 2026-11-14; the searches now
 * ask for conversations (topics AND question phrases), which are fewer, and
 * a run drafts five at most, so ten a search is enough and halves the worst
 * case.
 */
export const X_SEARCH_RESULTS_PER_QUERY = 10;
/** Posts made in the last this-many hours are searched. */
export const X_SEARCH_WINDOW_HOURS = 12;
/** The posts one search finds, at worst: $0.05. */
export const X_SEARCH_POSTS_WORST_USD = searchWorstCaseUsd(X_SEARCH_RESULTS_PER_QUERY);
/**
 * The worst one search costs, reserved before it is made: $0.15. Since
 * 2026-11-14 a search also reads the posts each found post quotes or replies
 * to, counted as posts read: 10 posts and, at worst, two more each.
 */
export const X_SEARCH_CALL_WORST_USD = searchWorstCaseUsd(X_SEARCH_RESULTS_PER_QUERY, { references: true });
/** The posts one business's daily run finds, at worst: $0.15. */
export const X_SEARCH_RUN_WORST_USD = roundUsd(X_SEARCH_QUERIES_PER_RUN * X_SEARCH_POSTS_WORST_USD);
/** What the quoted and replied-to posts add to one business's daily run at worst (every post quoting and replying): $0.30. */
export const X_SEARCH_RUN_REFERENCED_WORST_USD = roundUsd(X_SEARCH_QUERIES_PER_RUN * (X_SEARCH_CALL_WORST_USD - X_SEARCH_POSTS_WORST_USD));

/**
 * The close accounts (lib/placements/x-close.ts): part of the same daily
 * run since 2026-11-24, for every site. At most 2 searches a site a run,
 * `max_results` 25 each, over the posts of the last 12 hours, so a site
 * costs at most 50 posts (and the posts they quote or answer) a day. A site
 * with no reply posted on X in the last 30 days has no close accounts and
 * makes no call.
 */
export const X_CLOSE_QUERIES_PER_RUN = 2;
/** `max_results` per close-accounts search. */
export const X_CLOSE_RESULTS_PER_QUERY = 25;
/** The window a close-accounts search covers, at most: the daily search's own. */
export const X_CLOSE_WINDOW_HOURS = X_SEARCH_WINDOW_HOURS;
/** The posts one close-accounts search finds, at worst. */
export const X_CLOSE_POSTS_WORST_USD = searchWorstCaseUsd(X_CLOSE_RESULTS_PER_QUERY);
/** Reserved before each close-accounts search: 25 posts and, at worst, two referenced each. */
export const X_CLOSE_CALL_WORST_USD = searchWorstCaseUsd(X_CLOSE_RESULTS_PER_QUERY, { references: true });
/** The posts one site's close-accounts searches find in a day, at worst. */
export const X_CLOSE_RUN_WORST_USD = roundUsd(X_CLOSE_QUERIES_PER_RUN * X_CLOSE_POSTS_WORST_USD);

/**
 * Open X posts of the last days with nothing known of what they quote or
 * answer (stored before 2026-11-14, or found by the web search), read again
 * per daily run through one batched lookup. At most this many a run.
 */
export const X_REFERENCED_BACKFILL_MAX_IDS = 30;
/** The worst that lookup costs: 30 posts and two referenced each, $0.45. */
export const X_REFERENCED_BACKFILL_WORST_USD = lookupWorstCaseUsd(X_REFERENCED_BACKFILL_MAX_IDS, { references: true });

/** Posted replies whose numbers are read: those posted in the last 14 days. */
export const X_METRICS_WINDOW_DAYS = 14;
/** Ids read per daily run: one batched lookup. */
export const X_METRICS_MAX_IDS_PER_RUN = 100;
/** The worst the daily numbers cost: $0.50, only when 100 replies are in the window. */
export const X_METRICS_RUN_WORST_USD = lookupWorstCaseUsd(X_METRICS_MAX_IDS_PER_RUN);

/** Sites whose own account (followers) is read per daily run: one user lookup each. */
export const X_ACCOUNT_MAX_SITES_PER_RUN = 10;
/** The worst one site's account read costs: $0.01, the one user it returns. */
export const X_ACCOUNT_CALL_WORST_USD = userLookupWorstCaseUsd();
/** The worst the daily account reads cost: $0.10, only with 10 sites taking part. */
export const X_ACCOUNT_RUN_WORST_USD = roundUsd(X_ACCOUNT_MAX_SITES_PER_RUN * X_ACCOUNT_CALL_WORST_USD);

/**
 * The month as planned, for the docs and the report: search and the close
 * accounts at their worst every day for each business, the numbers of `repliesPerDay` replies, each
 * read on every day of its 14-day window, and each business's own account
 * read once a day.
 */
export function monthlyEstimateUsd(params: {
  days?: number;
  businesses?: number;
  repliesPerDay: number;
  /**
   * Posts read beside each found post (the one it quotes, the one it
   * answers), on average: 0 to X_REFERENCED_PER_POST_MAX. Not measured yet
   * (2026-11-14): the ledger's `posts` will say. 0 by default, so the plan
   * reads as before; pass 2 for the worst.
   */
  referencedPerPost?: number;
}): {
  searchUsd: number;
  closeUsd: number;
  referencedUsd: number;
  metricsUsd: number;
  accountUsd: number;
  totalUsd: number;
} {
  const days = params.days ?? 30;
  const businesses = params.businesses ?? 1;
  const searchUsd = roundUsd(days * businesses * X_SEARCH_RUN_WORST_USD);
  const closeUsd = roundUsd(days * businesses * X_CLOSE_RUN_WORST_USD);
  const perPost = Math.min(X_REFERENCED_PER_POST_MAX, Math.max(0, params.referencedPerPost ?? 0));
  const referencedUsd = roundUsd((searchUsd + closeUsd) * perPost);
  const inWindow = Math.min(X_METRICS_MAX_IDS_PER_RUN, params.repliesPerDay * X_METRICS_WINDOW_DAYS);
  const metricsUsd = roundUsd(days * lookupWorstCaseUsd(inWindow));
  const accountUsd = roundUsd(days * Math.min(businesses, X_ACCOUNT_MAX_SITES_PER_RUN) * X_ACCOUNT_CALL_WORST_USD);
  return {
    searchUsd,
    closeUsd,
    referencedUsd,
    metricsUsd,
    accountUsd,
    totalUsd: roundUsd(searchUsd + closeUsd + referencedUsd + metricsUsd + accountUsd),
  };
}

// ── What a person reads ─────────────────────────────────────────────────────

/**
 * The line in Replies (and a tool's refusal) when the platform's monthly X
 * cap stops the search: when it comes back, never the amount. The cap is the
 * platform's bill, not the customer's (the owner's decision, 2026-11-13);
 * the owner reads it in dollars on /settings/costs.
 */
export function xCapReachedLine(resetsAt: Date): string {
  const day = resetsAt.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return `Searching X is paused until ${day}: this month's allowance for X is used up.`;
}

// ── The pause ───────────────────────────────────────────────────────────────

function log(level: "info" | "warn" | "error", fields: Record<string, unknown>) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event: "x_api_budget", ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

/** The end of X's billing pause, or null. A pause that cannot be read is no pause: the cap still holds. */
export async function xPausedUntil(supabase: SupabaseClient, now = new Date()): Promise<Date | null> {
  try {
    const { data, error } = await supabase
      .from("provider_pauses")
      .select("paused_until")
      .eq("kind", X_PAUSE_KIND)
      .maybeSingle();
    if (error) {
      log("warn", { outcome: "pause_read_failed", error: error.message });
      return null;
    }
    const raw = (data as { paused_until?: string | null } | null)?.paused_until;
    if (!raw) return null;
    const until = new Date(raw);
    return Number.isFinite(until.getTime()) && until.getTime() > now.getTime() ? until : null;
  } catch (err) {
    log("warn", { outcome: "pause_read_failed", error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** Holds every X call for an hour after a billing refusal. Never throws. */
export async function pauseXApi(supabase: SupabaseClient, detail: string, now = new Date()): Promise<Date> {
  const pausedUntil = new Date(now.getTime() + X_PAUSE_MS);
  try {
    const { error } = await supabase.from("provider_pauses").upsert(
      {
        kind: X_PAUSE_KIND,
        paused_until: pausedUntil.toISOString(),
        reason: detail.slice(0, 2000),
        providers: [X_SPEND_PROVIDER],
        updated_at: now.toISOString(),
      },
      { onConflict: "kind" }
    );
    if (error) log("error", { outcome: "pause_write_failed", error: error.message });
  } catch (err) {
    log("error", { outcome: "pause_write_failed", error: err instanceof Error ? err.message : String(err) });
  }
  return pausedUntil;
}

// ── The operator ────────────────────────────────────────────────────────────

/**
 * One alert per key and period: a Sentry event and an email to the operator,
 * deduped through `operator_alerts`. `period` is the dedupe day: the first of
 * the month for the cap (one alert a month), today for a billing refusal.
 */
async function alertOperator(
  supabase: SupabaseClient,
  params: { key: string; period: string; headline: string; detail: string; level: "fatal" | "error" | "warning" }
): Promise<boolean> {
  try {
    const claimed = await claimDailyAlert(supabase, params.key, params.period, params.detail);
    if (claimed === false) return false;
    Sentry.captureMessage(params.headline, {
      level: params.level,
      fingerprint: ["x-api", params.key],
      tags: { x_api: params.key },
      extra: { detail: params.detail.slice(0, 1000) },
    });
    const to = operatorEmailAddress();
    // Without the dedupe row every run would email: Sentry only, then.
    if (claimed === true && to) {
      await sendNotificationEmail({
        to,
        subject: `[GetTrafficFast] ${params.headline}`,
        html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
  <h2 style="margin:0 0 16px">${escapeText(params.headline)}</h2>
  <p>${escapeText(params.detail.slice(0, 1000))}</p>
  <p style="font-size:12px;color:#888">One email per period for this alert. Nothing is posted on X by the product, ever.</p>
</div>`,
      });
    }
    log("error", { outcome: "alerted", key: params.key });
    return true;
  } catch (err) {
    log("error", { outcome: "alert_failed", key: params.key, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

export async function alertXCapReached(
  supabase: SupabaseClient,
  params: { capUsd: number; spentUsd: number | null; now?: Date }
): Promise<boolean> {
  const now = params.now ?? new Date();
  const month = monthOf(now);
  return alertOperator(supabase, {
    key: `x-api:cap:${month.slice(0, 7)}`,
    period: month,
    level: "warning",
    headline: `X API: this month's ${formatLimitUsd(params.capUsd)} cap is reached`,
    detail: `The X API spend for ${month.slice(0, 7)} is estimated at ${params.spentUsd === null ? "an amount that could not be read" : formatSpendUsd(params.spentUsd)}. Searching X for fresh posts, reading reply numbers and reading the followers stop until ${nextMonthStart(now).toISOString().slice(0, 10)} (UTC). Raise X_API_MONTHLY_CAP_USD to resume sooner.`,
  });
}

async function alertXBilling(supabase: SupabaseClient, detail: string, pausedUntil: Date, now: Date): Promise<boolean> {
  return alertOperator(supabase, {
    key: "x-api:billing",
    period: now.toISOString().slice(0, 10),
    level: "fatal",
    headline: "X API refused for billing: the account's credits are depleted",
    detail: `${detail} Every X call is paused until ${pausedUntil.toISOString()}; the pause renews while X keeps refusing.`,
  });
}

// ── The metered call ────────────────────────────────────────────────────────

export type MeteredRefusal =
  | "disabled"
  | "paused"
  | "cap"
  | "ledger"
  | "billing"
  | "rate_limit"
  | "configuration"
  | "error";

/** What every X call reports for the ledger: the resources it was billed on and the estimate. */
export type XBilled = Pick<XCallResult, "billedPosts" | "costUsd">;

export type MeteredResult<T extends XBilled = XCallResult> =
  | { ok: true; result: T; monthSpentUsd: number }
  | { ok: false; reason: MeteredRefusal; message: string; resetAt?: string | null; pausedUntil?: string | null };

/**
 * One call to X under the cap. `worstCaseUsd` is what is reserved before
 * the call; `run` makes it with the client. Never throws for anything X or
 * the ledger did: the refusal says why, in words a log or a step output can
 * carry.
 */
export async function meteredXCall<T extends XBilled = XCallResult>(params: {
  supabase: SupabaseClient;
  client: XApiClient | null;
  worstCaseUsd: number;
  run: (client: XApiClient) => Promise<T>;
  capUsd?: number;
  now?: Date;
}): Promise<MeteredResult<T>> {
  const now = params.now ?? new Date();
  if (!params.client) {
    return { ok: false, reason: "disabled", message: "The X API is not turned on for this deployment (X_API_ENABLED=1 and X_API_BEARER_TOKEN)." };
  }

  const paused = await xPausedUntil(params.supabase, now);
  if (paused) {
    return { ok: false, reason: "paused", message: `X API paused for billing until ${paused.toISOString()}.`, pausedUntil: paused.toISOString() };
  }

  const capUsd = params.capUsd ?? xMonthlyCapUsd();
  const reservation = await reserveProviderSpend(params.supabase, {
    provider: X_SPEND_PROVIDER,
    amountUsd: params.worstCaseUsd,
    capUsd,
    now,
  });
  if (!reservation.ok) {
    if (reservation.reason === "cap") {
      const spent = await readProviderSpend(params.supabase, X_SPEND_PROVIDER, now);
      await alertXCapReached(params.supabase, { capUsd, spentUsd: spent.ok ? spent.spend.costUsd : null, now });
      log("warn", { outcome: "cap_refused", cap_usd: capUsd, worst_case_usd: params.worstCaseUsd, month: reservation.month });
      return { ok: false, reason: "cap", message: xCapReachedLine(nextMonthStart(now)) };
    }
    log("error", { outcome: "ledger_unwritable", error: reservation.error });
    return { ok: false, reason: "ledger", message: `The X API spend ledger could not be written, so no call was made: ${reservation.error}` };
  }

  try {
    const result = await params.run(params.client);
    await settleProviderSpend(params.supabase, {
      provider: X_SPEND_PROVIDER,
      month: reservation.month,
      reservedUsd: reservation.reservedUsd,
      actualUsd: result.costUsd,
      posts: result.billedPosts,
    });
    return { ok: true, result, monthSpentUsd: roundUsd(reservation.totalUsd - reservation.reservedUsd + result.costUsd) };
  } catch (err) {
    // A refused call returned no post, and is billed on posts returned.
    await settleProviderSpend(params.supabase, {
      provider: X_SPEND_PROVIDER,
      month: reservation.month,
      reservedUsd: reservation.reservedUsd,
      actualUsd: 0,
      posts: 0,
    });
    if (err instanceof XApiError) {
      if (err.kind === "billing") {
        const pausedUntil = await pauseXApi(params.supabase, err.message, now);
        await alertXBilling(params.supabase, err.message, pausedUntil, now);
        return { ok: false, reason: "billing", message: err.message, pausedUntil: pausedUntil.toISOString() };
      }
      if (err.kind === "rate_limit") return { ok: false, reason: "rate_limit", message: err.message, resetAt: err.resetAt };
      if (err.kind === "configuration") return { ok: false, reason: "configuration", message: err.message };
      return { ok: false, reason: "error", message: err.message };
    }
    return { ok: false, reason: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

// ── What the screens show ───────────────────────────────────────────────────

export interface XApiStatus {
  /** The platform opted in. False: nothing about X is shown or spent. */
  enabled: boolean;
  capUsd: number;
  /** The month's estimated spend; null when the ledger could not be read. */
  spentUsd: number | null;
  /** True when the next search would cross the cap. */
  capReached: boolean;
  pausedUntil: string | null;
  /** When the cap resets: the first instant of next month, UTC. */
  resetsAt: string;
}

/**
 * What Replies says about the daily X search of a site: nothing when it does
 * not run (the platform has no X API), else whether the cap stopped it, with
 * the line that says so. Every site takes part since 2026-11-24.
 */
export function xSearchNotice(status: XApiStatus): { capReached: boolean; line: string | null } | null {
  if (!status.enabled) return null;
  return { capReached: status.capReached, line: status.capReached ? xCapReachedLine(new Date(status.resetsAt)) : null };
}

/** How X stands this month. `supabase` must be the service role: the ledger is not the person's to read. */
export async function readXApiStatus(supabase: SupabaseClient, now = new Date()): Promise<XApiStatus> {
  const capUsd = xMonthlyCapUsd();
  const resetsAt = nextMonthStart(now).toISOString();
  if (!isXApiEnabled()) return { enabled: false, capUsd, spentUsd: null, capReached: false, pausedUntil: null, resetsAt };
  const [spent, paused] = await Promise.all([readProviderSpend(supabase, X_SPEND_PROVIDER, now), xPausedUntil(supabase, now)]);
  const spentUsd = spent.ok ? spent.spend.costUsd : null;
  return {
    enabled: true,
    capUsd,
    spentUsd,
    // An unreadable ledger is not "cap reached" on screen (that would be a
    // claim nobody measured); the call itself still refuses it.
    capReached: spentUsd !== null && spentUsd + X_SEARCH_CALL_WORST_USD > capUsd,
    pausedUntil: paused ? paused.toISOString() : null,
    resetsAt,
  };
}
