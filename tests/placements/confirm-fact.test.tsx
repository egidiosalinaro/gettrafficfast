import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ReplyItem, type ReplyItemProps } from "@/components/placements/reply-item";
import { confirmableSentences } from "@/components/placements/confirm-fact";
import type { AuditCheck } from "@/lib/placements/audit";
import type { PlacementDraftRecord, PlacementTargetRecord } from "@/lib/placements/read";

/**
 * "It's true: add to About you" on the Replies item (docs/PLACEMENTS.md,
 * 2026-11-12). Server-rendered structure: the action sits under a failed
 * fact check, one per flagged sentence, and under no other check; an audit
 * stored before the gate named its sentences still offers the one it
 * flagged.
 */

const NOW = Date.parse("2026-11-12T10:00:00Z");
const ACTION = "It&#x27;s true: add to About you";
const OWNER_DRAFT =
  "i know that feeling of getting so close to an amazing opportunity, it's rough. but that new fire to go ham on your own startups is what matters most. during the last week i'm going 100% on marketing for both my startups too.";

const factCheck = (over: Partial<AuditCheck> = {}): AuditCheck => ({
  id: "verifiable_claims",
  label: "Nothing invented, and your own facts only where they fit",
  status: "fail",
  detail: "1 sentence(s) with numbers not declared as claims.",
  ...over,
});

const draft = (checks: AuditCheck[], body = OWNER_DRAFT): PlacementDraftRecord => ({
  id: "d-1",
  variant: "short_comment",
  body,
  linkUrl: null,
  claims: [],
  audit: { status: "blocked", checks },
  auditStatus: "blocked",
  agentVersion: 16,
  updatedAt: "2026-11-12T09:00:00Z",
});

const target = (d: PlacementDraftRecord): PlacementTargetRecord =>
  ({
    id: "t-1",
    surface: "x",
    kind: "post",
    url: "https://x.com/asker/status/1900000000000000001",
    title: "got so close to a big opportunity and it fell through",
    excerpt: "got so close to a big opportunity and it fell through",
    community: "@asker",
    author: "asker",
    postedAt: "2026-11-12T07:00:00Z",
    postedAtPrecision: null,
    score: null,
    commentCount: null,
    foundFor: null,
    foundVia: "manual",
    status: "needs_review",
    qualifyScore: null,
    qualifyReason: null,
    qualifyAngle: null,
    qualifiedBy: "person",
    qualifiedAt: null,
    topic: null,
    intent: null,
    freshUntil: null,
    snoozedUntil: null,
    reviewNote: null,
    dismissedReason: null,
    publishedUrl: null,
    publishedAt: null,
    publishedNote: null,
    aeoQueryId: null,
    selectedPlacementId: null,
    lastSeenAt: null,
    createdAt: "2026-11-12T08:00:00Z",
    drafts: [d],
  }) as PlacementTargetRecord;

const noop = () => {};
const none = async () => ({ ok: false as const, error: "not in a test" });

const render = (d: PlacementDraftRecord, over: Partial<ReplyItemProps> = {}) =>
  renderToStaticMarkup(
    <ReplyItem
      target={target(d)}
      now={NOW}
      busy={false}
      replied={false}
      onRepliedChange={noop}
      onDraft={noop}
      onAction={noop}
      onMarkPublished={async () => null}
      onSaveDraft={none}
      onSaveOwnReply={none}
      onCorrectDraft={none}
      onPromoteNote={none}
      onAddFact={none}
      onRemoveFact={none}
      {...over}
    />
  );

const count = (html: string, text: string) => html.split(text).length - 1;

describe("It's true: add to About you", () => {
  it("is offered once under a failed fact check that names one sentence", () => {
    const html = render(draft([factCheck({ confirmable: ["40% of my signups come from reddit."] })]));
    expect(count(html, ACTION)).toBe(1);
    // A quiet line, a 44px target on a phone.
    expect(html).toMatch(/<button[^>]*class="[^"]*min-h-11[^"]*"[^>]*>It&#x27;s true: add to About you<\/button>/);
  });

  it("names each sentence when there are several", () => {
    const html = render(draft([factCheck({ confirmable: ["40% of my signups come from reddit.", "we doubled our traffic."] })]));
    expect(count(html, ACTION)).toBe(2);
    expect(html).toContain("(&quot;we doubled our traffic.&quot;)");
  });

  it("is offered under a warned fact check too", () => {
    expect(count(render(draft([factCheck({ status: "warn", confirmable: ["40% of my signups."] })])), ACTION)).toBe(1);
  });

  it("is not offered under any other check, nor without a handler", () => {
    const other: AuditCheck = { id: "answers_first", label: "Answers the question before anything else", status: "fail", detail: "Opens with the pitch." };
    expect(count(render(draft([other])), ACTION)).toBe(0);
    // Another check carrying sentences is still not the fact check.
    expect(count(render(draft([{ ...other, confirmable: ["x 40%."] }])), ACTION)).toBe(0);
    expect(count(render(draft([factCheck({ confirmable: ["40% of my signups."] })]), { onAddFact: undefined }), ACTION)).toBe(0);
    // A fact check whose failure is not a sentence the person can confirm.
    expect(count(render(draft([factCheck({ detail: "Uses a fact about another product.", confirmable: undefined })])), ACTION)).toBe(0);
  });

  it("offers the owner's sentence on the audit stored on 12 November 2026, which named none", () => {
    const stored = factCheck();
    expect(confirmableSentences(stored, { body: OWNER_DRAFT, claims: [] })).toEqual([
      "during the last week i'm going 100% on marketing for both my startups too.",
    ]);
    expect(count(render(draft([stored])), ACTION)).toBe(1);
  });
});
