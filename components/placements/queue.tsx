"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowRight, ExternalLink, Loader2, PenLine, X } from "lucide-react";
import type { PlacementTargetRecord } from "@/lib/placements/read";
import { postedReplyText } from "@/lib/placements/link-match";
import { todayDots, todayLabel, type TodayCount } from "@/lib/placements/today";
import type { DraftFailureKind } from "@/lib/placements/draft-progress";
import { cn } from "@/lib/utils";
import { postLines, rowMeta, rowState, type RowTone } from "@/components/placements/reply-logic";
import { AuthorAvatar } from "@/components/placements/post-preview";
import {
  SWIPE,
  lockAxis,
  markSwipeHintSeen,
  pastThreshold,
  releaseSide,
  swipeHintSeen,
  swipeOffset,
  swipeProgress,
  velocityOf,
  type RowSwipeActions,
  type Sample,
  type SwipeAction,
  type SwipeSide,
  type SwipeSides,
  leaveOffset,
} from "@/components/placements/swipe";

/**
 * The Replies queue: compact rows, one of them open.
 *
 * A row is two lines: who and how old, then the first line of the post (of
 * the person's own reply, once it is posted), and one word for its state at
 * the right. No status pill, no topic chip, no badge, no icon button: on
 * the owner's phone a card was a screen tall and seventeen of them were
 * eleven screens (docs/PLACEMENTS.md, "The queue", 2026-11-10).
 *
 * A row of "Found for you" also swipes (2026-11-12): a swipe to the right
 * skips, a swipe to the left drafts or opens, and the same two actions are small buttons on hover,
 * on focus and after a long press (`SwipeRow` below, rules in `swipe.ts`).
 */

const DOT: Record<RowTone, string> = {
  ready: "bg-emerald-500",
  warn: "bg-amber-500",
  idle: "border border-foreground/30",
};

export interface QueueRowProps {
  target: PlacementTargetRecord;
  now: number;
  writing?: boolean;
  failure?: DraftFailureKind | null;
  /** The row of the open item in the two-pane layout: highlighted, not expanded. */
  selected?: boolean;
  onOpen: () => void;
  /** An action on the row itself: Paste link on a posted reply with no link. */
  trailing?: ReactNode;
  /** A posted reply whose link GTF is looking for on X: it says so instead of "No link". */
  linkLooking?: boolean;
  /** A request of this row is running: a swiping row does not move, its buttons wait. */
  busy?: boolean;
  /** The swipe of a "Found for you" row (2026-11-12); without it the row is a tap only. */
  swipe?: RowSwipe;
  /** In the Archive (2026-11-14): why the row is there ("Skipped", "Expired", …), said in place of its state. */
  reason?: string | null;
}

/** What a swiping row needs from the page. */
export interface RowSwipe {
  actions: RowSwipeActions;
  /**
   * Runs one side's action. Skip answers true once recorded and false when
   * refused, and the row comes back; the others are called in the gesture
   * itself, so a new tab opens as a direct result of the person's motion.
   */
  onAction: (action: SwipeAction) => Promise<boolean> | void;
  /** Play the one-time nudge on this row (a touch screen, once ever). */
  hint?: boolean;
}

/** The second line of a row: the post, or the reply once it went out. */
export function rowText(target: Pick<PlacementTargetRecord, "status" | "title" | "excerpt" | "publishedText" | "selectedPlacementId" | "drafts">): string {
  if (target.status === "published_manually") {
    const reply = postedReplyText(target);
    if (reply) return `“${reply.split("\n")[0]}”`;
  }
  return postLines(target).title.split("\n")[0];
}

export function QueueRow({ target, now, writing = false, failure = null, selected = false, onOpen, trailing, linkLooking = false, busy = false, swipe, reason = null }: QueueRowProps) {
  const found = rowState(target, { writing, failure, linkLooking });
  const state = reason ? { word: reason, tone: "idle" as const } : found;
  const main = (
    <button
      type="button"
      onClick={onOpen}
      aria-current={selected ? "true" : undefined}
      className="flex min-h-14 min-w-0 flex-1 items-center gap-3 py-2 text-left"
    >
      {/* The author's picture, with the state's dot on its corner: the
          word at the right says the state, the dot keeps its colour. */}
      <span className="relative shrink-0" aria-hidden="true">
        <AuthorAvatar target={target} size={24} />
        <span
          data-tone={state.tone}
          className={cn("absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-background", state.tone === "idle" ? "bg-background" : "", DOT[state.tone])}
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs text-muted-foreground">
          {/* Where the row came from, not a state (2026-11-14): a sampled AI answer cited the page. */}
          {target.aiCitation && <span className="font-medium text-foreground/80">Cited by AI · </span>}
          {rowMeta(target, now)}
        </span>
        <span className="block truncate text-sm font-medium">{rowText(target)}</span>
      </span>
      {!trailing &&
        (swipe && writing ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
            <Loader2 data-busy="" className="h-3 w-3 animate-spin" aria-hidden="true" />
            {state.word}
          </span>
        ) : (
          <span className="shrink-0 text-xs text-muted-foreground">{state.word}</span>
        ))}
    </button>
  );
  if (swipe) {
    return (
      <SwipeRow id={target.id} selected={selected} busy={busy} swipe={swipe}>
        {main}
      </SwipeRow>
    );
  }
  return (
    <div className={cn("flex items-center gap-2 px-4 lg:px-3", selected && "bg-muted")} data-row={target.id}>
      {main}
      {trailing}
    </div>
  );
}

/* ── The swipe ───────────────────────────────────────────────────────── */

/** How long the row takes to spring back, to slide out on a skip, and to fold away. */
const SPRING_MS = 240;
const OUT_MS = 170;
const COLLAPSE_MS = 220;
const LONG_PRESS_MS = 500;

function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/** A short tick on a phone that has one (Android); iOS Safari has no vibrate and says nothing. */
function tick() {
  try {
    navigator.vibrate?.(10);
  } catch {
    // No vibration motor, or refused: the colour says the same.
  }
}

function localStore(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const ACTION_ICON: Record<SwipeAction["kind"], typeof PenLine> = {
  draft: PenLine,
  open: ArrowRight,
  open_article: ExternalLink,
  skip: X,
};

interface Gesture {
  id: number;
  touch: boolean;
  x0: number;
  y0: number;
  /** The slop taken off once the axis is locked, so the row does not jump. */
  shift: number;
  axis: "x" | null;
  width: number;
  offset: number;
  past: boolean;
  samples: Sample[];
  frame: number;
  press: ReturnType<typeof setTimeout> | null;
}

/**
 * A row that slides (iOS Mail): right reveals its right action in green,
 * left reveals Skip, the colour and the label fading in with the distance,
 * and a release past 40% of the width (or a fling) commits. Only the
 * transform moves while the finger does, painted once a frame, so the row
 * keeps its height and the list never reflows. `touch-action: pan-y` leaves
 * the vertical scroll of the app's scrolling area to the browser; the row
 * takes a drag only once it is clearly horizontal (`lockAxis`).
 *
 * Without a gesture the same actions are two small buttons: on hover and on
 * keyboard focus with a mouse, after a long press on a touch screen, and
 * always in the accessibility tree.
 */
function SwipeRow({ id, selected, busy, swipe, children }: { id: string; selected: boolean; busy: boolean; swipe: RowSwipe; children: ReactNode }) {
  const wrap = useRef<HTMLDivElement>(null);
  const slider = useRef<HTMLDivElement>(null);
  const rightUnder = useRef<HTMLDivElement>(null);
  const leftUnder = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const suppressClick = useRef(false);
  const lastTouch = useRef(false);
  const hintPlaying = useRef<Animation[]>([]);
  const [revealed, setRevealed] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const { actions } = swipe;
  const sides: SwipeSides = { right: actions.right !== null && !busy && !leaving, left: actions.left !== null && !busy && !leaving };

  const paint = (offset: number, width: number, animate: boolean) => {
    const el = slider.current;
    if (!el) return;
    const ease = animate && !reducedMotion();
    el.style.transition = ease ? `transform ${SPRING_MS}ms cubic-bezier(0.2, 0.9, 0.3, 1)` : "none";
    el.style.transform = offset ? `translate3d(${offset}px, 0, 0)` : "";
    const progress = swipeProgress(offset, width);
    const past = pastThreshold(offset, width);
    for (const [under, on] of [
      [rightUnder.current, offset > 0],
      [leftUnder.current, offset < 0],
    ] as const) {
      if (!under) continue;
      under.style.transition = ease ? `opacity ${SPRING_MS}ms` : "none";
      under.style.opacity = on ? String(0.35 + 0.65 * progress) : "0";
      const label = under.firstElementChild as HTMLElement | null;
      if (label) {
        label.style.transition = ease ? `opacity ${SPRING_MS}ms, transform ${SPRING_MS}ms` : "transform 120ms";
        label.style.opacity = on ? String(progress) : "0";
        label.style.transform = on && past ? "scale(1.08)" : "scale(1)";
      }
    }
  };

  const stopHint = () => {
    for (const animation of hintPlaying.current) animation.cancel();
    hintPlaying.current = [];
  };

  /**
   * Skip: the row slides out and folds away, and comes back if the server
   * refuses. It leaves in the direction it was swiped, so the whole of the
   * action it revealed shows (2026-11-12: it always slid left, and a Skip
   * swiped to the right ended on the green of the other side).
   */
  const leave = (action: SwipeAction, side: SwipeSide, width: number) => {
    setLeaving(true);
    setRevealed(false);
    const reduce = reducedMotion();
    const el = slider.current;
    if (el) {
      el.style.transition = reduce ? "none" : `transform ${OUT_MS}ms ease-in`;
      el.style.transform = `translate3d(${leaveOffset(side, width)}px, 0, 0)`;
    }
    const [under, other] = side === "right" ? [rightUnder.current, leftUnder.current] : [leftUnder.current, rightUnder.current];
    if (other) other.style.opacity = "0";
    if (under) {
      under.style.opacity = "1";
      const label = under.firstElementChild as HTMLElement | null;
      if (label) label.style.opacity = "1";
    }
    setTimeout(
      async () => {
        // The row and whatever the page put under it (a problem line) fold together.
        const box = (wrap.current?.closest("[data-row-wrap]") as HTMLElement | null) ?? wrap.current;
        let fold: Animation | null = null;
        if (box) {
          box.style.overflow = "hidden";
          fold = box.animate([{ height: `${box.offsetHeight}px`, opacity: 1 }, { height: "0px", opacity: 0 }], {
            duration: reduce ? 0 : COLLAPSE_MS,
            easing: "ease-in-out",
            fill: "forwards",
          });
        }
        let ok = false;
        try {
          ok = (await swipe.onAction(action)) !== false;
        } catch {
          ok = false;
        }
        if (!ok) {
          fold?.cancel();
          if (box) box.style.overflow = "";
          setLeaving(false);
          paint(0, width, true);
        }
      },
      reduce ? 0 : OUT_MS
    );
  };

  const run = (side: SwipeSide, width: number) => {
    const action = actions[side];
    if (!action || busy || leaving) return;
    if (action.kind === "skip") {
      leave(action, side, width);
      return;
    }
    // Draft it and the opens: the row springs back and stays where it is.
    paint(0, width, true);
    setRevealed(false);
    void swipe.onAction(action);
  };

  const endGesture = () => {
    const g = gesture.current;
    if (!g) return null;
    if (g.press) clearTimeout(g.press);
    if (g.frame) cancelAnimationFrame(g.frame);
    gesture.current = null;
    delete slider.current?.dataset.dragging;
    return g;
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    lastTouch.current = event.pointerType !== "mouse";
    if (event.pointerType === "mouse" && event.button !== 0) return;
    // A press on one of the two buttons is that button's; around them the row still drags.
    if ((event.target as HTMLElement).closest("[data-row-actions] button")) return;
    stopHint();
    endGesture();
    suppressClick.current = false;
    const touch = event.pointerType === "touch";
    const g: Gesture = {
      id: event.pointerId,
      touch,
      x0: event.clientX,
      y0: event.clientY,
      shift: 0,
      axis: null,
      width: slider.current?.offsetWidth ?? 0,
      offset: 0,
      past: false,
      samples: [{ x: event.clientX, t: event.timeStamp }],
      frame: 0,
      press: null,
    };
    // A long press on a touch screen shows the two buttons: the actions without the gesture.
    if (touch) {
      g.press = setTimeout(() => {
        if (gesture.current !== g || g.axis) return;
        gesture.current = null;
        suppressClick.current = true;
        tick();
        setRevealed(true);
      }, LONG_PRESS_MS);
    }
    gesture.current = g;
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || event.pointerId !== g.id) return;
    const dx = event.clientX - g.x0;
    if (!g.axis) {
      const axis = lockAxis(dx, event.clientY - g.y0);
      if (!axis) return;
      if (g.press) clearTimeout(g.press);
      g.press = null;
      // A scroll, or a row with nothing to swipe to (busy): the browser keeps it.
      if (axis === "y" || (!sides.right && !sides.left)) {
        gesture.current = null;
        return;
      }
      g.axis = "x";
      // The two buttons step aside while the row is dragged: the colour says it all.
      if (slider.current) slider.current.dataset.dragging = "";
      g.shift = Math.sign(dx) * SWIPE.slop;
      setRevealed(false);
      try {
        slider.current?.setPointerCapture(event.pointerId);
      } catch {
        // The pointer is already gone: its up or cancel ends the gesture.
      }
    }
    g.samples.push({ x: event.clientX, t: event.timeStamp });
    if (g.samples.length > 8) g.samples.shift();
    g.offset = swipeOffset(dx - g.shift, g.width, sides);
    const past = pastThreshold(g.offset, g.width) && sides[g.offset > 0 ? "right" : "left"];
    if (past !== g.past) {
      g.past = past;
      if (past && g.touch) tick();
    }
    if (!g.frame) {
      g.frame = requestAnimationFrame(() => {
        g.frame = 0;
        paint(g.offset, g.width, false);
      });
    }
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (gesture.current && event.pointerId !== gesture.current.id) return;
    const g = endGesture();
    if (!g || g.axis !== "x") return;
    // The release of a drag is not a tap on the row.
    suppressClick.current = true;
    const side = releaseSide({ offset: g.offset, width: g.width, velocity: velocityOf(g.samples), sides });
    if (side) run(side, g.width);
    else paint(0, g.width, true);
  };

  const onPointerCancel = () => {
    const g = endGesture();
    if (g?.axis === "x") paint(0, g.width, true);
  };

  // A long press revealed the buttons: a touch anywhere else hides them.
  useEffect(() => {
    if (!revealed) return;
    const away = (event: PointerEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setRevealed(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [revealed]);

  // The one-time nudge: on a touch screen, once the row is on screen, a
  // short slide right then left shows that the row moves. Remembered in
  // this browser; never with reduced motion.
  const hint = swipe.hint === true;
  useEffect(() => {
    if (!hint) return;
    const el = wrap.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    if (!window.matchMedia?.("(hover: none)").matches || reducedMotion()) return;
    if (swipeHintSeen(localStore())) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting) || timer) return;
        observer.disconnect();
        timer = setTimeout(() => {
          const row = slider.current;
          if (!row || gesture.current) return;
          markSwipeHintSeen(localStore());
          const timing = { duration: 1400, easing: "ease-in-out" };
          const fade = (peak: "right" | "left") =>
            peak === "right"
              ? [{ opacity: 0 }, { opacity: 0.9, offset: 0.25 }, { opacity: 0, offset: 0.5 }, { opacity: 0 }]
              : [{ opacity: 0 }, { opacity: 0, offset: 0.5 }, { opacity: 0.9, offset: 0.75 }, { opacity: 0 }];
          const played = [
            row.animate(
              [
                { transform: "translate3d(0, 0, 0)" },
                { transform: "translate3d(64px, 0, 0)", offset: 0.25 },
                { transform: "translate3d(0, 0, 0)", offset: 0.5 },
                { transform: "translate3d(-48px, 0, 0)", offset: 0.75 },
                { transform: "translate3d(0, 0, 0)" },
              ],
              timing
            ),
          ];
          for (const [under, peak] of [
            [rightUnder.current, "right"],
            [leftUnder.current, "left"],
          ] as const) {
            if (!under) continue;
            played.push(under.animate(fade(peak), timing));
            const label = under.firstElementChild as HTMLElement | null;
            if (label) played.push(label.animate(fade(peak), timing));
          }
          hintPlaying.current = played;
        }, 600);
      },
      { threshold: 0.9 }
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [hint]);

  return (
    <div ref={wrap} className="relative overflow-hidden" data-swipe="">
      {/* What the row reveals as it slides: under it, never over it. */}
      {actions.right && (
        <div ref={rightUnder} aria-hidden="true" data-under="right" className={cn("absolute inset-0 flex items-center pl-5 text-white opacity-0", underColour(actions.right))}>
          <SideLabel action={actions.right} />
        </div>
      )}
      {actions.left && (
        <div ref={leftUnder} aria-hidden="true" data-under="left" className={cn("absolute inset-0 flex items-center justify-end pr-5 text-white opacity-0", underColour(actions.left))}>
          <SideLabel action={actions.left} iconAfter />
        </div>
      )}
      <div
        ref={slider}
        data-row={id}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onLostPointerCapture={(event) => {
          // Only the row's own capture: a touch is captured by the button it
          // started on, and handing it to the row must not end the gesture.
          if (event.target === event.currentTarget) onPointerCancel();
        }}
        onClickCapture={(event) => {
          if (!suppressClick.current) return;
          suppressClick.current = false;
          event.preventDefault();
          event.stopPropagation();
        }}
        onContextMenu={(event) => {
          // On a touch screen a long press is the two buttons, not the browser's menu.
          if (lastTouch.current) event.preventDefault();
        }}
        onDragStart={(event) => event.preventDefault()}
        className={cn(
          "group relative flex touch-pan-y select-none items-center gap-2 px-4 [-webkit-touch-callout:none] lg:px-3",
          selected ? "bg-muted" : "bg-background"
        )}
      >
        {children}
        <span
          data-row-actions=""
          data-revealed={revealed ? "" : undefined}
          className={cn(
            "absolute inset-y-0 right-0 flex items-center gap-1 pl-3 pr-4 lg:pr-3",
            // The text under the buttons fades out instead of being cut.
            "before:pointer-events-none before:absolute before:inset-y-0 before:-left-6 before:w-6 before:bg-gradient-to-r before:from-transparent",
            selected ? "bg-muted before:to-muted" : "bg-background before:to-background",
            "pointer-events-none opacity-0 transition-opacity duration-150 motion-reduce:transition-none",
            "[@media(hover:hover)]:group-hover:pointer-events-auto [@media(hover:hover)]:group-hover:opacity-100",
            "group-focus-within:pointer-events-auto group-focus-within:opacity-100",
            "data-[revealed]:pointer-events-auto data-[revealed]:opacity-100",
            "group-data-[dragging]:invisible",
            leaving && "invisible"
          )}
        >
          {(["right", "left"] as const).map((side) => {
            const action = actions[side];
            if (!action) return null;
            const Icon = ACTION_ICON[action.kind];
            return (
              <button
                key={side}
                type="button"
                aria-label={action.label}
                title={action.label}
                disabled={busy || leaving}
                onClick={() => run(side, slider.current?.offsetWidth ?? 0)}
                className={cn(
                  "inline-flex h-11 w-11 items-center justify-center rounded-md border border-foreground/15 bg-background disabled:opacity-50 md:h-8 md:w-8",
                  action.kind === "skip"
                    ? "text-rose-700 hover:bg-rose-50 dark:text-rose-300 dark:hover:bg-rose-950"
                    : "text-emerald-700 hover:bg-emerald-50 dark:text-emerald-300 dark:hover:bg-emerald-950"
                )}
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
              </button>
            );
          })}
        </span>
      </div>
    </div>
  );
}

/** Skip is red wherever it sits; every other action is green. */
function underColour(action: SwipeAction): string {
  return action.kind === "skip" ? "bg-rose-600" : "bg-emerald-600";
}

/** The icon and the word an action shows under the row; faded in by the slide. */
function SideLabel({ action, iconAfter = false }: { action: SwipeAction; iconAfter?: boolean }) {
  const Icon = ACTION_ICON[action.kind];
  return (
    <span className="inline-flex items-center gap-2 text-sm font-semibold opacity-0">
      {!iconAfter && <Icon className="h-4 w-4" aria-hidden="true" />}
      {action.label}
      {iconAfter && <Icon className="h-4 w-4" aria-hidden="true" />}
    </span>
  );
}

/**
 * The open item where it sits in the list (a phone, a narrow window). Who
 * posted it and the Close button are the item's own header, beside the
 * author's picture (`PostHeader`, with `CloseItem` at its end): until
 * 2026-11-10 this box printed the row's line above the item.
 */
export function OpenInPlace({ target, card = false, children }: { target: PlacementTargetRecord; card?: boolean; children: ReactNode }) {
  return (
    <div
      // `card`: To do's open reply on Today (2026-11-14), on top of the screen, a card of its own. On the
      // page's own background: the item's button row is sticky over that colour while a long draft scrolls.
      className={card ? "rounded-xl border border-border bg-background px-4 pb-4 pt-3" : "border-y-2 border-foreground bg-background px-4 pb-4 pt-3"}
      data-open-item={target.id}
    >
      {children}
    </div>
  );
}

/**
 * A group's heading in the list: "Yours · 4". "Found for you" also says when
 * discovery last searched, or what a run is doing ("Found for you · 49 ·
 * last search 2h ago"), in the note, which is not upper-cased.
 */
export function GroupHeading({ label, count, note, flush = false }: { label: string; count: number; note?: string | null; flush?: boolean }) {
  return (
    // `flush`: over a bordered list on Today, aligned with "Also today" rather than with the rows' text.
    <h2 className={cn("text-xs font-semibold uppercase tracking-wider text-muted-foreground", flush ? "pt-1 text-[13px]" : "px-4 pb-1 pt-4 lg:px-3")}>
      {label} <span className="font-normal">· {count}</span>
      {note && <span className="font-normal normal-case tracking-normal"> · {note}</span>}
    </h2>
  );
}

/**
 * "2 of 5 today" with its dots when the person set a goal, "2 today"
 * without one. Counted from what was marked as posted, in the browser's
 * time zone; when the zone could not be used the count is in UTC and says
 * so, because near midnight that is a different day.
 */
export function DayCount({
  today,
  browserZone,
  open = false,
  onOpen,
}: {
  today: TodayCount | undefined;
  browserZone: string | null;
  /** The Today sheet is open. */
  open?: boolean;
  /** With it, the count is a button that opens the Today sheet (2026-11-12). */
  onOpen?: () => void;
}) {
  if (!today) return null;
  const dots = todayDots(today);
  const fallback = dayCountFallback(today, browserZone);
  const inner = (
    <>
      <span>
        {todayLabel(today)}
        {fallback && " (UTC)"}
      </span>
      {dots.length > 0 && (
        <span className="inline-flex items-center gap-0.5" aria-hidden="true">
          {dots.map((done, i) => (
            <span key={i} className={cn("h-2 w-2 rounded-full", done ? "bg-foreground" : "bg-foreground/15")} />
          ))}
        </span>
      )}
    </>
  );
  if (!onOpen) {
    return (
      <span className="inline-flex items-center gap-2 text-xs text-muted-foreground" title={`Replies marked as posted today (${today.timeZone})`}>
        {inner}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Today's replies: ${today.goal ? `${today.posted} of ${today.goal}` : today.posted}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      title={`Replies marked as posted today (${today.timeZone})`}
      className="-mr-2 inline-flex min-h-11 items-center gap-2 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground lg:mr-0 lg:min-h-9"
    >
      {inner}
    </button>
  );
}

/** Whether the count was read in UTC because the browser's zone could not be used: then it says so. */
export function dayCountFallback(today: Pick<TodayCount, "timeZone">, browserZone: string | null): boolean {
  return today.timeZone === "UTC" && browserZone !== "UTC";
}
