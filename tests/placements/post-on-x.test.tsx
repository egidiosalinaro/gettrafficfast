import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { PlacementTargetRecord } from "@/lib/placements/read";
import { ReplyItem } from "@/components/placements/reply-item";
import { postOnXThenFallback } from "@/components/placements/reply-logic";
import { XAccountCard, XPostingRow, xConnectErrorLine } from "@/components/settings/x-account";
import { ONBOARDING_STEPS, buildOnboardingStatus, nextOnboardingStep, onboardingSteps } from "@/lib/onboarding";

/**
 * Post on X on the screens (2026-11-24): the button replaces Reply on X only
 * on a post X lets the site reply to, and only with a connected account; a
 * refused reply opens X's composer in the same press; Settings offers the
 * connection only where the deployment has the OAuth client; and the
 * onboarding asks for it there, until it is connected. Fictional handles:
 * the site posts as @samrivdev.
 */

const THREAD = "1850000000000000000";

function target(text: string, over: Partial<PlacementTargetRecord> = {}): PlacementTargetRecord {
  return {
    id: "t-1",
    surface: "x",
    kind: "post",
    url: `https://x.com/postwren/status/${THREAD}`,
    title: text,
    excerpt: text,
    community: "@postwren",
    author: "postwren",
    postedAt: "2026-11-24T08:00:00.000Z",
    postedAtPrecision: null,
    score: null,
    commentCount: null,
    foundFor: null,
    foundVia: null,
    status: "drafted",
    qualifyScore: null,
    qualifyReason: null,
    qualifyAngle: null,
    qualifiedBy: null,
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
    createdAt: "2026-11-24T08:10:00.000Z",
    drafts: [
      {
        id: "d-1",
        variant: "short_comment",
        body: "We keep release notes in the repo.",
        linkUrl: null,
        claims: [],
        audit: { status: "passed", checks: [] },
        auditStatus: "passed",
        agentVersion: 16,
        updatedAt: "2026-11-24T08:20:00.000Z",
      },
    ],
    ...over,
  };
}

function render(t: PlacementTargetRecord, posting: { username?: string | null; handler?: boolean } = {}) {
  return renderToStaticMarkup(
    <ReplyItem
      target={t}
      now={Date.parse("2026-11-24T10:00:00Z")}
      busy={false}
      replied={false}
      onRepliedChange={() => {}}
      onDraft={() => {}}
      onAction={() => {}}
      onMarkPublished={async () => null}
      onSaveDraft={async () => ({ ok: false as const, error: "x" })}
      onSaveOwnReply={async () => ({ ok: false as const, error: "x" })}
      onCorrectDraft={async () => ({ ok: false as const, error: "x" })}
      onPromoteNote={async () => ({ ok: false as const, error: "x" })}
      xPostingUsername={posting.username ?? null}
      onPostOnX={posting.handler === false ? undefined : async () => ({ ok: true as const })}
    />
  );
}

describe("the draft's primary button", () => {
  it("is Post on X on a post that mentions the connected account", () => {
    const html = render(target("@samrivdev which tool do you use for release notes?"), { username: "samrivdev" });
    expect(html).toContain("Post on X");
    expect(html).toContain("Posts this reply from @samrivdev now.");
    expect(html).not.toContain(">Reply on X<");
  });

  it("stays Reply on X on every other post, exactly as before", () => {
    const html = render(target("Which tool do you use for release notes?"), { username: "samrivdev" });
    expect(html).not.toContain("Post on X");
    expect(html).toContain("Reply on X");
  });

  it("stays Reply on X without a connected account, even on a mention", () => {
    expect(render(target("@samrivdev which tool?"), { username: null })).not.toContain("Post on X");
    expect(render(target("@samrivdev which tool?"), { username: "samrivdev", handler: false })).not.toContain("Post on X");
  });

  it("stays Reply anyway on a draft the checks stopped", () => {
    const stopped = target("@samrivdev which tool?");
    stopped.drafts[0] = { ...stopped.drafts[0], auditStatus: "blocked", audit: { status: "blocked", checks: [] } };
    const html = render(stopped, { username: "samrivdev" });
    expect(html).not.toContain("Post on X");
    expect(html).toContain("Reply anyway");
  });
});

describe("postOnXThenFallback", () => {
  const base = { dirty: false, draftId: "d-1", save: async () => null };

  it("posts once, with no tab opened", async () => {
    const post = vi.fn(async () => ({ ok: true as const }));
    const open = vi.fn();
    expect(await postOnXThenFallback({ ...base, post, open })).toEqual({ kind: "posted" });
    expect(post).toHaveBeenCalledWith("d-1");
    expect(open).not.toHaveBeenCalled();
  });

  it("opens X's composer in the same press when X does not allow the reply, and says so", async () => {
    const open = vi.fn();
    const outcome = await postOnXThenFallback({
      ...base,
      post: async () => ({ ok: false, error: "X does not let GTF reply to this post", code: "reply_not_allowed", intentUrl: "https://x.com/intent/tweet?text=Hi&in_reply_to=1" }),
      open,
    });
    expect(outcome).toEqual({ kind: "fell_back", message: "X does not let GTF reply to this post" });
    expect(open).toHaveBeenCalledWith("https://x.com/intent/tweet?text=Hi&in_reply_to=1");
  });

  it("says a failure without opening anything", async () => {
    const open = vi.fn();
    expect(await postOnXThenFallback({ ...base, post: async () => ({ ok: false, error: "Paused", code: "cap_reached" }), open })).toEqual({ kind: "failed", message: "Paused" });
    expect(open).not.toHaveBeenCalled();
  });

  it("saves an edited draft first, posts the saved one, and never posts one the checks stop", async () => {
    const post = vi.fn(async () => ({ ok: true as const }));
    expect(await postOnXThenFallback({ dirty: true, draftId: "d-1", save: async () => ({ id: "d-1", auditStatus: "passed" }), post, open: vi.fn() })).toEqual({ kind: "posted" });
    expect(await postOnXThenFallback({ dirty: true, draftId: "d-1", save: async () => ({ id: "d-1", auditStatus: "blocked" }), post, open: vi.fn() })).toEqual({ kind: "blocked" });
    expect(await postOnXThenFallback({ dirty: true, draftId: "d-1", save: async () => null, post, open: vi.fn() })).toEqual({ kind: "save_failed" });
    expect(post).toHaveBeenCalledTimes(1);
  });
});

describe("Settings → Connections → X", () => {
  it("offers the connection only where the deployment has the OAuth client", () => {
    const off = renderToStaticMarkup(<XAccountCard saved={null} inferred={null} available hasBusiness posting={{ available: false, account: null }} />);
    expect(off).not.toContain("The X account GTF posts from");
    expect(off).not.toContain("/api/integrations/x/connect");
    const on = renderToStaticMarkup(<XAccountCard saved={null} inferred={null} available hasBusiness posting={{ available: true, account: null }} />);
    expect(on).toContain("Connect the X account GTF posts from");
    expect(on).toContain('action="/api/integrations/x/connect"');
    expect(on).toContain('method="post"');
  });

  it("shows the connected account with Disconnect, and no longer asks for the username", () => {
    const html = renderToStaticMarkup(
      <XAccountCard saved="samrivdev" inferred={null} available hasBusiness posting={{ available: true, account: { username: "samrivdev", status: "connected" } }} />
    );
    expect(html).toContain("@samrivdev");
    expect(html).toContain("Disconnect");
    expect(html).not.toContain("Your X account");
  });

  it("asks to connect again when X refused the token", () => {
    const html = renderToStaticMarkup(<XPostingRow account={{ username: "samrivdev", status: "error" }} />);
    expect(html).toContain("X no longer accepts the connection to @samrivdev");
    expect(html).toContain("Connect again");
  });

  it("says why a connection did not go through", () => {
    expect(xConnectErrorLine("denied")).toContain("cancelled on X");
    expect(xConnectErrorLine("anything")).toContain("could not be connected");
  });
});

describe("onboarding: Connect your X account", () => {
  const done = { hasBusiness: true, aboutYou: "I use it.", imageStyleChosen: true, keywordCount: 1, articleCount: 1, integrationCount: 1, manualPostCount: 1 };

  it("is a step only where the deployment offers posting on X", () => {
    expect(onboardingSteps(buildOnboardingStatus(done)).map((s) => s.key)).not.toContain("hasXAccount");
    expect(nextOnboardingStep(buildOnboardingStatus(done))).toBeNull();
    const offered = buildOnboardingStatus({ ...done, xPostingOffered: true });
    expect(onboardingSteps(offered).map((s) => s.key)).toEqual(ONBOARDING_STEPS.map((s) => s.key));
    expect(nextOnboardingStep(offered)?.key).toBe("hasXAccount");
  });

  it("starts X's consent screen for the selected site, and is done once connected", () => {
    expect(ONBOARDING_STEPS.find((s) => s.key === "hasXAccount")?.href).toBe("/api/integrations/x/connect");
    expect(nextOnboardingStep(buildOnboardingStatus({ ...done, xPostingOffered: true, xPostingAccountCount: 1 }))).toBeNull();
  });
});
