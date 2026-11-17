import { notFound } from "next/navigation";
import { requireAppAccess } from "@/lib/app-access";
import { billingDisabled } from "@/lib/billing-mode";
import { getUserSubscription, summarizeSubscription } from "@/lib/subscription";
import { PLAN_NAME } from "@/components/landing/plan-card";
import { ManageBillingButton } from "@/components/billing/manage-billing-button";
import { PlanUsagePanel } from "@/components/billing/plan-usage";
import { CONTACT_EMAIL } from "@/lib/site";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadPlanUsage } from "@/lib/limits/quotas";

export const dynamic = "force-dynamic";

/** A stored timestamp as a calendar date. The row is UTC, and so is the day. */
function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Settings → Plan: the plan card. What the subscription row says (the plan,
 * its status, the trial end or next renewal when the row has one), what the
 * plan lets the account do and how much is used, in the account's own units
 * (lib/limits/quotas.ts), and the way to the billing portal.
 *
 * No dollar amount (the owner's decision, 2026-11-13): a subscriber pays a
 * fixed price. The daily ceiling on AI work stays, invisible as an amount;
 * when it is reached the card says so and when it resets. The platform's own
 * costs are the owner's page (/settings/costs).
 */
export default async function BillingPage() {
  // A deployment without billing (lib/billing-mode.ts) has no plan to show.
  if (billingDisabled()) notFound();
  const { userId, selected } = await requireAppAccess();
  // The service role, every query filtered on the signed-in user: whether
  // today's AI work is open is counted on agent_runs.cost_usd, a column the
  // customer's own role cannot select. Only the verdict reaches the page.
  const [subscription, usage] = await Promise.all([
    getUserSubscription(userId),
    loadPlanUsage(createAdminClient(), userId, selected?.id ?? null),
  ]);
  const summary = subscription ? summarizeSubscription(subscription) : null;

  return (
    <div className="flex w-full max-w-xl flex-1 flex-col gap-6">
      <div>
        <h1 className="mb-2 text-3xl font-bold">Billing</h1>
        <p className="text-muted-foreground">
          What your plan includes and what you have used. Invoices, the payment method and cancelling are in the
          billing portal.
        </p>
      </div>

      <section aria-labelledby="plan-heading" className="overflow-hidden rounded-2xl border border-border bg-card">
        <div className="space-y-1 p-4">
          <h2 id="plan-heading" className="text-lg font-semibold">
            {PLAN_NAME} plan
          </h2>
          {summary ? (
            <p className="text-sm text-muted-foreground">
              One website ·{" "}
              <span
                className={
                  summary.needsAttention ? "font-medium text-red-700 dark:text-red-400" : "font-medium text-foreground"
                }
              >
                {summary.statusLabel}
              </span>
              {summary.complimentary ? (
                " · no payment and no renewal"
              ) : summary.dateLabel && summary.date ? (
                <>
                  {" "}
                  · {summary.dateLabel.toLowerCase()} {formatDay(summary.date)}
                </>
              ) : (
                " · the next date is in the billing portal"
              )}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              No subscription is recorded for this account. Write to{" "}
              <a href={`mailto:${CONTACT_EMAIL}`} className="text-foreground underline underline-offset-4">
                {CONTACT_EMAIL}
              </a>{" "}
              if that looks wrong.
            </p>
          )}
        </div>

        <div className="border-t border-border p-4">
          <PlanUsagePanel usage={usage} />
        </div>

        {/* A complimentary plan has nothing in the billing portal (no Stripe customer). */}
        {summary?.complimentary ? null : (
          <div className="border-t border-border p-4">
            <ManageBillingButton />
          </div>
        )}
      </section>
    </div>
  );
}
