"use client";

import { TODAY_VIEWS, type TodayViewId } from "@/lib/placements/inbox-view";
import { cn } from "@/lib/utils";

/**
 * To do · Posted · Archive (2026-11-14): three tabs in place of the filter
 * menu's eleven lists (`TODAY_VIEWS`). To do carries its count, as the tab
 * bar's Today does; the other two are lists to look back at.
 */
export function ViewTabs({
  value,
  todoCount,
  busy = false,
  onChange,
}: {
  value: TodayViewId;
  /** Rows in To do; null when not known. */
  todoCount: number | null;
  /** The list is being fetched: the tab says so for assistive tech, the list dims. */
  busy?: boolean;
  onChange: (value: TodayViewId) => void;
}) {
  return (
    <div role="tablist" aria-label="Replies" aria-busy={busy} className="grid min-w-0 flex-1 grid-cols-3 gap-1 rounded-xl bg-muted p-1">
      {TODAY_VIEWS.map((view) => {
        const selected = view.id === value;
        return (
          <button
            key={view.id}
            type="button"
            role="tab"
            id={`today-tab-${view.id}`}
            aria-selected={selected}
            onClick={() => onChange(view.id)}
            className={cn(
              "min-h-11 truncate rounded-lg px-2 text-sm transition-colors md:min-h-9",
              selected ? "bg-primary font-semibold text-primary-foreground" : "font-medium text-foreground/80 hover:bg-background/60"
            )}
          >
            {view.label}
            {view.id === "todo" && todoCount !== null && <span className="tabular-nums"> · {todoCount}</span>}
          </button>
        );
      })}
    </div>
  );
}
