import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LinkBox, PostedItem } from "@/components/placements/posted-item";
import { QueueRow } from "@/components/placements/queue";
import { findingToast } from "@/components/placements/link-sheet";
import { rowState } from "@/components/placements/reply-logic";
import type { PlacementTargetRecord } from "@/lib/placements/read";

/**
 * What a posted reply shows while GTF looks for its link on X: the row says
 * "Finding link" instead of "No link", the card says GTF is looking and when
 * it stops (no spinner, no field to fill), once it stopped the paste field is
 * back with why, a found link says so beside the date, and after I posted it
 * the page does not open the link sheet for a reply GTF will look for.
 */

const NOW = Date.parse("2026-11-13T10:05:00Z");
const recorded = async () => null;

const posted = (over: Partial<PlacementTargetRecord> = {}): PlacementTargetRecord => ({
  id: "t-1",
  surface: "x",
  kind: "post",
  url: "https://x.com/asker/status/1900000000000000001",
  title: "How do I get my site cited by AI answer engines?",
  excerpt: "How do I get my site cited by AI answer engines?",
  community: "@asker",
  author: "asker",
  postedAt: "2026-11-13T08:00:00Z",
  postedAtPrecision: null,
  score: null,
  commentCount: null,
  foundFor: null,
  foundVia: "manual",
  status: "published_manually",
  qualifyScore: null,
  qualifyReason: null,
  qualifyAngle: null,
  qualifiedBy: "person",
  qualifiedAt: "2026-11-13T09:00:00Z",
  topic: null,
  intent: null,
  freshUntil: null,
  snoozedUntil: null,
  reviewNote: null,
  dismissedReason: null,
  publishedUrl: null,
  publishedAt: "2026-11-13T10:00:00Z",
  publishedNote: null,
  aeoQueryId: null,
  selectedPlacementId: null,
  lastSeenAt: null,
  createdAt: "2026-11-13T09:00:00Z",
  drafts: [],
  linkSearch: null,
  ...over,
});

const render = (target: PlacementTargetRecord, finding: Parameters<typeof PostedItem>[0]["finding"]) =>
  renderToStaticMarkup(
    <PostedItem target={target} now={NOW} aeoQueries={[]} busy={false} finding={finding} onSetPublishedUrl={recorded} />
  );

describe("the row", () => {
  it("says Finding link while GTF looks, No link otherwise", () => {
    expect(rowState(posted(), { linkLooking: true })).toEqual({ word: "Finding link", tone: "idle" });
    expect(rowState(posted())).toEqual({ word: "No link", tone: "warn" });
    expect(rowState(posted({ publishedUrl: "https://x.com/me/status/2" }), { linkLooking: true })).toEqual({ word: "Linked", tone: "ready" });
    const html = renderToStaticMarkup(<QueueRow target={posted()} now={NOW} onOpen={() => {}} linkLooking />);
    expect(html).toContain("Finding link");
  });
});

describe("the card", () => {
  it("while looking: says so and when it stops, Paste link a quiet chip, no field", () => {
    const html = render(posted(), { state: "looking", stopsBy: "2026-11-13T22:05:00Z" });
    expect(html).toContain("GTF is looking for this reply on X and will add its link. It stops by");
    expect(html).toContain("Paste link");
    expect(html).not.toContain('type="url"');
    expect(html).not.toContain("animate-spin");
  });

  it("once stopped: says why, and the paste field is back", () => {
    const html = render(posted(), { state: "stopped", outcome: "ambiguous" });
    expect(html).toContain("GTF found more than one reply of yours there and could not tell which one this is.");
    expect(html).toContain('type="url"');
  });

  it("where GTF does not look: the paste field as before, and nothing about X", () => {
    const html = render(posted(), { state: "off" });
    expect(html).toContain('type="url"');
    expect(html).not.toContain("GTF");
  });

  it("a found link is shown like any link, with a small note", () => {
    const found = "https://x.com/me/status/1900000000000000101";
    const html = render(posted({ publishedUrl: found, linkSource: "found_on_x" }), null);
    expect(html).toContain(`href="${found}"`);
    expect(html).toContain("link found on X");
    expect(render(posted({ publishedUrl: found, linkSource: "person" }), null)).not.toContain("found on X");
  });
});

describe("the list and I posted it", () => {
  it("the Posted, no link box says how many GTF is still looking for", () => {
    const html = renderToStaticMarkup(
      <LinkBox busy={false} result={null} candidates={[]} looking={2} now={NOW} onLinks={async () => {}} onPick={recorded} onDismissPick={() => {}} />
    );
    expect(html).toContain("GTF is looking for 2 of these on X by itself.");
  });

  it("does not open the link sheet for a reply GTF will look for, and keeps the Undo", () => {
    expect(findingToast()).toEqual({ text: "Posted. GTF will find its link on X.", action: { label: "Undo" } });
    const page = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../app/(app)/today/page.tsx"), "utf8");
    expect(page).toContain('if (lookingNow(target, Boolean(data?.hasBusiness && data.findsReplyLinks))) showToast(findingToast(), () => undoPosted(id));');
    expect(page).toContain('return linkFinding(target, { finderOn, now: Date.now() })?.state === "looking";');
    expect(page).toContain("else setLinkSheet(target);");
  });
});
