import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ afterTasks: [] as unknown[] }));

vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock("@/lib/notifications/email", () => ({ operatorEmailAddress: () => null, sendNotificationEmail: vi.fn() }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: unknown) => {
    mocks.afterTasks.push(task);
  },
}));

import type { XApiClient, XApiPost, XCallResult } from "@/lib/providers/x/api";
import { LINK_SEARCH_ROWS_PER_RUN } from "@/lib/placements/reply-link";
import { LINK_SEARCH_NEW_REPLIES_PER_SITE_PER_DAY, findReplyLinkNow, findReplyLinks, replyLinkFinderOn } from "@/lib/placements/reply-link-search";
import { LedgerFake, xPost } from "./x-fake";

/**
 * GTF finds the link of the person's own reply on X: the 5-minute sweep and
 * `find_reply_link`. What is pinned: a found reply is saved the way a pasted
 * link is (set_published_url: the check, the text read back, the numbers
 * pick it up) and recorded as found; X is asked on schedule and never more
 * than four times on its own; a doubtful answer saves nothing and stops; a
 * link the person saved is never replaced; every site whose owner pays and
 * whose account is known (saved, else named by a saved link) is searched,
 * with no per-site switch since 2026-11-24, under a daily bound of new
 * replies a site; every call is metered, and
 * a refusal before X was asked gives the attempt back.
 */

const SITE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_SITE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "22222222-2222-4222-8222-222222222222";
const THREAD = "1855000000000000000";
const MARKED = "2026-11-13T10:00:00.000Z";
const DRAFT = "Put the direct answer in the first sentence, then the detail. That is what ChatGPT quotes.";
const MONTH = "2026-11-01";

const at = (iso: string) => new Date(iso);

function posted(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    user_id: USER,
    business_id: SITE,
    surface: "x",
    kind: "post",
    url: `https://x.com/janedoe/status/${THREAD}`,
    title: "How do you get cited by ChatGPT?",
    status: "published_manually",
    published_url: null,
    published_at: MARKED,
    selected_placement_id: `d-${id}`,
    created_at: "2026-11-13T09:00:00.000Z",
    ...over,
  };
}

/** A reply linked before: it is what tells GTF the site's account. */
const linkedBefore = posted("known", {
  url: "https://x.com/someone/status/1850000000000000000",
  published_url: "https://x.com/owner/status/1850000000000000001",
  published_at: "2026-11-12T09:00:00.000Z",
});

function site(id = SITE, userId = USER, voice: Record<string, unknown> = {}) {
  return { id, user_id: userId, name: "Acme", voice_settings: { aboutYou: "I run Acme.", ...voice } };
}

function seed(targets: Record<string, unknown>[], over: Record<string, Record<string, unknown>[]> = {}) {
  return new LedgerFake({
    businesses: [site()],
    subscriptions: [{ user_id: USER, status: "active", current_period_end: null }],
    placement_targets: [linkedBefore, ...targets],
    placements: targets.map((t) => ({ id: `d-${t.id}`, target_id: t.id, body: DRAFT, created_at: "2026-11-13T09:30:00.000Z" })),
    placement_link_searches: [],
    ...over,
  });
}

function theReply(id = "1855000000000000101", over: Partial<XApiPost> = {}): XApiPost {
  return xPost(id, {
    text: `@janedoe ${DRAFT}`,
    handle: "owner",
    createdAt: "2026-11-13T09:59:00.000Z",
    conversationId: THREAD,
    repliedToId: THREAD,
    ...over,
  });
}

const billed = (posts: XApiPost[]): XCallResult => ({
  posts,
  missingIds: [],
  billedPosts: posts.length,
  costUsd: Math.round(posts.length * 0.005 * 10_000) / 10_000,
});

/** A stand-in for the X client: each search answers the next batch (nothing once they run out). */
function fakeX(batches: XApiPost[][] = [], before?: () => void) {
  const queue = [...batches];
  const searchReplies = vi.fn<(params: { query: string; startTime: Date; endTime?: Date | null }) => Promise<XCallResult>>(async () => {
    before?.();
    return billed(queue.shift() ?? []);
  });
  return { client: { searchReplies } as unknown as XApiClient, searchReplies };
}

const search = (db: LedgerFake, id: string) => db.tables.placement_link_searches.find((r) => r.target_id === id);
const target = (db: LedgerFake, id: string) => db.tables.placement_targets.find((r) => r.id === id)!;

let quiet: Array<ReturnType<typeof vi.spyOn>>;
beforeEach(() => {
  mocks.afterTasks = [];
  quiet = (["log", "warn", "error"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
});
afterEach(() => quiet.forEach((spy) => spy.mockRestore()));

describe("the sweep", () => {
  it("finds the reply two minutes after I posted it and saves it the way a pasted link is saved", async () => {
    const db = seed([posted("r1")]);
    const { client, searchReplies } = fakeX([[theReply()]]);
    const outcome = await findReplyLinks({ admin: db as never, client, now: at("2026-11-13T10:03:00Z") });

    expect(outcome).toMatchObject({ due: 1, searched: 1, found: 1, costUsd: 0.005, stopped: null });
    const params = searchReplies.mock.calls[0][0];
    expect(params.query).toBe(`(conversation_id:${THREAD} OR in_reply_to_tweet_id:${THREAD}) from:owner`);
    expect(params.startTime.toISOString()).toBe("2026-11-13T09:00:00.000Z");
    expect(params.endTime).toBeNull();

    expect(target(db, "r1")).toMatchObject({ status: "published_manually", published_url: "https://x.com/owner/status/1855000000000000101" });
    expect(search(db, "r1")).toMatchObject({
      attempts: 1,
      outcome: "found",
      posts_seen: 1,
      found_url: "https://x.com/owner/status/1855000000000000101",
      found_at: "2026-11-13T10:03:00.000Z",
    });
    // The reply's words are read back from X after, as for a pasted link.
    expect(mocks.afterTasks).toHaveLength(1);
    // Metered: reserved at worst, settled to what X returned.
    expect(db.spend(MONTH)).toMatchObject({ cost_usd: 0.005, calls: 1, posts: 1 });
  });

  it("looks again on schedule while X has nothing, four times in all, then never again", async () => {
    const db = seed([posted("r1")]);
    const { client, searchReplies } = fakeX();
    const times = ["10:01", "10:03", "10:10", "10:16", "11:00", "12:01", "20:00", "22:01", "23:30"];
    for (const time of times) await findReplyLinks({ admin: db as never, client, now: at(`2026-11-13T${time}:00Z`) });
    await findReplyLinks({ admin: db as never, client, now: at("2026-11-15T10:00:00Z") });

    expect(searchReplies).toHaveBeenCalledTimes(4);
    expect(search(db, "r1")).toMatchObject({ attempts: 4, outcome: "not_found", posts_seen: 0 });
    expect(target(db, "r1").published_url).toBeNull();
    // Nothing returned, nothing billed.
    expect(db.spend(MONTH)).toMatchObject({ cost_usd: 0, calls: 4, posts: 0 });
  });

  it("saves nothing when two replies could be it, and stops looking", async () => {
    const db = seed([posted("r1")]);
    const { client, searchReplies } = fakeX([[theReply("1855000000000000101"), theReply("1855000000000000102")]]);
    const outcome = await findReplyLinks({ admin: db as never, client, now: at("2026-11-13T10:03:00Z") });
    expect(outcome).toMatchObject({ searched: 1, found: 0, stoppedWithoutLink: 1 });
    expect(target(db, "r1").published_url).toBeNull();
    expect(search(db, "r1")).toMatchObject({ attempts: 4, outcome: "ambiguous", posts_seen: 2 });

    await findReplyLinks({ admin: db as never, client, now: at("2026-11-13T23:00:00Z") });
    expect(searchReplies).toHaveBeenCalledTimes(1);
  });

  it("stops after a billed answer that is not this reply, rather than pay for the same posts again", async () => {
    const db = seed([posted("r1")]);
    const chat = theReply("1855000000000000103", { repliedToId: "1855000000000000050", text: "@someone haha yes, that is what I meant" });
    const { client } = fakeX([[chat]]);
    await findReplyLinks({ admin: db as never, client, now: at("2026-11-13T10:03:00Z") });
    expect(search(db, "r1")).toMatchObject({ attempts: 4, outcome: "other_replies", posts_seen: 1 });
    expect(target(db, "r1").published_url).toBeNull();
  });

  it("never replaces a link the person saved while X was being asked", async () => {
    const db = seed([posted("r1")]);
    const mine = "https://x.com/owner/status/1855000000000000999";
    const { client } = fakeX([[theReply()]], () => {
      target(db, "r1").published_url = mine;
    });
    const outcome = await findReplyLinks({ admin: db as never, client, now: at("2026-11-13T10:03:00Z") });
    expect(outcome.stoppedWithoutLink).toBe(1);
    expect(target(db, "r1").published_url).toBe(mine);
    expect(search(db, "r1")).toMatchObject({ outcome: "not_saved" });
    expect(search(db, "r1")?.found_url ?? null).toBeNull();
  });

  it("never saves a reply that is already another reply's link", async () => {
    const db = seed([posted("r1"), posted("r2", { url: "https://x.com/bob/status/1855000000000000300", published_url: "https://x.com/owner/status/1855000000000000101", published_at: "2026-11-13T09:00:00Z" })]);
    const { client } = fakeX([[theReply()]]);
    await findReplyLinks({ admin: db as never, client, now: at("2026-11-13T10:03:00Z") });
    expect(target(db, "r1").published_url).toBeNull();
    expect(search(db, "r1")).toMatchObject({ outcome: "other_replies" });
  });

  it("searches every site whose owner pays and whose X account is known, whatever an old switch says", async () => {
    const unknownAccount = { ...posted("r3", { business_id: OTHER_SITE, user_id: OTHER_USER }) };
    const db = seed([posted("r1"), unknownAccount], {
      // The removed per-site switch, stored false: ignored.
      businesses: [site(SITE, USER, { findPostsOnX: false }), site(OTHER_SITE, OTHER_USER)],
      subscriptions: [
        { user_id: USER, status: "active", current_period_end: null },
        { user_id: OTHER_USER, status: "active", current_period_end: null },
      ],
    });
    const { client, searchReplies } = fakeX([[theReply()]]);
    const outcome = await findReplyLinks({ admin: db as never, client, now: at("2026-11-13T10:03:00Z") });
    // r1: searched and found; r3: no saved handle, no linked reply, so no known account.
    expect(outcome).toMatchObject({ due: 2, notEligible: 1, searched: 1, found: 1 });
    expect(searchReplies).toHaveBeenCalledTimes(1);
    expect(search(db, "r3")).toBeUndefined();

    const unpaid = seed([posted("r1")], { subscriptions: [] });
    const { client: unpaidClient, searchReplies: unpaidSearch } = fakeX([[theReply()]]);
    await findReplyLinks({ admin: unpaid as never, client: unpaidClient, now: at("2026-11-13T10:03:00Z") });
    expect(unpaidSearch).not.toHaveBeenCalled();
  });

  it("on a new site, searches from the handle the person saved, with no link saved before", async () => {
    const db = seed([posted("r1")], { businesses: [site(SITE, USER, { xHandle: "owner" })] });
    db.tables.placement_targets = db.tables.placement_targets.filter((r) => r.id !== "known");
    const { client, searchReplies } = fakeX([[theReply()]]);
    const outcome = await findReplyLinks({ admin: db as never, client, now: at("2026-11-13T10:03:00Z") });
    expect(outcome).toMatchObject({ searched: 1, found: 1 });
    expect(searchReplies.mock.calls[0][0].query).toContain("from:owner");
  });

  it("searches from the saved handle over the one the links name", async () => {
    const db = seed([posted("r1")], { businesses: [site(SITE, USER, { xHandle: "acme_hq" })] });
    const { client, searchReplies } = fakeX([[theReply("1855000000000000101", { handle: "acme_hq" })]]);
    await findReplyLinks({ admin: db as never, client, now: at("2026-11-13T10:03:00Z") });
    expect(searchReplies.mock.calls[0][0].query).toContain("from:acme_hq");
    expect(searchReplies.mock.calls[0][0].query).not.toContain("from:owner");
    expect(target(db, "r1").published_url).toBe("https://x.com/acme_hq/status/1855000000000000101");
  });

  it("starts at most the daily bound of new replies a site in 24 hours; replies already searched go on", async () => {
    const earlier = Array.from({ length: LINK_SEARCH_NEW_REPLIES_PER_SITE_PER_DAY }, (_, i) => ({
      target_id: `old${i}`,
      user_id: USER,
      business_id: SITE,
      attempts: 4,
      outcome: "not_found",
      posts_seen: 0,
      created_at: "2026-11-13T02:00:00.000Z",
    }));
    const db = seed([posted("r1"), posted("r2", { url: "https://x.com/bob/status/1855000000000000300" })], {
      placement_link_searches: [
        ...earlier,
        { target_id: "r2", user_id: USER, business_id: SITE, attempts: 1, outcome: "not_found", posts_seen: 0, last_attempt_at: "2026-11-13T10:02:00.000Z", created_at: "2026-11-13T10:02:00.000Z" },
      ],
    });
    const { client, searchReplies } = fakeX();
    // 10:16: r2's second slot (15 min) is due; r1 would be a new reply.
    const outcome = await findReplyLinks({ admin: db as never, client, now: at("2026-11-13T10:16:00Z") });
    expect(searchReplies).toHaveBeenCalledTimes(1);
    expect(search(db, "r2")).toMatchObject({ attempts: 2 });
    expect(search(db, "r1")).toBeUndefined();
    expect(outcome.notEligible).toBe(1);

    // A day later the bound is free again.
    const later = seed([posted("r3", { published_at: "2026-11-14T10:00:00.000Z" })], { placement_link_searches: earlier });
    const second = fakeX();
    await findReplyLinks({ admin: later as never, client: second.client, now: at("2026-11-14T10:03:00Z") });
    expect(second.searchReplies).toHaveBeenCalledTimes(1);
  });

  it("never searches a removed reply, one on another platform, or one past X's 7 days", async () => {
    const db = seed([
      posted("removed", { removed_at: "2026-11-13T10:01:00Z" }),
      posted("reddit", { surface: "reddit", url: "https://www.reddit.com/r/seo/comments/abc/x/" }),
      posted("old", { published_at: "2026-11-05T10:00:00Z" }),
    ]);
    const { client, searchReplies } = fakeX([[theReply()]]);
    await findReplyLinks({ admin: db as never, client, now: at("2026-11-13T10:03:00Z") });
    expect(searchReplies).not.toHaveBeenCalled();
  });

  it("asks nothing without the platform's X API, and reads nothing either", async () => {
    const db = seed([posted("r1")]);
    const before = db.calls.length;
    const outcome = await findReplyLinks({ admin: db as never, now: at("2026-11-13T10:03:00Z") });
    expect(outcome.skipped).toBe("x_api_disabled");
    expect(db.calls.length).toBe(before);
  });

  it("at the monthly cap asks nothing and gives the attempt back", async () => {
    const db = seed([posted("r1")], { provider_spend: [{ provider: "x-api", month: MONTH, cost_usd: 19.98, calls: 0, posts: 0 }] });
    const { client, searchReplies } = fakeX([[theReply()]]);
    const outcome = await findReplyLinks({ admin: db as never, client, now: at("2026-11-13T10:03:00Z") });
    expect(outcome.stopped).toBe("cap");
    expect(searchReplies).not.toHaveBeenCalled();
    expect(search(db, "r1")).toMatchObject({ attempts: 0 });
  });

  it("stops starting searches once the run's time is spent; what is left waits for the next run", async () => {
    const db = seed([posted("r1"), posted("r2", { url: "https://x.com/bob/status/1855000000000000300" })]);
    const { client, searchReplies } = fakeX();
    const outcome = await findReplyLinks({ admin: db as never, client, now: at("2026-11-13T10:03:00Z"), budgetMs: -1 });
    expect(outcome).toMatchObject({ due: 2, searched: 0 });
    expect(searchReplies).not.toHaveBeenCalled();
    expect(db.tables.placement_link_searches).toEqual([]);
  });

  it("makes at most 10 searches a run, newest replies first", async () => {
    const rows = Array.from({ length: 14 }, (_, i) =>
      posted(`r${i}`, { url: `https://x.com/janedoe/status/18550000000000001${String(i).padStart(2, "0")}`, published_at: `2026-11-13T10:${String(i).padStart(2, "0")}:00.000Z` })
    );
    const db = seed(rows);
    const { client, searchReplies } = fakeX();
    await findReplyLinks({ admin: db as never, client, now: at("2026-11-13T10:30:00Z") });
    expect(searchReplies).toHaveBeenCalledTimes(LINK_SEARCH_ROWS_PER_RUN);
    expect(search(db, "r13")).toBeDefined();
    expect(search(db, "r0")).toBeUndefined();
  });
});

describe("whether GTF looks for a site's links", () => {
  const status = { enabled: true, capUsd: 20, spentUsd: 3, capReached: false, pausedUntil: null, resetsAt: "2026-12-01T00:00:00Z" };
  it("only with the platform on, the site's account known, the owner paying, not paused and under the cap", () => {
    expect(replyLinkFinderOn(status, { handleKnown: true, ownerPays: true })).toBe(true);
    expect(replyLinkFinderOn(null, { handleKnown: true, ownerPays: true })).toBe(false);
    expect(replyLinkFinderOn(status, { handleKnown: false, ownerPays: true })).toBe(false);
    expect(replyLinkFinderOn({ ...status, pausedUntil: "2026-11-13T11:00:00Z" }, { handleKnown: true, ownerPays: true })).toBe(false);
    expect(replyLinkFinderOn({ ...status, spentUsd: 19.99 }, { handleKnown: true, ownerPays: true })).toBe(false);
    expect(replyLinkFinderOn({ ...status, spentUsd: null }, { handleKnown: true, ownerPays: true })).toBe(false);
    // The sweep searches only for owners who pay: no card says GTF is looking otherwise.
    expect(replyLinkFinderOn(status, { handleKnown: true, ownerPays: false })).toBe(false);
  });
});

describe("find_reply_link: one reply, now", () => {
  const now = at("2026-11-13T10:01:00Z");
  const run = (db: LedgerFake, client: XApiClient | null, targetId = "r1") =>
    findReplyLinkNow({ supabase: db as never, admin: db as never, businessId: SITE, targetId, client, now });

  it("searches outside the schedule, saves through the caller's client, and counts the attempt", async () => {
    const db = seed([posted("r1")]);
    const { client } = fakeX([[theReply()]]);
    const result = await run(db, client);
    expect(result).toMatchObject({ ok: true, outcome: "found", url: "https://x.com/owner/status/1855000000000000101", costUsd: 0.005 });
    expect(target(db, "r1").published_url).toBe("https://x.com/owner/status/1855000000000000101");
    expect(search(db, "r1")).toMatchObject({ attempts: 1, outcome: "found" });
  });

  it("says GTF keeps looking when X has nothing yet", async () => {
    const db = seed([posted("r1")]);
    const result = await run(db, fakeX().client);
    expect(result).toMatchObject({ ok: true, outcome: "not_found", finding: { state: "looking" } });
  });

  it("searches on a site whose stored switch says off: the switch is gone", async () => {
    const db = seed([posted("r1")], { businesses: [site(SITE, USER, { findPostsOnX: false })] });
    expect(await run(db, fakeX([[theReply()]]).client)).toMatchObject({ ok: true, outcome: "found" });
  });

  it("refuses a new reply over the site's daily bound, in words", async () => {
    const earlier = Array.from({ length: LINK_SEARCH_NEW_REPLIES_PER_SITE_PER_DAY }, (_, i) => ({
      target_id: `old${i}`,
      user_id: USER,
      business_id: SITE,
      attempts: 1,
      outcome: "not_found",
      posts_seen: 0,
      created_at: "2026-11-13T09:00:00.000Z",
    }));
    const { client, searchReplies } = fakeX([[theReply()]]);
    expect(await run(seed([posted("r1")], { placement_link_searches: earlier }), client)).toMatchObject({
      ok: false,
      code: "invalid_state",
      error: expect.stringContaining("daily limit"),
    });
    expect(searchReplies).not.toHaveBeenCalled();
  });

  it("refuses in words: X off, not posted, linked, too many searches, account unknown (asking for it)", async () => {
    expect(await run(seed([posted("r1")]), null)).toMatchObject({ ok: false, code: "unavailable" });
    expect(await run(seed([posted("r1", { status: "drafted" })]), fakeX().client)).toMatchObject({ ok: false, code: "invalid_state" });
    expect(await run(seed([posted("r1", { published_url: "https://x.com/owner/status/1855000000000000555" })]), fakeX().client)).toMatchObject({
      ok: false,
      error: "This reply already has its link.",
    });
    const tried = seed([posted("r1")], { placement_link_searches: [{ target_id: "r1", user_id: USER, business_id: SITE, attempts: 6, outcome: "not_found", posts_seen: 0 }] });
    expect(await run(tried, fakeX().client)).toMatchObject({ ok: false, error: expect.stringContaining("6 times") });
    const noAccount = seed([posted("r1")]);
    noAccount.tables.placement_targets = noAccount.tables.placement_targets.filter((r) => r.id !== "known");
    expect(await run(noAccount, fakeX().client)).toMatchObject({ ok: false, code: "prerequisite_missing", error: expect.stringContaining("xHandle") });
    expect(await run(seed([posted("r1")]), fakeX().client, "nope")).toMatchObject({ ok: false, code: "not_found" });
  });
});
