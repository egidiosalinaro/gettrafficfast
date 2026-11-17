"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Minus, Plus, X } from "lucide-react";
import { UI_LOCALE } from "@/lib/format";
import { authorHandle } from "@/lib/placements/avatar";
import { metricsLine } from "@/lib/placements/reply-metrics";
import { surfaceLabel } from "@/lib/placements/surfaces";
import { stepGoal, todayCountLine, todayDots, type TodayCount, type TodayReply } from "@/lib/placements/today";
import { DAILY_REPLY_GOAL_MAX } from "@/lib/voice/settings";
import { cn } from "@/lib/utils";
import { AuthorAvatar } from "@/components/placements/post-preview";
import { PasteLinkButton } from "@/components/placements/posted-item";
import { CHIP, Problem } from "@/components/placements/ui";

/**
 * "Today", behind "4 of 5 today" (the owner's request, 2026-11-12): the
 * replies posted today, and the daily goal, changed in place.
 *
 * The list is the count's own rows (`today.replies`, picked by the same
 * rule as the number), so the two never disagree. The goal is the voice
 * setting `dailyReplyGoal`, saved through the partial update (PATCH
 * /api/business/voice-settings) a moment after the last tap, so a run of
 * taps on + is one write and About you is never touched.
 *
 * A bottom sheet on a phone, a small dialog from `md` up: the pattern of
 * the link sheet after "I posted it" (link-sheet.tsx).
 */

/** How long after the last tap on the stepper the goal is saved. */
export const GOAL_SAVE_DELAY_MS = 600;

/** "2:05 PM" in the zone the day was read in. */
export function postedTime(iso: string, timeZone: string): string {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return "";
  try {
    return at.toLocaleTimeString(UI_LOCALE, { hour: "numeric", minute: "2-digit", timeZone });
  } catch {
    return at.toLocaleTimeString(UI_LOCALE, { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
  }
}

/** "X · @janedoe": the platform and who was answered, as far as it is on record. */
export function answeredLine(reply: Pick<TodayReply, "surface" | "author" | "community">): string {
  const handle = authorHandle(reply);
  const who = handle ? (reply.surface === "x" || reply.surface === "reddit" ? `${reply.surface === "x" ? "@" : "u/"}${handle}` : handle) : null;
  return [surfaceLabel(reply.surface), who].filter(Boolean).join(" · ");
}

export interface TodaySheetProps {
  today: TodayCount;
  /** True when the day was read in UTC because the browser's zone could not be used. */
  utcFallback: boolean;
  /** The page's clock, for the "as of" of X's numbers. */
  now: number;
  /** Rows whose request is running: their Paste link waits. */
  busyIds: ReadonlySet<string>;
  onClose: () => void;
  /** Open this reply in the inbox: the Posted list, the item open. */
  onOpenReply: (id: string) => void;
  /** Saves a reply's link. Null once saved, else the server's sentence. */
  onSaveLink: (id: string, url: string) => Promise<string | null>;
  /** The goal changed on screen: the header's count and dots follow at once. */
  onGoalChange: (goal: number | null) => void;
  /** Writes the goal. Null once saved, else the sentence to show. */
  saveGoal: (goal: number | null) => Promise<string | null>;
}

export function TodaySheet({ today, utcFallback, now, busyIds, onClose, onOpenReply, onSaveLink, onGoalChange, saveGoal }: TodaySheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const goal = today.goal;
  const [saving, setSaving] = useState(false);
  const [goalProblem, setGoalProblem] = useState<string | null>(null);
  const [rowProblems, setRowProblems] = useState<Record<string, string>>({});
  // The goal waiting to be written, and its timer: a run of taps is one write.
  const pendingGoal = useRef<{ goal: number | null; timer: ReturnType<typeof setTimeout> } | null>(null);
  const saveRef = useRef(saveGoal);
  const closeRef = useRef(onClose);
  useEffect(() => {
    saveRef.current = saveGoal;
    closeRef.current = onClose;
  });

  const write = async (value: number | null) => {
    setSaving(true);
    setGoalProblem(null);
    try {
      setGoalProblem(await saveRef.current(value));
    } finally {
      setSaving(false);
    }
  };

  // Escape closes. The panel takes the focus, so a screen reader starts here.
  useEffect(() => {
    panelRef.current?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      // Closed before the delay ran out: the last goal is written all the same.
      const pending = pendingGoal.current;
      if (pending) {
        clearTimeout(pending.timer);
        pendingGoal.current = null;
        void saveRef.current(pending.goal);
      }
    };
  }, []);

  const setGoal = (value: number | null) => {
    if (value === goal) return;
    onGoalChange(value);
    setGoalProblem(null);
    if (pendingGoal.current) clearTimeout(pendingGoal.current.timer);
    const timer = setTimeout(() => {
      pendingGoal.current = null;
      void write(value);
    }, GOAL_SAVE_DELAY_MS);
    pendingGoal.current = { goal: value, timer };
  };

  const dots = todayDots(today);
  const replies = today.replies;
  const STEP = "flex h-11 w-11 items-center justify-center rounded-full border border-foreground/15 bg-background text-foreground hover:bg-muted disabled:opacity-40";

  return (
    <div className="fixed inset-0 z-50 !mt-0 flex items-end justify-center md:items-center md:p-4" data-today-sheet="">
      <button type="button" aria-label="Close" tabIndex={-1} className="absolute inset-0 h-full w-full bg-black/40" onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="today-sheet-title"
        tabIndex={-1}
        className="relative flex max-h-[85vh] w-full flex-col rounded-t-2xl border-t border-border bg-background text-foreground shadow-xl outline-none md:max-w-md md:rounded-xl md:border"
      >
        <div className="flex items-start gap-2 px-4 pt-2 md:pt-3">
          <div className="min-w-0 flex-1 pt-2">
            <h2 id="today-sheet-title" className="text-base font-semibold">
              Today
            </h2>
            <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span>
                {todayCountLine(today)}
                {utcFallback && " (UTC)"}
              </span>
              {dots.length > 0 && (
                <span className="inline-flex items-center gap-0.5" aria-hidden="true">
                  {dots.map((done, i) => (
                    <span key={i} className={cn("h-2 w-2 rounded-full", done ? "bg-foreground" : "bg-foreground/15")} />
                  ))}
                </span>
              )}
            </p>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="-mr-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        <section aria-label="Daily goal" className="space-y-1 border-b border-border px-4 pb-3 pt-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="mr-auto text-sm font-medium">Daily goal</span>
            <button
              type="button"
              aria-label="Lower the goal"
              disabled={goal === null || goal <= 1}
              onClick={() => setGoal(stepGoal(goal, -1, DAILY_REPLY_GOAL_MAX))}
              className={STEP}
            >
              <Minus className="h-4 w-4" aria-hidden="true" />
            </button>
            <span className="w-12 text-center text-base font-semibold tabular-nums" aria-live="polite" data-goal="">
              {goal ?? <span className="text-sm font-normal text-muted-foreground">None</span>}
            </span>
            <button
              type="button"
              aria-label="Raise the goal"
              disabled={goal !== null && goal >= DAILY_REPLY_GOAL_MAX}
              onClick={() => setGoal(stepGoal(goal, 1, DAILY_REPLY_GOAL_MAX))}
              className={STEP}
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-pressed={goal === null}
              onClick={() => setGoal(null)}
              className={cn(CHIP, "min-h-11 md:min-h-11 md:text-sm", goal === null && "border-foreground/40 font-semibold text-foreground")}
            >
              No goal
            </button>
            <span role="status" className="inline-flex h-4 w-4 items-center justify-center">
              {saving && (
                <>
                  <Loader2 data-busy="" className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />
                  <span className="sr-only">Saving the goal</span>
                </>
              )}
            </span>
          </div>
          {goalProblem && <Problem>{goalProblem}</Problem>}
        </section>

        <div className="min-h-0 flex-1 overflow-y-auto pb-[calc(0.5rem+env(safe-area-inset-bottom))] md:pb-2">
          {replies === undefined ? (
            today.posted > 0 ? (
              <p className="px-4 py-4 text-sm text-muted-foreground">Today&rsquo;s replies could not be read. Reload the page to try again.</p>
            ) : (
              <p className="px-4 py-4 text-sm text-muted-foreground">Nothing posted yet today.</p>
            )
          ) : replies.length === 0 ? (
            <p className="px-4 py-4 text-sm text-muted-foreground">Nothing posted yet today.</p>
          ) : (
            <ul aria-label="Replies posted today">
              {replies.map((reply) => {
                const metrics = metricsLine(reply.metrics, new Date(now));
                return (
                  <li key={reply.id} className="border-b border-foreground/10 last:border-b-0" data-today-reply={reply.id}>
                    <div className="flex items-start gap-2 px-4">
                      <button
                        type="button"
                        onClick={() => onOpenReply(reply.id)}
                        className="flex min-h-14 min-w-0 flex-1 items-start gap-3 py-2.5 text-left"
                      >
                        <AuthorAvatar target={reply} size={28} className="mt-0.5" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs text-muted-foreground">
                            {answeredLine(reply)} · {postedTime(reply.publishedAt, today.timeZone)}
                          </span>
                          {/* Two lines, so a reply can be told from the others on a phone too. */}
                          <span className="line-clamp-2 text-sm font-medium">{reply.text ? `“${reply.text}”` : "Reply text not on record"}</span>
                          {metrics && <span className="mt-0.5 block text-xs text-muted-foreground">{metrics}</span>}
                        </span>
                      </button>
                      <div className="shrink-0 py-2.5">
                        {reply.publishedUrl ? (
                          <a
                            href={reply.publishedUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex min-h-11 items-center px-1 text-sm font-medium text-foreground underline-offset-2 hover:underline md:min-h-8"
                          >
                            Your reply ↗
                          </a>
                        ) : (
                          <PasteLinkButton
                            target={reply}
                            busy={busyIds.has(reply.id)}
                            onSave={(url) => onSaveLink(reply.id, url)}
                            onProblem={(problem) =>
                              setRowProblems((current) => {
                                const next = { ...current };
                                if (problem) next[reply.id] = problem;
                                else delete next[reply.id];
                                return next;
                              })
                            }
                          />
                        )}
                      </div>
                    </div>
                    {rowProblems[reply.id] && (
                      <div className="px-4 pb-2">
                        <Problem>{rowProblems[reply.id]}</Problem>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
