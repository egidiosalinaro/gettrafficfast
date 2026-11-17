import { requireAppAccess } from "@/lib/app-access";
import { isPlatformOwner } from "@/lib/owner";
import { billingDisabled } from "@/lib/billing-mode";
import { getUserSubscription, summarizeSubscription } from "@/lib/subscription";
import { formatDay } from "@/lib/format";
import { PLAN_NAME } from "@/components/landing/plan-card";
import { SettingsOverview, type PlanLine } from "@/components/settings/settings-overview";

export const dynamic = "force-dynamic";

/**
 * Settings: the grouped list (components/settings/settings-overview.tsx).
 * It used to redirect to Business, and a phone reached the other pages
 * through a row of tabs scrolling sideways; eight tabs did not fit, and the
 * last ones were never seen. A new account still finds Business first.
 *
 * The plan card says only what the subscription row holds, as Billing does.
 */
export default async function SettingsPage() {
  const { userId, selected } = await requireAppAccess();
  const billing = !billingDisabled();
  const subscription = billing ? await getUserSubscription(userId).catch(() => null) : null;
  const summary = subscription ? summarizeSubscription(subscription) : null;

  const plan: PlanLine | null = summary
    ? {
        name: `${PLAN_NAME} plan`,
        detail:
          summary.dateLabel && summary.date
            ? `${summary.statusLabel} · ${summary.dateLabel.toLowerCase()} ${formatDay(summary.date.slice(0, 10))}`
            : summary.statusLabel,
        needsAttention: summary.needsAttention,
      }
    : null;

  return (
    <SettingsOverview
      siteName={selected?.name || selected?.website_url || null}
      plan={plan}
      isOwner={isPlatformOwner(userId)}
      billing={billing}
    />
  );
}
