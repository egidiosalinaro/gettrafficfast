import { describe, expect, it } from "vitest";
import {
  LINK_SEARCH_ATTEMPTS,
  LINK_SEARCH_CALL_WORST_USD,
  LINK_SEARCH_ROWS_PER_RUN,
  dueAttempt,
  linkSearchMonthUsd,
  linkFinding,
  linkSourceOf,
  loadLinkSearches,
  lookingLine,
  matchOwnReply,
  replyLinkQuery,
  searchWindow,
  stopsByLabel,
  withLinkSearch,
  type LinkSearchRecord,
  type ReplyCandidate,
} from "@/lib/placements/reply-link";
import { FakeSupabase } from "../support/fake-supabase";

/**
 * The link of the person's own reply on X, found by GTF: the pure half.
 * What is pinned: the matcher saves a link only when it is surely the
 * person's own reply to that post (their account, that thread, around the
 * tap; one direct reply, or the one whose words match), and nothing in any
 * doubtful case; the schedule gives a reply at most four attempts and never
 * searches past X's 7 days; and the state a posted reply shows is honest
 * (looking with when it stops, stopped with why, off when GTF does not look).
 */

const THREAD = "1855000000000000000";
const MARKED = "2026-11-13T10:00:00.000Z";
const DRAFT = "Put the direct answer in the first sentence, then the detail. That is what ChatGPT quotes.";

function reply(id: string, over: Partial<ReplyCandidate> = {}): ReplyCandidate {
  return {
    id,
    text: `@janedoe ${DRAFT}`,
    handle: "owner",
    createdAt: "2026-11-13T09:58:00.000Z",
    conversationId: THREAD,
    repliedToId: THREAD,
    ...over,
  };
}

const match = (posts: ReplyCandidate[], over: Partial<Parameters<typeof matchOwnReply>[0]> = {}) =>
  matchOwnReply({ threadId: THREAD, handle: "owner", markedAt: MARKED, replyText: DRAFT, posts, ...over });

describe("the query", () => {
  it("asks for the account's posts in the thread, or answering the post", () => {
    expect(replyLinkQuery(THREAD, "owner")).toBe(`(conversation_id:${THREAD} OR in_reply_to_tweet_id:${THREAD}) from:owner`);
  });

  it("is never built from a handle or an id X would not take", () => {
    expect(replyLinkQuery(THREAD, "owner OR from:elon")).toBeNull();
    expect(replyLinkQuery(THREAD, "a_handle_far_too_long")).toBeNull();
    expect(replyLinkQuery("12 OR 13", "owner")).toBeNull();
  });

  it("costs $0.05 at worst: X's floor of 10 posts", () => {
    expect(LINK_SEARCH_CALL_WORST_USD).toBe(0.05);
  });

  it("costs what the docs say a month: one billed search per reply, $0.005 typical, $0.05 at worst", () => {
    expect(linkSearchMonthUsd({ repliesPerDay: 5 })).toEqual({ typicalUsd: 0.75, worstUsd: 7.5 });
    expect(linkSearchMonthUsd({ repliesPerDay: 10 })).toEqual({ typicalUsd: 1.5, worstUsd: 15 });
    // A run: at most 10 searches, $0.50 at worst.
    expect(LINK_SEARCH_ROWS_PER_RUN * LINK_SEARCH_CALL_WORST_USD).toBe(0.5);
  });
});

describe("the matcher", () => {
  it("takes the one direct reply of the account to the post, edited on X or not", () => {
    const edited = reply("1855000000000000101", { text: "@janedoe totally different words after editing on X" });
    const found = match([edited]);
    expect(found).toMatchObject({ kind: "found", why: "the_reply", url: "https://x.com/owner/status/1855000000000000101" });
  });

  it("never takes a post by another account, even one the search returned", () => {
    expect(match([reply("1855000000000000101", { handle: "janedoe" })])).toEqual({ kind: "none" });
    expect(match([reply("1855000000000000101", { handle: null })])).toEqual({ kind: "none" });
  });

  it("matches the account whatever its case", () => {
    expect(match([reply("1855000000000000101", { handle: "Owner" })])).toMatchObject({
      kind: "found",
      url: "https://x.com/Owner/status/1855000000000000101",
    });
  });

  it("never takes a post outside the thread, or one X did not place in it", () => {
    expect(match([reply("1855000000000000101", { conversationId: "1", repliedToId: "2" })])).toEqual({ kind: "none" });
    expect(match([reply("1855000000000000101", { conversationId: undefined, repliedToId: undefined })])).toEqual({ kind: "none" });
    // The thread post itself is never the reply.
    expect(match([reply(THREAD)])).toEqual({ kind: "none" });
  });

  it("takes a reply from an hour before the tap to six hours after, nothing else", () => {
    expect(match([reply("1855000000000000101", { createdAt: "2026-11-13T09:01:00.000Z" })]).kind).toBe("found");
    expect(match([reply("1855000000000000101", { createdAt: "2026-11-13T08:59:00.000Z" })])).toEqual({ kind: "none" });
    expect(match([reply("1855000000000000101", { createdAt: "2026-11-13T15:59:00.000Z" })]).kind).toBe("found");
    expect(match([reply("1855000000000000101", { createdAt: "2026-11-13T16:01:00.000Z" })])).toEqual({ kind: "none" });
    expect(match([reply("1855000000000000101", { createdAt: null })])).toEqual({ kind: "none" });
  });

  it("finds the reply to a post that is itself a reply in someone else's thread", () => {
    const found = match([reply("1855000000000000101", { conversationId: "1854000000000000000", repliedToId: THREAD })]);
    expect(found.kind).toBe("found");
  });

  it("with several direct replies, takes the one whose words match the draft, only when one does", () => {
    const right = reply("1855000000000000101");
    const other = reply("1855000000000000102", { text: "@janedoe also, thanks for asking this, it is a great thread to follow" });
    expect(match([other, right])).toMatchObject({ kind: "found", why: "closest_text", post: { id: right.id } });

    // Posted twice (a double tap): both read the same, so nothing is saved.
    const twice = reply("1855000000000000103");
    expect(match([right, twice])).toEqual({ kind: "ambiguous", candidateIds: [right.id, twice.id] });
    // No words on record to choose with: nothing is saved.
    expect(match([other, right], { replyText: null })).toMatchObject({ kind: "ambiguous" });
  });

  it("prefers the direct reply to the post over the account's replies further down the thread", () => {
    const direct = reply("1855000000000000101", { text: "@janedoe edited beyond recognition" });
    const deeper = reply("1855000000000000102", { repliedToId: "1855000000000000050" });
    expect(match([deeper, direct])).toMatchObject({ kind: "found", post: { id: direct.id } });
  });

  it("takes a reply further down the thread only when its words match the draft", () => {
    const deeper = reply("1855000000000000102", { repliedToId: "1855000000000000050" });
    expect(match([deeper])).toMatchObject({ kind: "found", why: "closest_text" });
    const chat = reply("1855000000000000103", { repliedToId: "1855000000000000050", text: "@someone haha yes, exactly what I meant there" });
    expect(match([chat])).toEqual({ kind: "none" });
  });

  it("never takes a reply already saved as the link of another reply", () => {
    expect(match([reply("1855000000000000101")], { taken: new Set(["1855000000000000101"]) })).toEqual({ kind: "none" });
  });
});

describe("the schedule", () => {
  const now = (iso: string) => new Date(iso);

  it("looks 2 min, 15 min, 2 h and 12 h after the tap, then never again", () => {
    expect(dueAttempt(MARKED, 0, now("2026-11-13T10:01:00Z"))).toBeNull();
    expect(dueAttempt(MARKED, 0, now("2026-11-13T10:02:00Z"))).toBe(0);
    expect(dueAttempt(MARKED, 1, now("2026-11-13T10:10:00Z"))).toBeNull();
    expect(dueAttempt(MARKED, 1, now("2026-11-13T10:15:00Z"))).toBe(1);
    expect(dueAttempt(MARKED, 2, now("2026-11-13T12:00:00Z"))).toBe(2);
    expect(dueAttempt(MARKED, 3, now("2026-11-13T22:00:00Z"))).toBe(3);
    expect(dueAttempt(MARKED, LINK_SEARCH_ATTEMPTS, now("2026-11-15T22:00:00Z"))).toBeNull();
  });

  it("does not make up the slots nobody used: a reply reached late is searched once, at the latest slot", () => {
    expect(dueAttempt(MARKED, 0, now("2026-11-14T09:00:00Z"))).toBe(3);
    expect(dueAttempt(MARKED, 0, now("2026-11-13T11:00:00Z"))).toBe(1);
  });

  it("searches X's last 7 days only, with the end of the window left out while it is ahead", () => {
    const fresh = searchWindow(MARKED, now("2026-11-13T10:05:00Z"));
    expect(fresh).toEqual({ start: new Date("2026-11-13T09:00:00Z"), end: null });
    const later = searchWindow(MARKED, now("2026-11-14T10:00:00Z"));
    expect(later).toEqual({ start: new Date("2026-11-13T09:00:00Z"), end: new Date("2026-11-13T16:00:00Z") });
    expect(searchWindow(MARKED, now("2026-11-20T09:55:00Z"))).toBeNull();
    expect(searchWindow(null, now("2026-11-13T10:05:00Z"))).toBeNull();
    // A moment in the future (a wrong publishedAt) is never searched.
    expect(searchWindow("2026-11-14T12:00:00Z", now("2026-11-13T10:05:00Z"))).toBeNull();
  });
});

describe("what a posted reply shows", () => {
  const record = (over: Partial<LinkSearchRecord> = {}): LinkSearchRecord => ({
    attempts: 0,
    lastAttemptAt: null,
    outcome: null,
    postsSeen: 0,
    foundUrl: null,
    foundAt: null,
    ...over,
  });
  const posted = (over: Record<string, unknown> = {}) => ({
    surface: "x",
    status: "published_manually",
    url: `https://x.com/janedoe/status/${THREAD}`,
    publishedUrl: null,
    publishedAt: MARKED,
    linkSearch: null as LinkSearchRecord | null | undefined,
    ...over,
  });
  const at = Date.parse("2026-11-13T10:05:00Z");

  it("is looking while attempts remain, and says when it stops", () => {
    expect(linkFinding(posted(), { finderOn: true, now: at })).toEqual({ state: "looking", stopsBy: "2026-11-13T22:05:00.000Z" });
    expect(linkFinding(posted({ linkSearch: record({ attempts: 2, outcome: "not_found" }) }), { finderOn: true, now: at })).toMatchObject({
      state: "looking",
    });
  });

  it("is stopped once the attempts are used or an answer settled it, with why", () => {
    expect(linkFinding(posted({ linkSearch: record({ attempts: 4, outcome: "ambiguous" }) }), { finderOn: true, now: at })).toEqual({
      state: "stopped",
      outcome: "ambiguous",
    });
    // Stopped stays true when the feature is off now.
    expect(linkFinding(posted({ linkSearch: record({ attempts: 4, outcome: "not_found" }) }), { finderOn: false, now: at })).toMatchObject({
      state: "stopped",
    });
  });

  it("is off when GTF does not look: the switch, another platform, removed, too old, or the searches unread", () => {
    expect(linkFinding(posted(), { finderOn: false, now: at })).toEqual({ state: "off" });
    expect(linkFinding(posted({ surface: "reddit", url: "https://www.reddit.com/r/seo/comments/abc/x/" }), { finderOn: true, now: at })).toEqual({ state: "off" });
    expect(linkFinding(posted({ removedAt: "2026-11-13T11:00:00Z" }), { finderOn: true, now: at })).toEqual({ state: "off" });
    expect(linkFinding(posted({ publishedAt: "2026-11-01T10:00:00Z" }), { finderOn: true, now: at })).toEqual({ state: "off" });
    expect(linkFinding(posted({ linkSearch: undefined }), { finderOn: true, now: at })).toEqual({ state: "off" });
  });

  it("says nothing about a reply that has its link, or a post not posted", () => {
    expect(linkFinding(posted({ publishedUrl: "https://x.com/owner/status/1" }), { finderOn: true, now: at })).toBeNull();
    expect(linkFinding(posted({ status: "drafted" }), { finderOn: true, now: at })).toBeNull();
  });

  it("names the source of a link: found on X only while it is the link GTF found", () => {
    const found = record({ foundUrl: "https://x.com/owner/status/1855000000000000101" });
    expect(linkSourceOf("https://x.com/owner/status/1855000000000000101", found)).toBe("found_on_x");
    expect(linkSourceOf("https://x.com/owner/status/1855000000000000999", found)).toBe("person");
    expect(linkSourceOf("https://x.com/owner/status/1", null)).toBe("person");
    expect(linkSourceOf(null, found)).toBeNull();
  });

  it("says when it stops in the reader's zone, and that pasting still works", () => {
    const now = Date.parse("2026-11-13T10:05:00Z");
    expect(stopsByLabel("2026-11-13T22:05:00Z", now, "UTC")).toBe("10:05 PM");
    expect(stopsByLabel("2026-11-14T02:05:00Z", now, "UTC")).toBe("tomorrow 2:05 AM");
    expect(stopsByLabel("2026-11-16T02:05:00Z", now, "UTC")).toBe("Nov 16, 2:05 AM");
    expect(lookingLine("2026-11-13T22:05:00Z", now, "UTC")).toBe(
      "GTF is looking for this reply on X and will add its link. It stops by 10:05 PM; you can paste it any time."
    );
  });
});

describe("reading the searches", () => {
  it("maps the rows by target, and a target never searched has none", async () => {
    const db = new FakeSupabase({
      placement_link_searches: [{ target_id: "t1", attempts: 2, outcome: "not_found", posts_seen: 0, last_attempt_at: "2026-11-13T10:15:00Z" }],
    });
    const searches = await loadLinkSearches(db as never, ["t1", "t2"]);
    expect(searches?.get("t1")).toMatchObject({ attempts: 2, outcome: "not_found", foundUrl: null });
    expect(withLinkSearch({ id: "t2" }, searches)).toEqual({ id: "t2", link_search: null });
  });

  it("is unknown (null) when the table cannot be read, and the row then carries no key", async () => {
    const failing = { from: () => ({ select: () => ({ in: async () => ({ data: null, error: { message: "relation does not exist" } }) }) }) };
    const searches = await loadLinkSearches(failing as never, ["t1"]);
    expect(searches).toBeNull();
    expect(withLinkSearch({ id: "t1" }, searches)).toEqual({ id: "t1" });
  });
});
