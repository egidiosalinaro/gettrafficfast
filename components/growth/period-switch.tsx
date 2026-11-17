import Link from "next/link";
import { GROWTH_DAYS, type GrowthDays } from "@/lib/growth/period";
import { growthHref } from "@/lib/growth/routes";
import { cn } from "@/lib/utils";

/**
 * 7 days / 28 days. Links, not state: the period is in the address
 * (`?days=28`), so a reload, a shared link and the back button keep it.
 */
export function PeriodSwitch({
  days,
  path,
  extra,
}: {
  days: GrowthDays;
  path: string;
  /** Other query values the address keeps (the engine filter). */
  extra?: Record<string, string | null | undefined>;
}) {
  return (
    <nav aria-label="Period" className="inline-flex shrink-0 gap-1 rounded-xl bg-muted p-1">
      {GROWTH_DAYS.map((d) => {
        const active = d === days;
        return (
          <Link
            key={d}
            href={growthHref(path, d, extra)}
            replace
            scroll={false}
            aria-current={active ? "true" : undefined}
            className={cn(
              "inline-flex min-h-11 items-center rounded-lg px-3 text-sm md:min-h-9",
              active
                ? "bg-card font-semibold text-foreground shadow-sm dark:bg-foreground dark:text-background"
                : "font-medium text-muted-foreground hover:text-foreground"
            )}
          >
            {d} days
          </Link>
        );
      })}
    </nav>
  );
}
