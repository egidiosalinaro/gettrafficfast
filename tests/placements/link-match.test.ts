import { describe, expect, it } from "vitest";
import {
  CLOSE_MATCH,
  matchReplyLink,
  matchReplyLinks,
  postedReplyText,
  textSimilarity,
  type LinkCandidate,
} from "@/lib/placements/link-match";
import { MAX_LINKS_PER_PASTE, addSummary, linkFromClipboard, linksFromPaste, linksIn } from "@/lib/placements/paste";
import { replyLinkKey, replyLinkSurface } from "@/lib/placements/published-url";
import { ManualActionBody } from "@/lib/placements/actions";
import { MANUAL_ACTIONS, planManualAction, transition } from "@/lib/placements/workflow";

/**
 * The links of the replies posted earlier, pasted in one place (2026-11-10),
 * and several posts added at once. A link is assigned without asking only
 * when that is sure; otherwise the person picks. A guess is never stored.
 */

const DRAFT_A = "Same thing happened to me. What moved it wasn't my own blog: the engines kept citing two Reddit threads and one comparison post.";
const DRAFT_B = "Half true in my numbers. Ranking helps with Perplexity, which reads the live web, but the pages cited were mostly forum threads.";

const x = (id: string, replyText: string | null, status = "1900000000000000001"): LinkCandidate => ({
  id,
  surface: "x",
  url: `https://x.com/someone/status/${status}`,
  replyText,
});
const MINE = "https://x.com/me/status/1987700000000000001";

describe("matching a reply link on X", () => {
  it("assigns without asking when exactly one posted reply reads closely like the text read back", () => {
    const match = matchReplyLink({
      link: MINE,
      readText: `@someone ${DRAFT_A}`,
      candidates: [x("a", DRAFT_A), x("b", DRAFT_B, "1900000000000000002")],
    });
    expect(match).toEqual({ kind: "assign", link: MINE, targetId: "a" });
  });

  it("still assigns when the reply was edited a little on X before posting", () => {
    const edited = "same thing happened to me. what moved it wasn't my blog, the engines kept citing two reddit threads and a comparison post";
    expect(textSimilarity(edited, DRAFT_A)).toBeGreaterThanOrEqual(CLOSE_MATCH);
    expect(matchReplyLink({ link: MINE, readText: edited, candidates: [x("a", DRAFT_A), x("b", DRAFT_B, "1900000000000000002")] })).toMatchObject({
      kind: "assign",
      targetId: "a",
    });
  });

  it("asks, and never guesses, when X did not hand the text over, even with a single candidate", () => {
    const match = matchReplyLink({ link: MINE, readText: null, candidates: [x("a", DRAFT_A)] });
    expect(match).toMatchObject({ kind: "pick", candidateIds: ["a"] });
  });

  it("asks when nothing matches closely: a reply rewritten on X is not assigned to the nearest draft", () => {
    const match = matchReplyLink({
      link: MINE,
      readText: "Completely different words that the person typed on X instead of the draft we wrote.",
      candidates: [x("a", DRAFT_A), x("b", DRAFT_B, "1900000000000000002")],
    });
    expect(match.kind).toBe("pick");
    expect(match.kind === "pick" && match.candidateIds.sort()).toEqual(["a", "b"]);
  });

  it("asks when two posted replies read like it: the same draft posted under two posts", () => {
    const match = matchReplyLink({ link: MINE, readText: DRAFT_A, candidates: [x("a", DRAFT_A), x("b", DRAFT_A, "1900000000000000002")] });
    expect(match.kind).toBe("pick");
  });

  it("does not match on a text too short to tell replies apart, or a reply with no draft on record", () => {
    expect(textSimilarity("so true", "so true")).toBe(0);
    expect(matchReplyLink({ link: MINE, readText: DRAFT_A, candidates: [x("a", null)] }).kind).toBe("pick");
  });

  it("never offers the thread's own link to its reply, and refuses a link that is not a status", () => {
    const thread = matchReplyLink({ link: "https://x.com/someone/status/1900000000000000001", readText: DRAFT_A, candidates: [x("a", DRAFT_A)] });
    expect(thread.kind).toBe("refused");
    const profile = matchReplyLink({ link: "https://x.com/me", readText: null, candidates: [x("a", DRAFT_A)] });
    expect(profile).toMatchObject({ kind: "refused" });
    expect(profile.kind === "refused" && profile.error).toContain("/status/");
  });
});

describe("matching a reply link anywhere else", () => {
  const linkedin = (id: string, activity: string): LinkCandidate => ({
    id,
    surface: "linkedin",
    url: `https://www.linkedin.com/posts/anna_x-activity-${activity}-AbCd`,
    replyText: "We had the same split.",
  });
  const comment = "https://www.linkedin.com/feed/update/urn:li:activity:7391234567890123456?commentUrn=urn%3Ali%3Acomment%3A1";

  it("assigns only when exactly one posted reply on that platform has no link", () => {
    expect(matchReplyLink({ link: comment, readText: null, candidates: [linkedin("li", "7391234567890123456"), x("a", DRAFT_A)] })).toEqual({
      kind: "assign",
      link: comment,
      targetId: "li",
    });
    // The short link LinkedIn's phone app copies is LinkedIn's too.
    expect(matchReplyLink({ link: "https://lnkd.in/abc123", readText: null, candidates: [linkedin("li", "1")] }).kind).toBe("assign");
  });

  it("asks when two are waiting: nothing here can tell which one the link is", () => {
    const match = matchReplyLink({ link: comment, readText: null, candidates: [linkedin("li-1", "7391234567890123456"), linkedin("li-2", "7390000000000000000")] });
    expect(match).toMatchObject({ kind: "pick", candidateIds: ["li-1", "li-2"] });
  });

  it("refuses a link with no posted reply waiting on its platform, one already saved, and something that is not a link", () => {
    expect(matchReplyLink({ link: comment, readText: null, candidates: [x("a", DRAFT_A)] })).toMatchObject({
      kind: "refused",
      error: "No posted reply on LinkedIn is waiting for its link.",
    });
    expect(matchReplyLink({ link: MINE, readText: DRAFT_A, candidates: [x("a", DRAFT_A)], taken: new Set([replyLinkKey(MINE)!]) })).toMatchObject({
      kind: "refused",
      error: "This link is already saved on a reply.",
    });
    expect(matchReplyLink({ link: "not a link", readText: null, candidates: [x("a", DRAFT_A)] }).kind).toBe("refused");
  });

  it("sends a link on a site with no rule of its own only to replies on such sites", () => {
    const hn: LinkCandidate = { id: "hn", surface: "hackernews", url: "https://news.ycombinator.com/item?id=1", replyText: "x" };
    expect(matchReplyLink({ link: "https://news.ycombinator.com/item?id=2", readText: null, candidates: [hn, x("a", DRAFT_A)] })).toMatchObject({
      kind: "assign",
      targetId: "hn",
    });
    expect(replyLinkSurface("https://news.ycombinator.com/item?id=2")).toBeNull();
    expect(replyLinkSurface("https://qr.ae/abc")).toBe("quora");
    expect(replyLinkSurface("https://mobile.twitter.com/a/status/1")).toBe("x");
  });
});

describe("several links at once", () => {
  it("takes an assigned reply out of the running for the next link, and refuses the same link twice", () => {
    const second = "https://x.com/me/status/1987700000000000002";
    const matches = matchReplyLinks({
      links: [MINE, second, MINE],
      readTexts: { [MINE]: DRAFT_A, [second]: DRAFT_A },
      candidates: [x("a", DRAFT_A), x("b", DRAFT_B, "1900000000000000002")],
    });
    expect(matches[0]).toMatchObject({ kind: "assign", targetId: "a" });
    // "a" is taken: the second link reads like nothing that is left, so it is a question.
    expect(matches[1]).toMatchObject({ kind: "pick", candidateIds: ["b"] });
    expect(matches[2]).toMatchObject({ kind: "refused", error: "This link is already saved on a reply." });
  });

  it("reads the words that went out off the record: the text read from X, else the draft marked as posted", () => {
    const drafts = [
      { id: "d1", body: "first draft" },
      { id: "d2", body: "the one that was posted" },
    ];
    expect(postedReplyText({ publishedText: " read back ", selectedPlacementId: "d2", drafts })).toBe("read back");
    expect(postedReplyText({ publishedText: null, selectedPlacementId: "d2", drafts })).toBe("the one that was posted");
    expect(postedReplyText({ selectedPlacementId: null, drafts })).toBe("first draft");
    expect(postedReplyText({ selectedPlacementId: null, drafts: [] })).toBeNull();
  });
});

describe("links out of a paste", () => {
  it("reads several links, one per line or separated by spaces, each once", () => {
    const text = "https://x.com/a/status/1\nhttps://x.com/b/status/2   x.com/c/status/3\nhttps://twitter.com/a/status/1?s=20";
    expect(linksIn(text)).toEqual(["https://x.com/a/status/1", "https://x.com/b/status/2", "https://x.com/c/status/3"]);
    expect(linksIn("look at this https://x.com/a/status/12?s=20, wow")).toEqual(["https://x.com/a/status/12?s=20"]);
    expect(linksIn("just some words")).toEqual([]);
  });

  it("still gives the single link the clipboard holds", () => {
    expect(linkFromClipboard("https://x.com/inkwell_ivy/status/1987654321098765432")).toBe("https://x.com/inkwell_ivy/status/1987654321098765432");
    expect(linkFromClipboard("x.com/a/status/12")).toBe("https://x.com/a/status/12");
    expect(linkFromClipboard("twitter.com/a/status/12")).toBe("https://twitter.com/a/status/12");
    expect(linkFromClipboard("")).toBeNull();
  });

  it("caps one paste at ten links and says how many were left out", () => {
    expect(MAX_LINKS_PER_PASTE).toBe(10);
    const many = Array.from({ length: 13 }, (_, i) => `https://x.com/a/status/${i + 1}`).join("\n");
    const { links, over } = linksFromPaste(many);
    expect(links).toHaveLength(10);
    expect(links[0]).toBe("https://x.com/a/status/1");
    expect(over).toBe(3);
    expect(linksFromPaste("https://x.com/a/status/1")).toEqual({ links: ["https://x.com/a/status/1"], over: 0 });
  });

  it("says how many were added and lists each one that was not, with its reason", () => {
    expect(addSummary([{ link: "a", error: null }]).text).toBe("1 post added.");
    expect(addSummary([{ link: "a", error: null }, { link: "b", error: null }]).text).toBe("2 posts added.");
    const mixed = addSummary(
      [
        { link: "a", error: null },
        { link: "b", error: "Paste the link of a post on X." },
        { link: "c", error: "You have reached today's limit of 60 drafts." },
      ],
      3
    );
    expect(mixed.text).toBe("1 of 3 posts added. 2 not added.");
    expect(mixed.failed.map((f) => f.link)).toEqual(["b", "c"]);
    expect(mixed.capped).toBe("3 more links were left out: 10 at a time.");
    expect(addSummary([{ link: "a", error: null }], 1).capped).toBe("1 more link was left out: 10 at a time.");
    expect(addSummary([{ link: "a", error: null }]).capped).toBeNull();
  });
});

describe("the Undo of I posted it", () => {
  const NOW = new Date("2026-11-10T09:30:00Z");
  const thread = { surface: "x", url: "https://x.com/someone/status/1900000000000000001" };

  it("is a move the action route accepts, from a posted row back to an open one", () => {
    expect(MANUAL_ACTIONS).toContain("unmark_published");
    expect(ManualActionBody.safeParse({ action: "unmark_published" }).success).toBe(true);
    expect(transition("published_manually", "unmark_published")).toBe("drafted");
    expect(transition("drafted", "unmark_published")).toBeNull();
  });

  it("clears the moment and leaves the drafts and the draft that was chosen", () => {
    const plan = planManualAction({ status: "published_manually", ...thread }, { action: "unmark_published" }, NOW);
    expect(plan).toMatchObject({ ok: true, status: "drafted", patch: { status: "drafted", published_at: null, published_note: null } });
    expect(plan.ok && "selected_placement_id" in plan.patch).toBe(false);
  });

  it("is refused once the reply has its link or was marked as removed: that record is more than a tap", () => {
    expect(planManualAction({ status: "published_manually", ...thread, publishedUrl: "https://x.com/me/status/2" }, { action: "unmark_published" }, NOW)).toMatchObject({
      ok: false,
      httpStatus: 409,
    });
    expect(planManualAction({ status: "published_manually", ...thread, removedAt: "2026-11-10T09:00:00Z" }, { action: "unmark_published" }, NOW)).toMatchObject({
      ok: false,
      httpStatus: 409,
    });
    expect(planManualAction({ status: "drafted", ...thread }, { action: "unmark_published" }, NOW)).toMatchObject({
      ok: false,
      error: "This reply is not marked as posted.",
    });
  });
});
