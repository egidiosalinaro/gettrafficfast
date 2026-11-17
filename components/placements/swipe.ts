import type { PlacementTargetRecord } from "@/lib/placements/read";
import type { DraftFailureKind } from "@/lib/placements/draft-progress";
import type { InboxGroup } from "@/lib/placements/inbox-view";
import { OPEN_STATUSES, preferredDraft, takesReply } from "@/lib/placements/workflow";

/**
 * The swipe on a row of "Found for you" (2026-11-12), without any markup:
 * when a drag becomes a swipe, how far the row follows the pointer, when a
 * release commits, and what each side does for a row in a given state.
 * Kept apart from `QueueRow` so each rule is tested without a browser.
 *
 * The convention is iOS Mail's: the action is revealed under the row as it
 * slides, committed past 40% of the row's width or by a fast fling in the
 * same direction, and below that the row springs back.
 */

export const SWIPE = {
  /** Pixels of motion before the axis is decided: under it a tap is still a tap. */
  slop: 10,
  /** Horizontal wins only when it clearly dominates: a diagonal is a scroll, never a swipe. */
  axisRatio: 1.2,
  /** The share of the row's width past which a release commits. */
  commitFraction: 0.4,
  /** A fling: pixels per millisecond at release (about 600px a second). */
  flingVelocity: 0.6,
  /** A fling still has to travel this far, so a flick of the wrist on a tap commits nothing. */
  flingMinDistance: 48,
  /** How far a side with no action gives before it stops: a hint that nothing is there. */
  deadSideMax: 24,
  /** The velocity is read over the last samples of this window, in milliseconds. */
  velocityWindowMs: 100,
} as const;

export type SwipeSide = "right" | "left";
export type Axis = "x" | "y" | null;

/**
 * Whether a drag is a swipe ("x"), a scroll ("y") or not decided yet (null).
 * Decided once per gesture by the caller: after "y" the browser scrolls the
 * app's scrolling area and the row never moves. Ties go to the scroll.
 */
export function lockAxis(dx: number, dy: number, slop: number = SWIPE.slop): Axis {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < slop && ay < slop) return null;
  return ax > ay * SWIPE.axisRatio ? "x" : "y";
}

/** Which sides have an action. */
export interface SwipeSides {
  right: boolean;
  left: boolean;
}

/**
 * Where the row is drawn for a drag of `dx`. A side with an action follows
 * the pointer up to the row's width; a side without one gives a little and
 * stops, so the row never slides over nothing.
 */
export function swipeOffset(dx: number, width: number, sides: SwipeSides): number {
  if (dx === 0) return 0;
  const allowed = dx > 0 ? sides.right : sides.left;
  if (!allowed) {
    const give = Math.min(SWIPE.deadSideMax, Math.abs(dx) * 0.2);
    return dx > 0 ? give : -give;
  }
  return Math.max(-width, Math.min(width, dx));
}

/** The distance past which a release commits. */
export function commitDistance(width: number): number {
  return width * SWIPE.commitFraction;
}

/** How far toward the threshold the row is, 0 to 1: what the colour and the label fade with. */
export function swipeProgress(offset: number, width: number): number {
  const threshold = commitDistance(width);
  if (threshold <= 0) return 0;
  return Math.min(1, Math.abs(offset) / threshold);
}

/** Past the threshold: the label is at full strength and the phone ticks once. */
export function pastThreshold(offset: number, width: number): boolean {
  return width > 0 && Math.abs(offset) >= commitDistance(width);
}

/**
 * Which side a release commits, or null to spring back. Past the threshold
 * it commits unless the pointer was flung back toward the centre; under it a
 * fling in the same direction commits once the row has travelled a little.
 */
export function releaseSide(input: { offset: number; width: number; velocity: number; sides: SwipeSides }): SwipeSide | null {
  const { offset, width, velocity, sides } = input;
  if (offset === 0 || width <= 0) return null;
  const side: SwipeSide = offset > 0 ? "right" : "left";
  if (!sides[side]) return null;
  const fast = Math.abs(velocity) >= SWIPE.flingVelocity;
  const sameWay = Math.sign(velocity) === Math.sign(offset);
  if (fast && !sameWay) return null;
  if (pastThreshold(offset, width)) return side;
  if (fast && sameWay && Math.abs(offset) >= SWIPE.flingMinDistance) return side;
  return null;
}

/** A pointer position at a moment, for the velocity. */
export interface Sample {
  x: number;
  t: number;
}

/** Pixels per millisecond over the last samples (`velocityWindowMs`); 0 with fewer than two. */
export function velocityOf(samples: readonly Sample[]): number {
  if (samples.length < 2) return 0;
  const last = samples[samples.length - 1];
  let first = samples[samples.length - 2];
  for (let i = samples.length - 2; i >= 0; i--) {
    if (last.t - samples[i].t > SWIPE.velocityWindowMs) break;
    first = samples[i];
  }
  const dt = last.t - first.t;
  return dt > 0 ? (last.x - first.x) / dt : 0;
}

/* ── What each side does ─────────────────────────────────────────────── */

/**
 * One side's action: `draft` starts the draft job (the item's Draft it),
 * `open` opens the item in the list (a tap on the row), `open_article`
 * opens a list article in a new tab (the item's Open the article), `skip`
 * is the item's Skip (dismiss, no reason).
 */
export interface SwipeAction {
  kind: "draft" | "open" | "open_article" | "skip";
  label: string;
}

export interface RowSwipeActions {
  right: SwipeAction | null;
  left: SwipeAction | null;
}

const SKIP: SwipeAction = { kind: "skip", label: "Skip" };
const DRAFT: SwipeAction = { kind: "draft", label: "Draft it" };
const OPEN: SwipeAction = { kind: "open", label: "Open" };
const OPEN_ARTICLE: SwipeAction = { kind: "open_article", label: "Open article" };

/**
 * What a swipe does on a row, by its state. "Right" and "left" are the
 * directions of the swipe: a swipe to the right reveals the left edge, where
 * Skip is; a swipe to the left reveals the right edge, where the primary is.
 * The primary (the "other side" below) never drafts twice and never spends
 * behind the person's back:
 *
 * - no draft yet (Draft it), or a draft that failed (Draft failed): right
 *   is Draft it, the same request as the item's button, under the same caps;
 * - Writing…: right is nothing, the draft is on its way;
 * - Draft ready, Check failed: right opens the item, where the draft is;
 * - Not drafted (the drafter declined): right opens the item, because
 *   writing it anyway overrides a judgment and its reason is read first;
 * - a list article (Ask to be listed): right opens the article, nothing is
 *   written for it;
 * - a post that is not open (not sorted yet, skipped, filtered out): right
 *   opens the item.
 *
 * Left is Skip wherever the item offers Skip (an open post, or one not
 * sorted yet), and nothing elsewhere.
 */
export function rowSwipeActions(
  target: Pick<PlacementTargetRecord, "status" | "kind" | "drafts">,
  options: { writing?: boolean; failure?: DraftFailureKind | null } = {}
): RowSwipeActions {
  // The owner's choice (2026-11-12): Skip is revealed on the left of the
  // screen (a swipe to the right), the primary on the right (a swipe to the
  // left). The colours follow the action, not the side.
  const canAct = OPEN_STATUSES.includes(target.status);
  const right = canAct || target.status === "discovered" ? SKIP : null;
  if (options.writing) return { right, left: null };
  if (!canAct) return { right, left: OPEN };
  if (!takesReply(target.kind)) return { right, left: OPEN_ARTICLE };
  if (preferredDraft(target.drafts)) return { right, left: OPEN };
  if (options.failure === "declined") return { right, left: OPEN };
  return { right, left: DRAFT };
}

/**
 * Which rows swipe: the closed rows of "Found for you" in the grouped list.
 * "Yours" keeps the tap only, and the open item is never a row that slides.
 */
export function rowSwipes(row: { grouped: boolean; group: InboxGroup; open: boolean }): boolean {
  return row.grouped && row.group === "found" && !row.open;
}

/* ── The first-time hint ─────────────────────────────────────────────── */

/** Where the hint's "seen" is kept in the browser. */
export const SWIPE_HINT_KEY = "gtf.replies.swipe-hint";

/** Whether the hint was already played, read defensively: storage can be missing or throw. */
export function swipeHintSeen(storage: Pick<Storage, "getItem"> | null | undefined): boolean {
  try {
    return storage?.getItem(SWIPE_HINT_KEY) === "1";
  } catch {
    // Storage refused (a private window): treat it as seen, so the hint never repeats on every visit.
    return true;
  }
}

export function markSwipeHintSeen(storage: Pick<Storage, "setItem"> | null | undefined): void {
  try {
    storage?.setItem(SWIPE_HINT_KEY, "1");
  } catch {
    // Nothing to keep it in: the hint is a nicety.
  }
}

/**
 * Where a row ends when its action takes it off the list: off the screen in
 * the direction it was swiped, so the action it revealed fills the row.
 */
export function leaveOffset(side: SwipeSide, width: number): number {
  return side === "right" ? width : -width;
}
