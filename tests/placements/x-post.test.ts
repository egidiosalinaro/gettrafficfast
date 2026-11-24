import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LedgerFake } from "./x-fake";
import { X_POSTING_TABLE, saveXConnection } from "@/lib/integrations/x-posting";
import { postReplyOnX, postStandaloneOnX } from "@/lib/placements/x-post";
import { X_POST_USD_PER_POST } from "@/lib/providers/x/post";

/**
 * Post on X, end to end with X mocked: one press posts the stored draft from
 * the site's connected account and records it as posted with its real link
 * (no link search); a reply X refuses gives the claim back and hands over
 * X's composer; nothing is posted over the platform's monthly X cap, on a
 * post that does not mention the account, without a connection, or twice.
 * Every post is counted in the platform's X ledger. Fictional accounts.
 */

const USER = "user-1";
const SITE_A = "site-a";
const SITE_B = "site-b";
const THREAD = "1850000000000000000";
const CLIENT = { clientId: "test-client-id", clientSecret: "test-client-secret" };
const NOW = new Date("2026-11-24T10:00:00Z");
const DRAFT = "Same here: we keep the notes in the repo and paste them in.";

beforeEach(() => {
  vi.stubEnv("INTEGRATIONS_ENCRYPTION_KEY", "ab".repeat(32));
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function target(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    user_id: USER,
    business_id: SITE_A,
    surface: "x",
    kind: "post",
    url: `https://x.com/postwren/status/${THREAD}`,
    title: "@samrivdev which tool do you use for release notes?",
    excerpt: "@samrivdev which tool do you use for release notes?",
    author: "postwren",
    status: "drafted",
    published_url: null,
    published_at: null,
    published_note: null,
    selected_placement_id: null,
    snoozed_until: null,
    created_at: "2026-11-24T08:00:00Z",
    ...over,
  };
}

async function seed(targets = [target("t1")]) {
  const db = new LedgerFake({
    businesses: [{ id: SITE_A, user_id: USER, name: "Acme", voice_settings: {} }],
    placement_targets: targets,
    placements: targets.map((t) => ({
      id: `d-${t.id}`,
      user_id: USER,
      business_id: t.business_id,
      target_id: t.id,
      variant: "short_comment",
      body: DRAFT,
      audit: { status: "passed", checks: [] },
      audit_status: "passed",
      agent_version: 3,
      created_at: "2026-11-24T08:30:00Z",
      updated_at: "2026-11-24T08:30:00Z",
    })),
    [X_POSTING_TABLE]: [],
  });
  await saveXConnection({
    admin: db as never,
    userId: USER,
    businessId: SITE_A,
    me: { id: "1001", username: "samrivdev" },
    tokens: { accessToken: "at-a", refreshToken: "rt-a", expiresAt: new Date(NOW.getTime() + 7_200_000), scopes: [] },
    now: NOW,
  });
  return db;
}

function xAnswers(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

const posted = () => xAnswers(201, { data: { id: "1860000000000000001", text: DRAFT } });

async function press(db: LedgerFake, fetchImpl: ReturnType<typeof vi.fn>, targetId = "t1") {
  return postReplyOnX({
    supabase: db as never,
    admin: db as never,
    userId: USER,
    businessId: SITE_A,
    targetId,
    draftId: `d-${targetId}`,
    oauthClient: CLIENT,
    fetchImpl: fetchImpl as never,
    now: NOW,
  });
}

const row = (db: LedgerFake, id = "t1") => db.tables.placement_targets.find((r) => r.id === id)!;

describe("postReplyOnX", () => {
  it("posts the stored draft as a reply, records it as posted with its real link, and counts it in the ledger", async () => {
    const db = await seed();
    const fetchImpl = posted();
    const result = await press(db, fetchImpl);
    expect(result).toMatchObject({ ok: true, url: "https://x.com/samrivdev/status/1860000000000000001", postId: "1860000000000000001" });
    expect(JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({
      text: DRAFT,
      reply: { in_reply_to_tweet_id: THREAD },
    });
    expect(row(db)).toMatchObject({
      status: "published_manually",
      published_url: "https://x.com/samrivdev/status/1860000000000000001",
      selected_placement_id: "d-t1",
      published_at: NOW.toISOString(),
    });
    expect(db.spend("2026-11-01")).toMatchObject({ cost_usd: X_POST_USD_PER_POST, calls: 1, posts: 1 });
  });

  it("falls back to X's composer when X refuses the reply, and gives the claim back", async () => {
    const db = await seed();
    const refused = xAnswers(403, { title: "Forbidden", detail: "Reply to this conversation is not allowed because you have not been mentioned or otherwise engaged by the author." });
    const result = await press(db, refused);
    expect(result).toMatchObject({ ok: false, code: "reply_not_allowed", status: 403 });
    if (result.ok) return;
    expect(result.intentUrl).toBe(`https://x.com/intent/tweet?text=${encodeURIComponent(DRAFT)}&in_reply_to=${THREAD}`);
    expect(row(db)).toMatchObject({ status: "drafted", published_url: null, published_at: null });
    // A refused post is not billed.
    expect(db.spend("2026-11-01")).toMatchObject({ cost_usd: 0, calls: 1, posts: 0 });
  });

  it("refuses over the platform's monthly X cap, without calling X, and gives the claim back", async () => {
    vi.stubEnv("X_API_MONTHLY_CAP_USD", "1");
    const db = await seed();
    db.tables.provider_spend.push({ provider: "x-api", month: "2026-11-01", cost_usd: 0.995, calls: 0, posts: 0 });
    const fetchImpl = posted();
    const result = await press(db, fetchImpl);
    expect(result).toMatchObject({ ok: false, code: "cap_reached", status: 429 });
    if (!result.ok) expect(result.error).toContain("Posting from GTF on X is paused until Dec 1");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(row(db).status).toBe("drafted");
  });

  it("does not post to a post that does not mention or quote the account: today's flow", async () => {
    const db = await seed([target("t1", { title: "Which tool do you use?", excerpt: "Which tool do you use?" })]);
    const fetchImpl = posted();
    const result = await press(db, fetchImpl);
    expect(result).toMatchObject({ ok: false, code: "not_allowed", intentUrl: expect.stringContaining("https://x.com/intent/tweet") });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(row(db).status).toBe("drafted");
  });

  it("posts once: a second press finds the reply already posted", async () => {
    const db = await seed();
    const fetchImpl = posted();
    expect((await press(db, fetchImpl)).ok).toBe(true);
    expect(await press(db, fetchImpl)).toMatchObject({ ok: false, code: "invalid_state" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("needs a connection for the site, and a draft the checks did not stop", async () => {
    const db = await seed();
    db.tables[X_POSTING_TABLE] = [];
    expect(await press(db, posted())).toMatchObject({ ok: false, code: "not_connected" });

    const blocked = await seed();
    blocked.tables.placements[0].audit_status = "blocked";
    expect(await press(blocked, posted())).toMatchObject({ ok: false, code: "invalid_state" });
  });

  it("asks to connect again when X no longer accepts the token, and marks the connection", async () => {
    const db = await seed();
    const result = await press(db, xAnswers(401, { title: "Unauthorized" }));
    expect(result).toMatchObject({ ok: false, code: "auth_expired" });
    expect(db.tables[X_POSTING_TABLE][0].status).toBe("error");
    expect(row(db).status).toBe("drafted");
  });

  it("posts from each site's own account: two sites, two accounts", async () => {
    const db = await seed([target("t1"), target("t2", { business_id: SITE_B, title: "@postwren thoughts?", excerpt: "@postwren thoughts?", author: "someone" })]);
    db.tables.businesses.push({ id: SITE_B, user_id: USER, name: "Bravo", voice_settings: {} });
    await saveXConnection({
      admin: db as never,
      userId: USER,
      businessId: SITE_B,
      me: { id: "2002", username: "postwren" },
      tokens: { accessToken: "at-b", refreshToken: "rt-b", expiresAt: new Date(NOW.getTime() + 7_200_000), scopes: [] },
      now: NOW,
    });
    const fetchImpl = xAnswers(201, { data: { id: "1860000000000000009", text: DRAFT } });
    const result = await postReplyOnX({
      supabase: db as never,
      admin: db as never,
      userId: USER,
      businessId: SITE_B,
      targetId: "t2",
      draftId: "d-t2",
      oauthClient: CLIENT,
      fetchImpl: fetchImpl as never,
      now: NOW,
    });
    expect(result).toMatchObject({ ok: true, url: "https://x.com/postwren/status/1860000000000000009" });
    expect(((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>).Authorization).toBe("Bearer at-b");
    // Site A still posts from its own account.
    const fromA = posted();
    expect(await press(db, fromA, "t1")).toMatchObject({ ok: true, url: expect.stringContaining("https://x.com/samrivdev/status/") });
    expect(((fromA.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>).Authorization).toBe("Bearer at-a");
    // And a site's target is not reachable from the other site.
    expect(
      await postReplyOnX({ supabase: db as never, admin: db as never, userId: USER, businessId: SITE_B, targetId: "t1", draftId: "d-t1", oauthClient: CLIENT, fetchImpl: posted() as never, now: NOW })
    ).toMatchObject({ ok: false, code: "not_found" });
  });
});

describe("postStandaloneOnX", () => {
  it("posts the account's own post, counted in the ledger", async () => {
    const db = await seed();
    const fetchImpl = xAnswers(201, { data: { id: "1860000000000000005", text: "Shipped release notes." } });
    expect(
      await postStandaloneOnX({ admin: db as never, userId: USER, businessId: SITE_A, text: " Shipped release notes. ", oauthClient: CLIENT, fetchImpl: fetchImpl as never, now: NOW })
    ).toEqual({ ok: true, url: "https://x.com/samrivdev/status/1860000000000000005", postId: "1860000000000000005", username: "samrivdev" });
    expect(JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ text: "Shipped release notes." });
    expect(db.spend("2026-11-01")).toMatchObject({ calls: 1, posts: 1 });
  });

  it("refuses an empty post", async () => {
    const db = await seed();
    expect(await postStandaloneOnX({ admin: db as never, userId: USER, businessId: SITE_A, text: "  ", oauthClient: CLIENT })).toMatchObject({ ok: false });
  });
});
