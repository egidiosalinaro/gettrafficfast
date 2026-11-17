import Link from "next/link";
import { ChevronRight, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { settingsGroupsFor, type SettingsItem } from "@/components/dashboard/settings-nav";

/** What the Plan card says, from the subscription row only (lib/subscription.ts). */
export interface PlanLine {
  /** "Business plan". */
  name: string;
  /** "Free trial · trial ends Nov 20", or the status alone when the row has no date. */
  detail: string;
  needsAttention: boolean;
}

function Row({ item, first }: { item: SettingsItem; first: boolean }) {
  const Trailing = item.external ? ExternalLink : ChevronRight;
  return (
    <Link
      href={item.href}
      {...(item.external ? { target: "_blank", rel: "noopener" } : {})}
      className={cn(
        "flex min-h-[60px] items-center gap-3 px-4 py-2 transition-colors hover:bg-muted/60",
        !first && "border-t border-border"
      )}
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[15px] font-medium text-foreground">{item.title}</span>
        <span className="text-xs leading-snug text-muted-foreground">{item.description}</span>
      </span>
      <Trailing
        className="h-4 w-4 shrink-0 text-muted-foreground"
        aria-label={item.external ? "opens in a new tab" : undefined}
        aria-hidden={item.external ? undefined : true}
      />
    </Link>
  );
}

function GroupHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="flex items-baseline justify-between gap-2 text-[13px] font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </h2>
  );
}

/**
 * Settings on a phone (the approved mock, 2026-11-13): three groups of rows,
 * each with a line saying what is inside, and the plan as a card. From `md`
 * up the column beside it lists the same groups; the page still opens here.
 */
export function SettingsOverview({
  siteName,
  plan,
  isOwner = false,
  billing = true,
}: {
  siteName: string | null;
  plan: PlanLine | null;
  /** A platform owner (lib/owner.ts) also sees the Platform group. */
  isOwner?: boolean;
  /** False on a deployment without billing (lib/billing-mode.ts): no Plan card. */
  billing?: boolean;
}) {
  return (
    <div className="flex w-full max-w-xl flex-col gap-6">
      <h1 className="text-3xl font-bold">Settings</h1>

      {settingsGroupsFor(isOwner, { billing }).map((group) => (
        <section key={group.id} aria-labelledby={`settings-${group.id}`} className="flex flex-col gap-2">
          <GroupHeading>
            <span id={`settings-${group.id}`}>{group.title}</span>
            {group.id === "site" && siteName && (
              <span className="min-w-0 truncate text-xs font-normal normal-case tracking-normal">{siteName}</span>
            )}
          </GroupHeading>

          {group.id === "plan" ? (
            <Link
              href={group.items[0].href}
              className="flex min-h-[60px] items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3 transition-colors hover:bg-muted/60"
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-[15px] font-semibold text-foreground">{plan?.name ?? "Billing"}</span>
                <span
                  className={cn(
                    "text-xs leading-snug",
                    plan?.needsAttention ? "font-medium text-red-700 dark:text-red-400" : "text-muted-foreground"
                  )}
                >
                  {plan?.detail ?? "No subscription is recorded for this account."}
                </span>
                <span className="text-xs leading-snug text-muted-foreground">{group.items[0].description}.</span>
              </span>
              <span className="text-[13px] text-muted-foreground">Manage</span>
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            </Link>
          ) : (
            <div className="overflow-hidden rounded-2xl border border-border bg-card">
              {group.items.map((item, index) => (
                <Row key={item.href} item={item} first={index === 0} />
              ))}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
