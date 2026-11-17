import { ArrowDown, ArrowUp, Minus } from "lucide-react";
import { SAMPLE_LINE, type ProbeChange, type ProbeState, type VisibilityLead } from "@/lib/visibility/summary";
import { engineLabel, type EngineCitationRate } from "@/lib/domain/operating-loop";
import { formatRate, MIN_PROBES_FOR_PERCENT, rateIsPercent, UI_LOCALE } from "@/lib/format";
import { cn, pluralize } from "@/lib/utils";

/**
 * The small pieces every measurement screen shares (AI Visibility, Overview,
 * Articles, Results), so "cited" is always the same green, "not measured" is
 * never rendered as a number, a rate is always one per engine, and a date
 * always reads the same way.
 */

/** A measurement we do not have. Never rendered as 0. */
export function NotMeasured({ label = "not measured yet" }: { label?: string }) {
  return <span className="text-muted-foreground/60 text-xs italic">{label}</span>;
}

/**
 * A sampled rate, one engine at a time: "20%" from `MIN_PROBES_FOR_PERCENT`
 * probes, "0 of 3" below it, null over nothing. Every rate on these screens
 * goes through it; there is no bare percent helper to skip the threshold.
 */
export { formatRate, MIN_PROBES_FOR_PERCENT, rateIsPercent };

/** Said under a count shown in place of a rate, so "0 of 3" is not read as a verdict. */
export const TOO_FEW_FOR_PERCENT = `Too few for a percent (it takes ${MIN_PROBES_FOR_PERCENT}).`;

/**
 * The line under a visibility tile (Overview and Prompts): the count behind
 * a percent, or, when the value already is the count, what it counts and why
 * it is not a percent. Readable answers are the rate's denominator.
 */
export function visibilityHint(
  engine: { cited: number; valid: number; planned: number; mentioned?: number },
  options: { mentions?: boolean } = {}
): string {
  if (engine.valid === 0) return `${pluralize(engine.planned, "probe")} planned`;
  const named = options.mentions && (engine.mentioned ?? 0) > 0 ? ` · named in ${engine.mentioned}` : "";
  if (rateIsPercent(engine.valid)) {
    return `${engine.cited} of ${pluralize(engine.valid, "readable answer")} cited you${named}`;
  }
  return `${engine.valid === 1 ? "readable answer" : "readable answers"} cited you${named}. ${TOO_FEW_FOR_PERCENT}`;
}

/**
 * One formatter for every date on the Overview, Articles and Results
 * screens, in English whatever the device's locale: "Nov 2", "Mon, Nov 2".
 * It lives in `lib/format` so the lifecycle copy uses the same one.
 */
export { formatDay, parseDay, type DayFormat } from "@/lib/format";

/** A run's stored status as a person reads it: "completed" is "Done". */
const RUN_STATUS_LABEL: Record<string, string> = {
  running: "Running",
  completed: "Done",
  failed: "Failed",
};

export function runStatusLabel(status: string): string {
  return RUN_STATUS_LABEL[status] ?? status.replaceAll("_", " ");
}

/** Who started a run: a person, or the schedule. */
export function runTriggerLabel(trigger: string): string {
  if (trigger === "manual") return "By hand";
  if (trigger === "schedule") return "Scheduled";
  return trigger.replaceAll("_", " ");
}

/**
 * A timestamp for the visibility screens. Always in English: with the
 * browser's own locale an Italian phone printed Italian month names in an
 * English interface. No time yet reads as words, not a dash.
 */
export function formatWhen(iso: string | null): string {
  if (!iso) return "not yet";
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "unknown";
  return date.toLocaleString(UI_LOCALE, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const OUTCOME: Record<ProbeState, { label: string; className: string; title: string }> = {
  cited: {
    label: "cited",
    className: "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
    title: "One of your domains was among the sources the engine returned.",
  },
  not_cited: {
    label: "not cited",
    className: "border-foreground/15 bg-muted/40 text-muted-foreground",
    title: "The engine answered and your domains were not among its sources.",
  },
  invalid: {
    label: "no valid answer",
    className: "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
    title: "The engine returned nothing readable. Not counted in the rate.",
  },
  error: {
    label: "error",
    className: "border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300",
    title: "The call failed. Not counted in the rate.",
  },
  pending: {
    label: "pending",
    className: "border-foreground/15 text-muted-foreground",
    title: "Not asked yet in this run.",
  },
};

export function OutcomeBadge({ status }: { status: ProbeState }) {
  const outcome = OUTCOME[status];
  return (
    <span
      title={outcome.title}
      className={cn(
        "inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium",
        outcome.className
      )}
    >
      {outcome.label}
    </span>
  );
}

export function ChangeMark({ change, previous }: { change: ProbeChange; previous: ProbeState | null }) {
  switch (change) {
    case "gained":
      return (
        <span className="inline-flex items-center gap-0.5 text-xs text-emerald-700 dark:text-emerald-400" title="Not cited in the previous run, cited now">
          <ArrowUp className="h-3.5 w-3.5" /> gained
        </span>
      );
    case "lost":
      return (
        <span className="inline-flex items-center gap-0.5 text-xs text-red-700 dark:text-red-400" title="Cited in the previous run, not cited now">
          <ArrowDown className="h-3.5 w-3.5" /> lost
        </span>
      );
    case "same":
      return (
        <span className="inline-flex items-center gap-0.5 text-xs text-muted-foreground" title="Same outcome as the previous run">
          <Minus className="h-3.5 w-3.5" /> same
        </span>
      );
    case "new":
      return <span className="text-xs text-muted-foreground">first probe</span>;
    default:
      return (
        <span
          className="text-xs text-muted-foreground/70"
          title={`Not comparable: the previous probe was "${previous ?? "missing"}"`}
        >
          n/a
        </span>
      );
  }
}

export function StatTile({
  label,
  value,
  hint,
  children,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-foreground/10 bg-muted/20 p-4">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
      {children}
    </div>
  );
}

/**
 * One tile per answer engine, never an average across them. An engine with
 * no probes reads "not measured yet", and with no engine at all there is one
 * tile that says so, rather than an empty row that looks like a zero. Under
 * `MIN_PROBES_FOR_PERCENT` probes the tile shows the count ("0 of 3").
 */
export function EngineRateTiles({
  rates,
  label,
}: {
  rates: readonly EngineCitationRate[];
  /** Tile label before the engine name, e.g. "AI citations". */
  label: string;
}) {
  if (rates.length === 0) {
    return (
      <StatTile label={label} value={<NotMeasured />} hint="no probes recorded yet" />
    );
  }
  return (
    <>
      {rates.map((rate) => (
        <StatTile
          key={rate.engine}
          label={`${label} · ${engineLabel(rate.engine)}`}
          value={rate.rate === null ? <NotMeasured /> : formatRate(rate.cited, rate.probes)}
          hint={
            rate.probes === 0
              ? "no probes recorded yet"
              : rateIsPercent(rate.probes)
                ? `cited in ${rate.cited} of ${rate.probes} probes, sampled`
                : `${rate.probes === 1 ? "probe" : "probes"} cited you, sampled. ${TOO_FEW_FOR_PERCENT}`
          }
        />
      ))}
    </>
  );
}

/** The answer first. The sample limit is one line under it, not a box above it. */
export function VisibilityLeadBlock({ lead }: { lead: VisibilityLead }) {
  return (
    <div className="space-y-1">
      <p className="text-sm">{lead.answer}</p>
      {lead.instead && <p className="text-sm">{lead.instead}</p>}
      {lead.note && <p className="text-sm text-muted-foreground">{lead.note}</p>}
      <SamplingNotice />
    </div>
  );
}

export function SamplingNotice() {
  return <p className="text-xs text-muted-foreground">{SAMPLE_LINE}</p>;
}
