/**
 * Whether this deployment charges for access at all.
 *
 * The hosted service does: the paywall (`hasActiveSubscription`,
 * lib/subscription.ts, and `hasPaidAccess`, lib/paid-access.ts) reads the
 * Stripe-backed `subscriptions` table. A self-hosted install usually has no
 * Stripe account and no plan to sell, so `BILLING_DISABLED=1` makes every
 * signed-in account count as subscribed and hides the billing screens
 * (docs/SELF_HOSTING.md, "Running without billing").
 *
 * Off unless the variable is exactly "1": a typo, an empty value or "true"
 * leaves billing on, so production can never lose its paywall by accident.
 * Only the access question changes. The per-account spending ceilings
 * (lib/limits/), the daily draft and correction caps and every provider
 * opt-in stay exactly as they are: running without billing is not running
 * without cost controls.
 *
 * Server-only: the variable is not NEXT_PUBLIC_, so a client component never
 * reads it; the server decides and passes the answer down.
 */
export function billingDisabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.BILLING_DISABLED === "1";
}
