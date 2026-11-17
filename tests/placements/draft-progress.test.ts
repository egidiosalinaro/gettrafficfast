import { describe, expect, it } from "vitest";
import {
  DRAFT_PAUSED_BILLING,
  DRAFT_PAUSED_UNAVAILABLE,
  declinedByModelMessage,
  declinedMessage,
  draftFailureForCard,
  draftFinishedMessage,
  draftGaveUpWaitingMessage,
  draftStillWaitingMessage,
  draftWaitMessage,
} from "@/lib/placements/draft-progress";
import { draftingTargetIdsFromJobs, lastDraftFailuresFromJobs } from "@/lib/placements/read";
import { DRAFT_LOCK_LIVE_MS, draftLockIsLive, shouldResumeDraft } from "@/lib/placements/runs";

describe("draft progress copy", () => {
  it("is short: writing, still writing, ready, ready with a check to look at", () => {
    expect(draftWaitMessage()).toBe("Writing your reply…");
    expect(draftStillWaitingMessage()).toBe("Still writing, almost there.");
    expect(draftGaveUpWaitingMessage()).toContain("the reason will be on this card");
    expect(draftFinishedMessage("drafted", 1)).toBe("Ready.");
    expect(draftFinishedMessage("needs_review", 3)).toBe("Ready, but a check needs a look.");
    // A variant missing from the card is still named.
    expect(draftFinishedMessage("drafted", 3, ["short_comment"])).toBe("Ready. The reply didn't pass the check, so it wasn't saved.");
    expect(draftFinishedMessage("drafted", 3, ["detailed_answer", "article_draft"])).toContain(
      "The long reply and The post didn't pass the check, so they weren't saved."
    );
  });
});

describe("a draft the person is waiting on", () => {
  it("reads target ids off the queued jobs and ignores anything else", () => {
    expect(
      draftingTargetIdsFromJobs([
        { input: { targetId: "t-1" } },
        { input: { targetId: "t-1" } },
        { input: { businessId: "b" } },
        { input: null },
      ])
    ).toEqual(["t-1"]);
  });

  it("resumes a job that is waiting, and one whose worker was killed, and leaves a live one alone", () => {
    const now = Date.parse("2026-10-08T11:18:35Z");
    expect(shouldResumeDraft({ status: "pending", lockedAt: null }, now)).toBe(true);
    expect(
      shouldResumeDraft(
        { status: "running", lockedAt: new Date(now - DRAFT_LOCK_LIVE_MS - 1).toISOString() },
        now
      )
    ).toBe(true);
    expect(
      shouldResumeDraft({ status: "running", lockedAt: new Date(now - 1_000).toISOString() }, now)
    ).toBe(false);
    expect(draftLockIsLive(null, now)).toBe(false);
    expect(shouldResumeDraft({ status: "completed", lockedAt: null }, now)).toBe(false);
  });
});

describe("a draft that ended without text", () => {
  it("declines in plain words: the true reason, then what the person can do", () => {
    const declined = declinedByModelMessage("Outside the business's core expertise in AI SEO content.");
    expect(declined).toBe(
      'Not drafted: the AI found nothing worth saying in this thread ("Outside the business\'s core expertise in AI SEO content"). Your call: write it anyway, open it, or reject it.'
    );
    // The old stock sentence named a reason the model never gave.
    expect(declined).not.toContain("advert");
    expect(declinedByModelMessage("")).toBe(
      "Not drafted: the AI found nothing worth saying in this thread. Your call: write it anyway, open it, or reject it."
    );
    expect(declinedMessage("every angle was the product.")).toBe(
      "Not drafted: every angle was the product. Your call: write it anyway, open it, or reject it."
    );
    expect(draftFailureForCard(declined)).toEqual({ kind: "declined", text: declined });
  });

  it("shows a billing failure as one line saying drafting is paused, never the vendor's text or a verdict", () => {
    // The text two runs stored on 8 November 2026.
    const stored =
      "Gemini credits are depleted. Generation stays paused until billing is topped up. The fallback failed too: Claude refused the call because the account cannot pay: [400 invalid_request_error] Your credit balance is too low to access the Anthropic API.";
    const card = draftFailureForCard(stored);
    expect(card).toEqual({ kind: "paused", text: DRAFT_PAUSED_BILLING });
    expect(card.text).toBe("Drafting is paused: the AI provider's credits ran out. Top up and press Generate draft again.");
    expect(card.text).not.toMatch(/Gemini|Claude|Anthropic/);
    expect(draftFailureForCard("Claude refused the call because the account cannot pay: [402 error]").kind).toBe("paused");
  });

  it("shows a provider that did not answer as paused, and passes the job's own sentences through", () => {
    expect(draftFailureForCard("Gemini did not answer in time. The fallback failed too: Claude did not answer in time.")).toEqual({
      kind: "paused",
      text: DRAFT_PAUSED_UNAVAILABLE,
    });
    const refused = "No draft was saved, because none passed the check. short comment — Too long.";
    expect(draftFailureForCard(refused)).toEqual({ kind: "failed", text: refused });
    expect(draftFailureForCard(null).kind).toBe("failed");
  });
});

describe("how the last draft ended, after a reload", () => {
  it("keeps the newest job's decline or failure per target, and forgets one a later draft replaced", () => {
    const declined = declinedMessage("the rules say this thread is a giveaway");
    const failures = lastDraftFailuresFromJobs([
      // Newest first, as the inbox reads them.
      { input: { targetId: "t-ok" }, status: "completed", last_error: null },
      { input: { targetId: "t-declined" }, status: "failed", last_error: declined },
      { input: { targetId: "t-ok" }, status: "failed", last_error: "older failure" },
      { input: { targetId: "t-broken" }, status: "failed", last_error: "Validation failed: body too short" },
      { input: { targetId: "t-running" }, status: "running", last_error: null },
      { input: null, status: "failed", last_error: "no target" },
    ]);
    expect(failures).toEqual({
      "t-declined": { kind: "declined", text: declined },
      "t-broken": { kind: "failed", text: "Validation failed: body too short" },
    });
  });
});
