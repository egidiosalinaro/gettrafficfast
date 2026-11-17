import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueueRow } from "@/components/placements/queue";
import {
  SWIPE,
  SWIPE_HINT_KEY,
  commitDistance,
  lockAxis,
  markSwipeHintSeen,
  pastThreshold,
  releaseSide,
  rowSwipeActions,
  rowSwipes,
  swipeHintSeen,
  swipeOffset,
  swipeProgress,
  velocityOf,
} from "@/components/placements/swipe";
import { Toast } from "@/components/placements/toast";
import { leftToast } from "@/lib/placements/inbox-view";
import type { PlacementDraftRecord, PlacementTargetRecord } from "@/lib/placements/read";

/**
 * The swipe on the rows of "Found for you" (2026-11-12): a swipe to the right
 * is Skip (revealed on the left), a swipe to the left is Draft it, or opens
 * what is already there (revealed on the right), as the owner asked.
 * The gesture's rules are pure and tested here without a browser; the row
 * is server-rendered for its structure, not its pixels.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = (relativePath: string) => readFileSync(path.join(root, relativePath), "utf8");
const NOW = Date.parse("2026-11-12T09:30:00Z");
const ago = (h: number) => new Date(NOW - h * 3600_000).toISOString();
const noop = () => {};
const BOTH = { right: true, left: true };

const draft = (over: Partial<PlacementDraftRecord> = {}): PlacementDraftRecord => ({
  id: "d-1",
  variant: "short_comment",
  body: "Answer engines retrieve passages, not pages.",
  linkUrl: null,
  claims: [],
  audit: { status: "passed", checks: [] },
  auditStatus: "passed",
  agentVersion: 1,
  updatedAt: "2026-11-12T00:00:00Z",
  ...over,
});

const target = (over: Partial<PlacementTargetRecord> = {}): PlacementTargetRecord => ({
  id: "t-1",
  surface: "reddit",
  kind: "thread",
  url: "https://www.reddit.com/r/SEO/comments/1abc2d/x/",
  title: "How do I get my site cited by AI answer engines?",
  excerpt: "Our SEO is fine but ChatGPT never mentions us.",
  community: "r/SEO",
  author: "u/asker",
  postedAt: ago(3),
  postedAtPrecision: null,
  score: null,
  commentCount: 12,
  foundFor: "ai seo",
  foundVia: "reddit",
  status: "qualified",
  qualifyScore: 82,
  qualifyReason: null,
  qualifyAngle: null,
  qualifiedBy: "agent",
  qualifiedAt: ago(2),
  topic: null,
  intent: "question",
  freshUntil: null,
  snoozedUntil: null,
  reviewNote: null,
  dismissedReason: null,
  publishedUrl: null,
  publishedAt: null,
  publishedNote: null,
  aeoQueryId: null,
  selectedPlacementId: null,
  lastSeenAt: ago(1),
  createdAt: ago(2),
  drafts: [],
  ...over,
});

describe("the gesture: when a drag is a swipe", () => {
  it("decides nothing under the slop, so a tap stays a tap", () => {
    expect(lockAxis(0, 0)).toBeNull();
    expect(lockAxis(SWIPE.slop - 1, SWIPE.slop - 1)).toBeNull();
  });

  it("locks to horizontal only when the motion is clearly horizontal; a diagonal or a tie is a scroll", () => {
    expect(lockAxis(20, 3)).toBe("x");
    expect(lockAxis(-20, 5)).toBe("x");
    expect(lockAxis(3, 20)).toBe("y");
    expect(lockAxis(14, 14)).toBe("y");
    expect(lockAxis(15, 13)).toBe("y");
  });
});

describe("the gesture: how far the row follows", () => {
  it("follows the pointer on a side with an action, never past the row's width", () => {
    expect(swipeOffset(120, 390, BOTH)).toBe(120);
    expect(swipeOffset(-500, 390, BOTH)).toBe(-390);
  });

  it("gives a little and stops on a side with no action", () => {
    expect(swipeOffset(50, 390, { right: false, left: true })).toBe(10);
    expect(swipeOffset(300, 390, { right: false, left: true })).toBe(SWIPE.deadSideMax);
    expect(swipeOffset(-300, 390, { right: true, left: false })).toBe(-SWIPE.deadSideMax);
  });

  it("fades the colour and the label in with the distance, full at the threshold", () => {
    expect(commitDistance(400)).toBe(160);
    expect(swipeProgress(0, 400)).toBe(0);
    expect(swipeProgress(80, 400)).toBe(0.5);
    expect(swipeProgress(-240, 400)).toBe(1);
    expect(pastThreshold(159, 400)).toBe(false);
    expect(pastThreshold(-160, 400)).toBe(true);
  });
});

describe("the gesture: what a release does", () => {
  const width = 390;

  it("commits past 40% of the width, on either side", () => {
    expect(releaseSide({ offset: 0.41 * width, width, velocity: 0, sides: BOTH })).toBe("right");
    expect(releaseSide({ offset: -0.41 * width, width, velocity: 0, sides: BOTH })).toBe("left");
  });

  it("springs back below the threshold when the release is slow", () => {
    expect(releaseSide({ offset: 0.3 * width, width, velocity: 0.1, sides: BOTH })).toBeNull();
    expect(releaseSide({ offset: -100, width, velocity: -0.2, sides: BOTH })).toBeNull();
  });

  it("commits a fast fling in the same direction under the threshold, once the row has travelled a little", () => {
    expect(releaseSide({ offset: 80, width, velocity: 1.2, sides: BOTH })).toBe("right");
    expect(releaseSide({ offset: -60, width, velocity: -0.9, sides: BOTH })).toBe("left");
    expect(releaseSide({ offset: 20, width, velocity: 2, sides: BOTH })).toBeNull();
  });

  it("springs back when flung toward the centre, even past the threshold", () => {
    expect(releaseSide({ offset: 0.6 * width, width, velocity: -1, sides: BOTH })).toBeNull();
  });

  it("commits nothing on a side with no action", () => {
    expect(releaseSide({ offset: 300, width, velocity: 2, sides: { right: false, left: true } })).toBeNull();
    expect(releaseSide({ offset: 0, width, velocity: 2, sides: BOTH })).toBeNull();
  });

  it("reads the velocity over the last 100ms of motion", () => {
    expect(velocityOf([])).toBe(0);
    expect(velocityOf([{ x: 0, t: 0 }])).toBe(0);
    expect(
      velocityOf([
        { x: 0, t: 0 },
        { x: 10, t: 300 },
        { x: 40, t: 350 },
        { x: 90, t: 400 },
      ])
    ).toBeCloseTo(0.8);
    expect(velocityOf([{ x: 100, t: 0 }, { x: 40, t: 50 }])).toBeCloseTo(-1.2);
  });
});

describe("what each side does, by the row's state", () => {
  it("not drafted: a swipe left is Draft it, a swipe right is Skip", () => {
    expect(rowSwipeActions(target())).toEqual({ right: { kind: "skip", label: "Skip" }, left: { kind: "draft", label: "Draft it" } });
  });

  it("a draft that failed: a swipe left drafts again, the same request as the item's Draft it", () => {
    expect(rowSwipeActions(target(), { failure: "failed" }).left?.kind).toBe("draft");
  });

  it("writing: a swipe left is nothing (the draft is on its way), Skip stays", () => {
    const actions = rowSwipeActions(target(), { writing: true });
    expect(actions.left).toBeNull();
    expect(actions.right?.kind).toBe("skip");
  });

  it("draft ready and check failed: a swipe left opens the item, never drafts again", () => {
    expect(rowSwipeActions(target({ status: "drafted", drafts: [draft()] })).left).toEqual({ kind: "open", label: "Open" });
    expect(rowSwipeActions(target({ status: "needs_review", drafts: [draft({ auditStatus: "blocked" })] })).left?.kind).toBe("open");
  });

  it("declined: a swipe left opens the item, where the reason and Write it anyway are", () => {
    expect(rowSwipeActions(target(), { failure: "declined" }).left?.kind).toBe("open");
  });

  it("a list article: a swipe left opens the article, nothing is drafted for it", () => {
    expect(rowSwipeActions(target({ kind: "listicle" })).left).toEqual({ kind: "open_article", label: "Open article" });
  });

  it("not sorted yet: a swipe left opens, Skip stays; a skipped or filtered-out post has no Skip", () => {
    expect(rowSwipeActions(target({ status: "discovered" }))).toEqual({ right: { kind: "skip", label: "Skip" }, left: { kind: "open", label: "Open" } });
    expect(rowSwipeActions(target({ status: "dismissed" })).right).toBeNull();
    expect(rowSwipeActions(target({ status: "rejected" })).right).toBeNull();
  });
});

describe("which rows swipe", () => {
  it("only the closed rows of Found for you, in the grouped list", () => {
    expect(rowSwipes({ grouped: true, group: "found", open: false })).toBe(true);
    expect(rowSwipes({ grouped: true, group: "yours", open: false })).toBe(false);
    expect(rowSwipes({ grouped: true, group: "found", open: true })).toBe(false);
    expect(rowSwipes({ grouped: false, group: "found", open: false })).toBe(false);
  });

  it("the page asks rowSwipes for each row and gives the gesture nothing else to decide", () => {
    const page = source("app/(app)/today/page.tsx");
    expect(page).toContain("rowSwipes({ grouped, group, open: target.id === open })");
    // Rows of a list that is not grouped are rendered without a group, so they never swipe.
    expect(page).toContain("(grouped ? row(target, groupOf(target), target.id === hintId) : row(target))");
    // Skip is the item's Skip: the same move, so the same toast and its Undo.
    expect(page).toMatch(/case "skip":\s*return act\(target\.id, "dismiss"\)/);
    // Draft it is the item's Draft it: the same follower, under the same caps.
    expect(page).toMatch(/case "draft":\s*return followDraft\(target\.id, true\)/);
  });
});

describe("a row of Found for you", () => {
  const swipe = (t: PlacementTargetRecord, over: { writing?: boolean } = {}) => ({
    actions: rowSwipeActions(t, over),
    onAction: noop,
  });

  it("keeps its two lines and its word, and slides over the actions it reveals", () => {
    const t = target();
    const html = renderToStaticMarkup(<QueueRow target={t} now={NOW} onOpen={noop} swipe={swipe(t)} />);
    expect(html).toContain("How do I get my site cited by AI answer engines?");
    expect(html).toContain("Draft it");
    expect(html).toContain('data-swipe=""');
    expect(html).toContain('data-under="right"');
    expect(html).toContain('data-under="left"');
    // The browser keeps the vertical scroll; the row takes only a horizontal drag.
    expect(html).toContain("touch-pan-y");
    expect(html).toContain("min-h-14");
  });

  it("carries the two actions as labelled buttons, shown on hover, focus and a long press", () => {
    const t = target();
    const html = renderToStaticMarkup(<QueueRow target={t} now={NOW} onOpen={noop} swipe={swipe(t)} />);
    expect(html).toContain('aria-label="Draft it"');
    expect(html).toContain('aria-label="Skip"');
    expect(html).toContain("group-hover:opacity-100");
    expect(html).toContain("group-focus-within:opacity-100");
    expect(html).toContain("data-[revealed]:opacity-100");
    expect(html.match(/<button/g)).toHaveLength(3);
  });

  it("labels the right button by what it does: Open on a draft ready, Open article on a list article", () => {
    const ready = target({ status: "drafted", drafts: [draft()] });
    expect(renderToStaticMarkup(<QueueRow target={ready} now={NOW} onOpen={noop} swipe={swipe(ready)} />)).toContain('aria-label="Open"');
    const list = target({ kind: "listicle" });
    expect(renderToStaticMarkup(<QueueRow target={list} now={NOW} onOpen={noop} swipe={swipe(list)} />)).toContain('aria-label="Open article"');
  });

  it("while writing, says Writing… with a spinner, offers no Draft it, and its buttons wait", () => {
    const t = target();
    const html = renderToStaticMarkup(<QueueRow target={t} now={NOW} writing busy onOpen={noop} swipe={swipe(t, { writing: true })} />);
    expect(html).toContain("Writing…");
    expect(html).toContain("data-busy");
    expect(html).not.toContain('aria-label="Draft it"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Skip"|<button[^>]*aria-label="Skip"[^>]*disabled=""/);
  });

  it("a row of Yours (no swipe) stays the plain row: one button, no reveal", () => {
    const html = renderToStaticMarkup(<QueueRow target={target({ foundVia: "manual" })} now={NOW} onOpen={noop} />);
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).not.toContain("data-swipe");
    expect(html).not.toContain("touch-pan-y");
  });
});

describe("Undo after a skip", () => {
  it("is the toast a Skip always had: Skipped., with Undo", () => {
    expect(leftToast("dismiss")).toEqual({ text: "Skipped.", action: { label: "Undo" } });
    const html = renderToStaticMarkup(<Toast toast={{ id: 1, text: "Skipped.", action: { label: "Undo", onClick: noop } }} onDismiss={noop} />);
    expect(html).toContain("Skipped.");
    expect(html).toContain("Undo");
  });

  it("brings the post back with reopen, and opens it", () => {
    const page = source("app/(app)/today/page.tsx");
    expect(page).toContain('showToast(leftToast(action), () => act(id, "reopen")');
  });
});

describe("the one-time hint", () => {
  it("is remembered in the browser and read defensively", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(swipeHintSeen(storage)).toBe(false);
    markSwipeHintSeen(storage);
    expect(store.get(SWIPE_HINT_KEY)).toBe("1");
    expect(swipeHintSeen(storage)).toBe(true);
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    // Storage refused: no hint at all rather than one on every visit, and nothing thrown.
    expect(swipeHintSeen(broken)).toBe(true);
    expect(() => markSwipeHintSeen(broken)).not.toThrow();
  });
});

describe("leaving the list", () => {
  it("slides out in the direction it was swiped: a Skip swiped right leaves to the right, over its own red", async () => {
    const { leaveOffset } = await import("@/components/placements/swipe");
    expect(leaveOffset("right", 390)).toBe(390);
    expect(leaveOffset("left", 390)).toBe(-390);
  });
});
