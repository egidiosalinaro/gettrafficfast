import { describe, expect, it } from "vitest";
import { applyRules, contentTokens, expiryOf, freshUntil, type RuleContext, type RuleTarget } from "@/lib/placements/rules";
import {
  OPEN_STATUSES,
  draftPrerequisite,
  planManualAction,
  preferredDraft,
  statusAfterAudit,
  transition,
  variantsFor,
} from "@/lib/placements/workflow";
import { parseVoiceSettings } from "@/lib/voice/settings";

/**
 * The deterministic gate before the model. Every rejection here saves a paid
 * call and names its rule; every pass is honest about what it does not know.
 */

const now = new Date("2026-09-21T12:00:00Z");

const ctx = (over: Partial<RuleContext> = {}): RuleContext => ({
  now,
  ownDomains: ["gettrafficfa.st"],
  expertise: ["ai seo", "answer engine optimization", "citation rate"],
  ...over,
});

const target = (over: Partial<RuleTarget> = {}): RuleTarget => ({
  surface: "reddit",
  kind: "thread",
  url: "https://www.reddit.com/r/SEO/comments/1abc2d/x/",
  title: "How do I get my site cited by AI answer engines?",
  excerpt: "My SEO is fine but ChatGPT never mentions us.",
  community: "r/SEO",
  posted_at: "2026-09-10T00:00:00Z",
  comment_count: 12,
  found_for: "ai seo",
  ...over,
});

describe("applyRules", () => {
  it("passes a fresh, public, on-topic thread with no flags", () => {
    expect(applyRules(target(), ctx())).toEqual({ status: "pass", flags: [] });
  });

  it("rejects a page on the business's own site", () => {
    const out = applyRules(target({ url: "https://blog.gettrafficfa.st/post", surface: "web", kind: "article" }), ctx());
    expect(out).toMatchObject({ status: "rejected", rule: "own_site" });
  });

  it("rejects closed or login-walled surfaces", () => {
    expect(applyRules(target({ url: "https://www.facebook.com/groups/seo/posts/1", surface: "web", kind: "post" }), ctx())).toMatchObject({ rule: "not_public" });
  });

  it("rejects pages nobody can reply to, on any surface", () => {
    expect(applyRules(target({ kind: "page" }), ctx())).toMatchObject({ rule: "not_answerable" });
    expect(applyRules(target({ surface: "web", kind: "page", url: "https://example.com/blog" }), ctx())).toMatchObject({ rule: "not_answerable" });
    expect(applyRules(target({ surface: "quora", kind: "page", url: "https://www.quora.com/topic/SEO" }), ctx())).toMatchObject({ rule: "not_answerable" });
    expect(applyRules(target({ surface: "devto", kind: "page", url: "https://dev.to/t/seo" }), ctx())).toMatchObject({ rule: "not_answerable" });
  });

  it("lets a community question through: it is a thread, not a page", () => {
    // These used to arrive as `web` pages and were all rejected here, so the
    // whole communities search scope was paid for and thrown away.
    const hn = applyRules(
      target({ surface: "hackernews", kind: "thread", url: "https://news.ycombinator.com/item?id=40296399", community: "Hacker News", comment_count: null }),
      ctx()
    );
    expect(hn).toMatchObject({ status: "pass", flags: ["engagement_unknown"] });
    const quora = applyRules(
      target({ surface: "quora", kind: "thread", url: "https://www.quora.com/How-do-I-get-cited-by-AI", community: "Quora", comment_count: null }),
      ctx()
    );
    expect(quora.status).toBe("pass");
  });

  it("rejects a stale thread, with the age in the reason, but never an evergreen list", () => {
    const stale = applyRules(
      target({ surface: "hackernews", url: "https://news.ycombinator.com/item?id=40296399", community: "Hacker News", posted_at: "2025-12-01T00:00:00Z" }),
      ctx()
    );
    expect(stale).toMatchObject({ status: "rejected", rule: "stale" });
    expect((stale as { reason: string }).reason).toMatch(/294 days old/);

    const list = applyRules(
      target({ surface: "github", kind: "repository", url: "https://github.com/o/awesome-seo", title: "o/awesome-seo", excerpt: "A curated list of AI SEO tools", posted_at: "2024-01-01T00:00:00Z", comment_count: null }),
      ctx()
    );
    expect(list.status).toBe("pass");
  });

  it("rejects promotional, hiring and adult threads", () => {
    expect(applyRules(target({ title: "We're hiring an SEO specialist (remote)" }), ctx())).toMatchObject({ rule: "promotional" });
    expect(applyRules(target({ title: "Best AI SEO tools discount code inside" }), ctx())).toMatchObject({ rule: "promotional" });
  });

  it("rejects a thread that shares nothing with what the business knows", () => {
    const out = applyRules(target({ title: "Which cast iron pan should I buy for a gas stove?", excerpt: "Lodge or Field?", found_for: null }), ctx());
    expect(out).toMatchObject({ rule: "no_overlap" });
  });

  it("does not apply the overlap rule when the business has no expertise recorded yet", () => {
    expect(applyRules(target({ title: "Which cast iron pan should I buy?", excerpt: "", found_for: null }), ctx({ expertise: [] })).status).toBe("pass");
  });

  it("flags what it cannot know instead of rejecting on it", () => {
    const out = applyRules(target({ posted_at: null, comment_count: null }), ctx());
    expect(out).toEqual({ status: "pass", flags: ["date_unknown", "engagement_unknown"] });
  });

  describe("archived Reddit threads", () => {
    // 29 September 2026: a person drafted a reply and found "Post archived.
    // No new comments or votes" on the thread. A thread Reddit takes no
    // comment on is not a placement, whatever its topic.
    const late = ctx({ now: new Date("2026-09-29T12:00:00Z"), redditArchivedBelow: "1rsqq3t" });

    it("rejects a dated thread six months old as archived, naming the reason a person can act on", () => {
      const out = applyRules(target({ external_id: "1l4x1q0", posted_at: "2025-06-06T00:00:00Z" }), late);
      expect(out).toMatchObject({ status: "rejected", rule: "archived" });
      expect((out as { reason: string }).reason).toMatch(/Archived on Reddit: at least 480 days old/);
      expect((out as { reason: string }).reason).toMatch(/nowhere to post the reply/);
      // Exactly six months is archived; a day short is not archived, only
      // past the 30-day window to reply to a Reddit thread (2026-11-13).
      expect(applyRules(target({ posted_at: "2026-04-02T12:00:00Z" }), late)).toMatchObject({ rule: "archived" });
      expect(applyRules(target({ posted_at: "2026-04-03T12:00:00Z" }), late)).toMatchObject({ rule: "stale" });
    });

    it("rejects an undated thread whose id sits at or below a thread known to be that old", () => {
      const out = applyRules(target({ external_id: "1mhbzs8", posted_at: null }), late);
      expect(out).toMatchObject({ status: "rejected", rule: "archived" });
      expect((out as { reason: string }).reason).toMatch(/numbers threads in order/);
      expect(applyRules(target({ external_id: "pnlmdv", posted_at: null }), late)).toMatchObject({ rule: "archived" });
      expect(applyRules(target({ external_id: "1rsqq3t", posted_at: null }), late)).toMatchObject({ rule: "archived" });
    });

    it("leaves an undated thread above the bound, or with no bound known, to the flag", () => {
      expect(applyRules(target({ external_id: "1wdgutr", posted_at: null }), late)).toEqual({ status: "pass", flags: ["date_unknown"] });
      expect(applyRules(target({ external_id: "1mhbzs8", posted_at: null }), ctx({ now: late.now }))).toEqual({
        status: "pass",
        flags: ["date_unknown"],
      });
      // A Reddit page that is not a thread never got this far; a thread id
      // that is not one (a hash) is not compared.
      expect(applyRules(target({ external_id: "c51d61284b4f47ba0c4803bfc8bb2585", posted_at: null }), late).status).toBe("pass");
    });

    it("dates a web-search find at the latest instant the engine allowed, so the age never overstates", () => {
      // "5 months ago" on 29 September was stored as 29 April: 153 days,
      // not archived. Had the midpoint been stored it would have been. It is
      // past the window to reply to a Reddit thread, which is a different
      // rule with its own reason.
      const out = applyRules(target({ posted_at: "2026-04-29T12:00:00Z" }), late);
      expect(out).toMatchObject({ rule: "stale" });
      expect((out as { reason: string }).reason).toMatch(/153 days old, past the 30-day window to reply to a Reddit thread/);
    });
  });
});

describe("expiryOf", () => {
  it("is the time-only part of the rules, so it can run again on a judged row", () => {
    const at = new Date("2026-09-29T12:00:00Z");
    // A thread qualified in April, archived by September: the inbox must not offer it.
    expect(expiryOf(target({ posted_at: "2026-03-01T00:00:00Z" }), ctx({ now: at }))).toMatchObject({ rule: "archived" });
    // Not a function of time: a rule that is not re-applied to an approval.
    expect(expiryOf(target({ title: "Which cast iron pan should I buy?", excerpt: "", found_for: null }), ctx({ now: at }))).toBeNull();
    expect(expiryOf(target({ url: "https://blog.gettrafficfa.st/post", surface: "web", kind: "article" }), ctx({ now: at }))).toBeNull();
    // Other kinds keep their own window and name.
    expect(
      expiryOf(target({ surface: "web", kind: "post", url: "https://www.linkedin.com/posts/x", posted_at: "2026-06-01T00:00:00Z" }), ctx({ now: at }))
    ).toMatchObject({ rule: "stale" });
    expect(expiryOf(target({ posted_at: null }), ctx({ now: at }))).toBeNull();
  });
});

describe("freshUntil", () => {
  it("is null for evergreen kinds and unknown dates", () => {
    expect(freshUntil("repository", "2026-01-01T00:00:00Z")).toBeNull();
    expect(freshUntil("thread", null)).toBeNull();
  });

  it("adds the kind's window", () => {
    expect(freshUntil("post", "2026-09-01T00:00:00Z")).toBe("2026-10-31T00:00:00.000Z");
  });
});

describe("contentTokens", () => {
  it("drops stopwords and short words and stems a trailing s", () => {
    const tokens = contentTokens("What are the best automations for email?");
    expect(tokens.has("what")).toBe(false);
    expect(tokens.has("automations")).toBe(true);
    expect(tokens.has("automation")).toBe(true);
    expect(tokens.has("email")).toBe(true);
  });
});

describe("workflow transitions", () => {
  it("lets a person approve, publish, dismiss and reopen only from the right states", () => {
    expect(transition("drafted", "approve")).toBe("approved");
    expect(transition("qualified", "mark_published")).toBe("published_manually");
    expect(transition("approved", "mark_published")).toBe("published_manually");
    expect(transition("published_manually", "approve")).toBeNull();
    expect(transition("discovered", "approve")).toBeNull();
    expect(transition("rejected", "reopen")).toBe("qualified");
    expect(transition("dismissed", "reopen")).toBe("qualified");
    expect(transition("qualified", "dismiss")).toBe("dismissed");
    expect(transition("published_manually", "dismiss")).toBeNull();
  });

  it("adds a link only to a posted row, and leaves it posted", () => {
    expect(transition("published_manually", "set_published_url")).toBe("published_manually");
    for (const status of ["discovered", "rejected", "qualified", "drafted", "needs_review", "approved", "dismissed"] as const) {
      expect(transition(status, "set_published_url")).toBeNull();
    }
  });

  it("snoozes without moving", () => {
    expect(transition("drafted", "snooze")).toBe("drafted");
    expect(transition("rejected", "snooze")).toBeNull();
  });

  it("has no machine path into published", () => {
    // Every move into published_manually is a manual action; the drafting
    // job can only produce drafted or needs_review.
    expect(statusAfterAudit("passed")).toBe("drafted");
    expect(statusAfterAudit("warning")).toBe("drafted");
    expect(statusAfterAudit("blocked")).toBe("needs_review");
    expect(OPEN_STATUSES).not.toContain("published_manually");
  });

  it("refuses to draft until the business says how it uses its product, in one sentence both surfaces share", () => {
    const empty = draftPrerequisite("GetTrafficFast", parseVoiceSettings({}));
    expect(empty).toContain("written as someone who uses GetTrafficFast");
    expect(empty).toContain("Settings → Voice → About you");
    expect(draftPrerequisite("GetTrafficFast", parseVoiceSettings({ aboutYou: "   " }))).toBe(empty);
    expect(draftPrerequisite("GetTrafficFast", parseVoiceSettings({ aboutYou: "I run my blog through it." }))).toBeNull();
  });

  it("opens the draft the gate came closest to passing", () => {
    const drafts = [
      { id: "short", auditStatus: "blocked" },
      { id: "article", auditStatus: "passed" },
      { id: "other", auditStatus: "warning" },
    ];
    expect(preferredDraft(drafts)?.id).toBe("article");
    expect(preferredDraft([{ id: "a", auditStatus: "blocked" }])?.id).toBe("a");
    expect(preferredDraft([])).toBeNull();
  });

  it("proposes the draft shapes a surface can take", () => {
    expect(variantsFor("github", "repository")).toEqual(["github_pr_proposal"]);
    expect(variantsFor("github", "issue")).toEqual(["github_issue"]);
    expect(variantsFor("reddit", "thread")).toEqual(["short_comment", "detailed_answer"]);
    // On X only the reply: the long form is an X Article, a separate use.
    expect(variantsFor("x", "post")).toEqual(["short_comment"]);
    expect(variantsFor("x", "article")).toEqual(["short_comment"]);
    expect(variantsFor("linkedin", "post")).toEqual(["short_comment", "article_draft"]);
    // A question site takes an answer; a blogging platform takes a comment or your own piece.
    expect(variantsFor("stackexchange", "thread")).toEqual(["short_comment", "detailed_answer"]);
    expect(variantsFor("quora", "thread")).toEqual(["short_comment", "detailed_answer"]);
    expect(variantsFor("devto", "article")).toEqual(["short_comment", "article_draft"]);
  });
});

describe("planManualAction", () => {
  const now = new Date("2026-11-08T10:00:00Z");
  const onX = { surface: "x", url: "https://x.com/asker/status/1850000000000000001" };
  const reply = "https://x.com/me/status/1850000000000000999";

  it("records I posted it in one tap: no link, the moment and the open draft", () => {
    const plan = planManualAction(
      { status: "drafted", ...onX },
      { action: "mark_published", placementId: "11111111-1111-4111-8111-111111111111" },
      now
    );
    expect(plan).toEqual({
      ok: true,
      status: "published_manually",
      patch: {
        status: "published_manually",
        updated_at: now.toISOString(),
        published_url: null,
        published_at: now.toISOString(),
        published_note: null,
        selected_placement_id: "11111111-1111-4111-8111-111111111111",
        snoozed_until: null,
      },
    });
    // An empty field is no link, not a refusal.
    expect(planManualAction({ status: "qualified", ...onX }, { action: "mark_published", publishedUrl: "  " }, now).ok).toBe(true);
  });

  it("still checks a link given with I posted it, and keeps a good one", () => {
    const thread = planManualAction({ status: "drafted", ...onX }, { action: "mark_published", publishedUrl: onX.url }, now);
    expect(thread).toMatchObject({ ok: false, httpStatus: 400 });
    const good = planManualAction({ status: "drafted", ...onX }, { action: "mark_published", publishedUrl: reply }, now);
    expect(good.ok && good.patch.published_url).toBe(reply);
  });

  it("refuses I posted it where it cannot be said, in the person's words", () => {
    expect(planManualAction({ status: "rejected", ...onX }, { action: "mark_published" }, now)).toEqual({
      ok: false,
      httpStatus: 409,
      error: "This post can't be marked as posted yet.",
    });
  });

  it("sets the link on a posted row only, checked as the card checks it, and touches nothing else", () => {
    const plan = planManualAction({ status: "published_manually", ...onX }, { action: "set_published_url", publishedUrl: ` ${reply} ` }, now);
    expect(plan).toEqual({
      ok: true,
      status: "published_manually",
      patch: { status: "published_manually", updated_at: now.toISOString(), published_url: reply },
    });

    for (const publishedUrl of [undefined, null, "", "not a link", onX.url, "https://www.reddit.com/r/x/comments/abc/t/def/"]) {
      const refused = planManualAction({ status: "published_manually", ...onX }, { action: "set_published_url", publishedUrl }, now);
      expect(refused).toMatchObject({ ok: false, httpStatus: 400 });
    }

    for (const status of ["qualified", "drafted", "needs_review", "approved", "dismissed", "rejected", "discovered"] as const) {
      expect(planManualAction({ status, ...onX }, { action: "set_published_url", publishedUrl: reply }, now)).toMatchObject({
        ok: false,
        httpStatus: 409,
        error: "A link can only be added to a reply you marked as posted.",
      });
    }
  });

  it("keeps the other moves as they were", () => {
    expect(planManualAction({ status: "drafted", ...onX }, { action: "dismiss", reason: "off topic" }, now)).toMatchObject({
      ok: true,
      status: "dismissed",
      patch: { dismissed_reason: "off topic" },
    });
    const snooze = planManualAction({ status: "drafted", ...onX }, { action: "snooze" }, now);
    expect(snooze.ok && snooze.patch.snoozed_until).toBe("2026-11-15T10:00:00.000Z");
    expect(planManualAction({ status: "dismissed", ...onX }, { action: "reopen" }, now)).toMatchObject({
      ok: true,
      status: "qualified",
      patch: { dismissed_reason: null, snoozed_until: null },
    });
  });
});
