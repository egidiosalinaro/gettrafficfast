import { cn } from "@/lib/utils";
import type { AiWorkStatus, PlanUsage, Quota } from "@/lib/limits/quotas";

/**
 * Settings → Plan: what the plan lets the account do, in its own units, and
 * how much of it is used (lib/limits/quotas.ts). No dollar amount anywhere:
 * the subscriber pays a fixed price, and the daily ceiling on AI work is the
 * platform's protection, said only when it is reached, with when it resets.
 * A count that could not be read says so, never 0.
 */

/** "9 of 60", or why there is no number. */
export function quotaLine(quota: Quota): string {
  return quota.used === null ? "could not be read" : `${quota.used} of ${quota.limit}`;
}

function share(quota: Quota): number {
  if (quota.used === null || quota.limit <= 0) return 0;
  return Math.min(1, quota.used / quota.limit);
}

function QuotaRow({ quota }: { quota: Quota }) {
  const full = quota.used !== null && quota.used >= quota.limit;
  const percent = Math.round(share(quota) * 100);
  return (
    <li className="space-y-1.5 py-2.5">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="min-w-0 text-foreground">{quota.label}</span>
        <span
          className={cn(
            "shrink-0 tabular-nums",
            quota.used === null
              ? "text-muted-foreground"
              : full
                ? "font-medium text-red-700 dark:text-red-400"
                : "font-medium text-foreground"
          )}
        >
          {quotaLine(quota)}
        </span>
      </div>
      {quota.used !== null && (
        <div
          role="progressbar"
          aria-label={quota.label}
          aria-valuemin={0}
          aria-valuemax={quota.limit}
          aria-valuenow={Math.min(quota.used, quota.limit)}
          className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
        >
          <div
            className={cn("h-full rounded-full", full ? "bg-red-500" : "bg-foreground/70")}
            style={{ width: `${percent}%` }}
          />
        </div>
      )}
    </li>
  );
}

function AiWorkNotice({ aiWork }: { aiWork: AiWorkStatus }) {
  if (aiWork.state === "available") return null;
  return (
    <p
      role="status"
      className={cn(
        "rounded-lg border p-3 text-sm",
        aiWork.state === "reached"
          ? "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300"
          : "border-border bg-muted/60 text-muted-foreground"
      )}
    >
      {aiWork.message}
      {aiWork.state === "reached" && " Work already queued waits and then goes on by itself."}
    </p>
  );
}

export function PlanUsagePanel({ usage }: { usage: PlanUsage }) {
  const monthly = usage.quotas.filter((quota) => quota.period === "month");
  const daily = usage.quotas.filter((quota) => quota.period === "day");
  return (
    <div className="space-y-5">
      <AiWorkNotice aiWork={usage.aiWork} />

      {monthly.length > 0 && (
        <section aria-labelledby="plan-month-heading" className="space-y-1">
          <h3 id="plan-month-heading" className="text-sm font-semibold">
            This month
          </h3>
          <ul className="divide-y divide-border">
            {monthly.map((quota) => (
              <QuotaRow key={quota.id} quota={quota} />
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="plan-day-heading" className="space-y-1">
        <h3 id="plan-day-heading" className="text-sm font-semibold">
          Daily limits
        </h3>
        <p className="text-xs leading-snug text-muted-foreground">
          Each counts the last 24 hours, the screens and every API key together, and opens up again on its own.
        </p>
        <ul className="divide-y divide-border">
          {daily.map((quota) => (
            <QuotaRow key={quota.id} quota={quota} />
          ))}
        </ul>
      </section>
    </div>
  );
}
