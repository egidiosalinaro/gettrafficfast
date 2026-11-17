import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { billingDisabled } from "@/lib/billing-mode";

export type SubscriptionStatus =
  | "active"
  | "trialing"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "incomplete"
  | "incomplete_expired"
  | "paused";

/**
 * Where a plan comes from: Stripe's webhook, or a complimentary plan the
 * platform owner granted (the directory reviewers' account,
 * lib/reviewer-account.ts). A row read before the column existed is Stripe's.
 */
export type SubscriptionSource = "stripe" | "comp";

export interface Subscription {
  id: string;
  user_id: string;
  /** Null on a complimentary plan. */
  stripe_customer_id: string | null;
  /** Null on a complimentary plan. */
  stripe_subscription_id: string | null;
  status: SubscriptionStatus;
  source?: SubscriptionSource | null;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  created_at: string;
  updated_at: string;
}

const LIVE_STATUSES: SubscriptionStatus[] = ["active", "trialing"];

/**
 * Check if user has an active subscription.
 *
 * A user can hold more than one row (a canceled subscription and the one
 * that replaced it, or two checkouts): `.single()` errored on that and read
 * as "not subscribed". Only active or trialing rows are read, the one whose
 * period runs latest first (no period end at all first: a trial can lack
 * one), and one row is enough.
 */
export async function hasActiveSubscription(
  userId: string,
  /**
   * The client to read through. Defaults to the request's session; an
   * API-key caller has none and passes its owner-scoped client
   * (lib/api-auth.ts), which reads the rows RLS would let the owner read.
   */
  client?: SupabaseClient
): Promise<boolean> {
  // A deployment without billing (BILLING_DISABLED=1, lib/billing-mode.ts):
  // every signed-in account has access, and nothing is read.
  if (billingDisabled()) return true;

  const supabase = client ?? (await createClient());

  const { data, error } = await supabase
    .from("subscriptions")
    .select("*")
    .eq("user_id", userId)
    .in("status", LIVE_STATUSES)
    .order("current_period_end", { ascending: false, nullsFirst: true })
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    return false;
  }

  // If status is "trialing" or "active", consider it active
  // Only check period_end if it exists
  if (data.current_period_end) {
    const now = new Date();
    const periodEnd = new Date(data.current_period_end);
    return periodEnd > now;
  }

  // If no period_end but status is active/trialing, consider it active
  // (subscriptions in trial might not have period_end set initially)
  return true;
}

/**
 * Get user's subscription: the active or trialing one when there is one,
 * else the most recently updated. Never errors on a user with two rows.
 */
export async function getUserSubscription(
  userId: string,
  /** As for `hasActiveSubscription`: the session's client unless one is given. */
  client?: SupabaseClient
): Promise<Subscription | null> {
  const supabase = client ?? (await createClient());

  const { data: live, error: liveError } = await supabase
    .from("subscriptions")
    .select("*")
    .eq("user_id", userId)
    .in("status", LIVE_STATUSES)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!liveError && live) return live as Subscription;

  const { data, error } = await supabase
    .from("subscriptions")
    .select("*")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    return null;
  }

  return data as Subscription;
}


const STATUS_LABEL: Record<SubscriptionStatus, string> = {
  active: "Active",
  trialing: "Free trial",
  past_due: "Payment past due",
  canceled: "Canceled",
  unpaid: "Unpaid",
  incomplete: "Payment not completed",
  incomplete_expired: "Expired before the first payment",
  paused: "Paused",
};

/** Statuses where the owner has something to fix in the billing portal. */
const NEEDS_ATTENTION: SubscriptionStatus[] = ["past_due", "unpaid", "incomplete"];

export interface SubscriptionSummary {
  statusLabel: string;
  /**
   * What the date below means ("Trial ends", "Next renewal", "Ends"), or null
   * when the row carries no usable date or the status gives it no meaning.
   * Never a guessed date: the webhook leaves the period columns empty on the
   * current Stripe API version, and then this is null.
   */
  dateLabel: string | null;
  date: string | null;
  needsAttention: boolean;
  /** A complimentary plan: nothing in the billing portal, no renewal. */
  complimentary: boolean;
}

/**
 * What the Billing page may say about a subscription row, from the row only.
 *
 * During a trial Stripe's current period ends when the trial does, so the
 * period end is the trial end. A subscription set to cancel at the end of the
 * period does not renew: its date is when it ends.
 */
export function summarizeSubscription(
  subscription: Pick<Subscription, "status" | "current_period_end" | "cancel_at_period_end"> &
    Partial<Pick<Subscription, "source">>
): SubscriptionSummary {
  const { status } = subscription;

  // A complimentary plan has no renewal, no trial and nothing to pay: it says
  // so, with no date, rather than a Stripe status it never had.
  if (subscription.source === "comp" && LIVE_STATUSES.includes(status)) {
    return { statusLabel: "Complimentary", dateLabel: null, date: null, needsAttention: false, complimentary: true };
  }
  const end =
    subscription.current_period_end &&
    Number.isFinite(Date.parse(subscription.current_period_end))
      ? subscription.current_period_end
      : null;

  let dateLabel: string | null = null;
  if (end && LIVE_STATUSES.includes(status)) {
    if (subscription.cancel_at_period_end) dateLabel = "Ends";
    else if (status === "trialing") dateLabel = "Trial ends";
    else dateLabel = "Next renewal";
  }

  return {
    statusLabel: STATUS_LABEL[status] ?? status,
    dateLabel,
    date: dateLabel ? end : null,
    needsAttention: NEEDS_ATTENTION.includes(status),
    complimentary: false,
  };
}
