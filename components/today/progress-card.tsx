"use client";

import { Check, Link2, Search } from "lucide-react";
import { todayProgress, todayProgressLine, type TodayCount, type TodayLinks } from "@/lib/placements/today";
import { cn } from "@/lib/utils";

/**
 * The top of Today (2026-11-14): "3 of 5 replies", the bar toward the daily
 * goal, and one line on where today's links stand (`todayLinks`). The whole
 * card is the button that opens the Today sheet (the replies of the day and
 * the goal), as "3 of 5 today" was on Replies.
 */

const LINK_TONE: Record<TodayLinks["tone"], { icon: typeof Check; className: string }> = {
  done: { icon: Check, className: "text-emerald-600 dark:text-emerald-400" },
  waiting: { icon: Search, className: "text-muted-foreground" },
  todo: { icon: Link2, className: "text-amber-700 dark:text-amber-300" },
};

export function ProgressCard({
  today,
  links,
  utcFallback,
  open,
  onOpen,
}: {
  today: Pick<TodayCount, "posted" | "goal" | "timeZone">;
  /** Where today's links stand; null with no reply today or when not known. */
  links: TodayLinks | null;
  /** The day was read in UTC because the browser's zone could not be used: said, since near midnight it is another day. */
  utcFallback: boolean;
  /** The Today sheet is open. */
  open: boolean;
  onOpen: () => void;
}) {
  const progress = todayProgress(today);
  const tone = links ? LINK_TONE[links.tone] : null;
  const Icon = tone?.icon ?? Check;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={`Today's replies: ${today.goal ? `${today.posted} of ${today.goal}` : today.posted}`}
      className="flex w-full flex-col gap-2.5 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:bg-muted/40"
    >
      <span className="flex items-baseline justify-between gap-3">
        <span className="text-[17px] font-semibold leading-tight">{todayProgressLine(today)}</span>
        <span className="shrink-0 text-[13px] text-muted-foreground">
          {today.goal ? "daily goal" : "Set a goal"}
          {utcFallback && " (UTC)"}
        </span>
      </span>
      {progress !== null && (
        <span className="block h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
          <span className="block h-full rounded-full bg-foreground" style={{ width: `${Math.round(progress * 100)}%` }} />
        </span>
      )}
      {links && links.line && (
        <span className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
          <Icon className={cn("h-3.5 w-3.5 shrink-0", tone?.className)} strokeWidth={2.5} aria-hidden="true" />
          {links.line}
        </span>
      )}
    </button>
  );
}
