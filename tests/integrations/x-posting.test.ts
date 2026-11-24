import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "../support/fake-supabase";
import { decryptSecret } from "@/lib/integrations/crypto";
import { X_OAUTH_STATE_TTL_SECONDS, openXOAuthState, sealXOAuthState } from "@/lib/integrations/x-oauth-state";
import {
  X_POSTING_TABLE,
  disconnectXAccount,
  loadXPostingAccount,
  saveXConnection,
  xAccessTokenFor,
} from "@/lib/integrations/x-posting";

/**
 * The X account a site posts from, stored: tokens encrypted at rest, one row
 * per site (two sites may hold different accounts, or the same one), the
 * access token refreshed before it lapses (X rotates the refresh token, so
 * the new pair is stored), a refused refresh marks the row for reconnecting,
 * and disconnecting revokes at X and deletes the row. Fictional accounts.
 */

const USER = "user-1";
const SITE_A = "site-a";
const SITE_B = "site-b";
const CLIENT = { clientId: "test-client-id", clientSecret: "test-client-secret" };
const NOW = new Date("2026-11-24T10:00:00Z");

beforeEach(() => {
  vi.stubEnv("INTEGRATIONS_ENCRYPTION_KEY", "ab".repeat(32));
});
afterEach(() => {
  vi.unstubAllEnvs();
});

function tokens(access: string, refresh: string | null, expiresInMs = 2 * 60 * 60 * 1000) {
  return { accessToken: access, refreshToken: refresh, expiresAt: new Date(NOW.getTime() + expiresInMs), scopes: ["tweet.read", "tweet.write", "users.read", "offline.access"] };
}

async function connected(db: FakeSupabase, businessId: string, username: string, id: string, t = tokens(`at-${username}`, `rt-${username}`)) {
  const saved = await saveXConnection({ admin: db as never, userId: USER, businessId, me: { id, username }, tokens: t, now: NOW });
  expect(saved).toEqual({ ok: true });
}

describe("the connect state cookie", () => {
  const state = { state: "s".repeat(43), verifier: "v".repeat(43), userId: USER, businessId: SITE_A, expiresAt: NOW.getTime() + X_OAUTH_STATE_TTL_SECONDS * 1000 };

  it("seals the verifier (unreadable) and opens it back", () => {
    const sealed = sealXOAuthState(state);
    expect(sealed).not.toContain("v".repeat(10));
    expect(openXOAuthState(sealed, NOW)).toEqual(state);
  });

  it("refuses an altered, expired or missing cookie", () => {
    const sealed = sealXOAuthState(state);
    const [iv, tag, ct] = sealed.split(":");
    const flipped = `${iv}:${tag}:${ct.slice(0, -2)}${ct.endsWith("A") ? "B" : "A"}=`;
    expect(openXOAuthState(flipped, NOW)).toBeNull();
    expect(openXOAuthState(sealed, new Date(state.expiresAt + 1))).toBeNull();
    expect(openXOAuthState(undefined, NOW)).toBeNull();
    expect(openXOAuthState("garbage", NOW)).toBeNull();
  });
});

describe("storing the connection", () => {
  it("encrypts both tokens at rest and never returns them on a read", async () => {
    const db = new FakeSupabase({ [X_POSTING_TABLE]: [] });
    await connected(db, SITE_A, "samrivdev", "1001");
    const row = db.tables[X_POSTING_TABLE][0];
    expect(row.access_token_encrypted).not.toContain("at-samrivdev");
    expect(row.refresh_token_encrypted).not.toContain("rt-samrivdev");
    expect(decryptSecret(String(row.access_token_encrypted))).toBe("at-samrivdev");
    expect(decryptSecret(String(row.refresh_token_encrypted))).toBe("rt-samrivdev");
    const account = await loadXPostingAccount(db as never, USER, SITE_A);
    expect(account).toEqual({ username: "samrivdev", xUserId: "1001", status: "connected", lastError: null, connectedAt: expect.any(String) });
    expect(JSON.stringify(account)).not.toContain("at-samrivdev");
  });

  it("keeps one account per site: two sites, two accounts, each its own token", async () => {
    const db = new FakeSupabase({ [X_POSTING_TABLE]: [] });
    await connected(db, SITE_A, "samrivdev", "1001");
    await connected(db, SITE_B, "postwren", "2002");
    expect((await loadXPostingAccount(db as never, USER, SITE_A))?.username).toBe("samrivdev");
    expect((await loadXPostingAccount(db as never, USER, SITE_B))?.username).toBe("postwren");
    const a = await xAccessTokenFor({ admin: db as never, userId: USER, businessId: SITE_A, oauthClient: CLIENT, now: NOW });
    const b = await xAccessTokenFor({ admin: db as never, userId: USER, businessId: SITE_B, oauthClient: CLIENT, now: NOW });
    expect(a).toMatchObject({ ok: true, accessToken: "at-samrivdev" });
    expect(b).toMatchObject({ ok: true, accessToken: "at-postwren" });
    // Connecting again replaces the site's row; the other site is untouched.
    await connected(db, SITE_A, "postwren", "2002");
    expect(db.tables[X_POSTING_TABLE]).toHaveLength(2);
    expect((await loadXPostingAccount(db as never, USER, SITE_A))?.username).toBe("postwren");
  });

  it("reads no other owner's row", async () => {
    const db = new FakeSupabase({ [X_POSTING_TABLE]: [] });
    await connected(db, SITE_A, "samrivdev", "1001");
    expect(await loadXPostingAccount(db as never, "someone-else", SITE_A)).toBeNull();
    expect(await xAccessTokenFor({ admin: db as never, userId: "someone-else", businessId: SITE_A, oauthClient: CLIENT, now: NOW })).toMatchObject({
      ok: false,
      reason: "not_connected",
    });
  });
});

describe("refreshing", () => {
  it("refreshes a token about to lapse and stores the rotated pair, encrypted", async () => {
    const db = new FakeSupabase({ [X_POSTING_TABLE]: [] });
    await connected(db, SITE_A, "samrivdev", "1001", tokens("at-old", "rt-old", 60_000));
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ access_token: "at-new", refresh_token: "rt-new", expires_in: 7200 }), { status: 200 }));
    const token = await xAccessTokenFor({ admin: db as never, userId: USER, businessId: SITE_A, oauthClient: CLIENT, fetchImpl, now: NOW });
    expect(token).toMatchObject({ ok: true, accessToken: "at-new" });
    const form = new URLSearchParams(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("rt-old");
    const row = db.tables[X_POSTING_TABLE][0];
    expect(decryptSecret(String(row.access_token_encrypted))).toBe("at-new");
    expect(decryptSecret(String(row.refresh_token_encrypted))).toBe("rt-new");
    expect(row.expires_at).toBe(new Date(NOW.getTime() + 7200 * 1000).toISOString());
  });

  it("does not refresh a token with time left", async () => {
    const db = new FakeSupabase({ [X_POSTING_TABLE]: [] });
    await connected(db, SITE_A, "samrivdev", "1001");
    const fetchImpl = vi.fn();
    expect(await xAccessTokenFor({ admin: db as never, userId: USER, businessId: SITE_A, oauthClient: CLIENT, fetchImpl, now: NOW })).toMatchObject({ ok: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("marks the connection for reconnecting when X refuses the refresh token", async () => {
    const db = new FakeSupabase({ [X_POSTING_TABLE]: [] });
    await connected(db, SITE_A, "samrivdev", "1001", tokens("at-old", "rt-old", 60_000));
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: "invalid_request" }), { status: 400 }));
    expect(await xAccessTokenFor({ admin: db as never, userId: USER, businessId: SITE_A, oauthClient: CLIENT, fetchImpl, now: NOW })).toMatchObject({
      ok: false,
      reason: "auth_expired",
    });
    expect(db.tables[X_POSTING_TABLE][0].status).toBe("error");
    expect((await loadXPostingAccount(db as never, USER, SITE_A))?.status).toBe("error");
  });

  it("is unavailable without the deployment's OAuth client", async () => {
    const db = new FakeSupabase({ [X_POSTING_TABLE]: [] });
    await connected(db, SITE_A, "samrivdev", "1001");
    expect(await xAccessTokenFor({ admin: db as never, userId: USER, businessId: SITE_A, oauthClient: null, now: NOW })).toMatchObject({ ok: false, reason: "unavailable" });
  });
});

describe("disconnecting", () => {
  it("revokes both tokens at X and deletes the site's row only", async () => {
    const db = new FakeSupabase({ [X_POSTING_TABLE]: [] });
    await connected(db, SITE_A, "samrivdev", "1001");
    await connected(db, SITE_B, "postwren", "2002");
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ revoked: true }), { status: 200 }));
    expect(await disconnectXAccount({ admin: db as never, userId: USER, businessId: SITE_A, oauthClient: CLIENT, fetchImpl })).toEqual({
      ok: true,
      disconnected: true,
      revoked: true,
    });
    const hints = fetchImpl.mock.calls.map((call) => new URLSearchParams(String((call as unknown as [string, RequestInit])[1].body)).get("token_type_hint"));
    expect(hints.sort()).toEqual(["access_token", "refresh_token"]);
    expect(db.tables[X_POSTING_TABLE].map((r) => r.business_id)).toEqual([SITE_B]);
    expect(await disconnectXAccount({ admin: db as never, userId: USER, businessId: SITE_A, oauthClient: CLIENT, fetchImpl })).toEqual({
      ok: true,
      disconnected: false,
      revoked: false,
    });
  });

  it("deletes the row even when X does not confirm the revocation", async () => {
    const db = new FakeSupabase({ [X_POSTING_TABLE]: [] });
    await connected(db, SITE_A, "samrivdev", "1001");
    const fetchImpl = vi.fn(async () => new Response("", { status: 503 }));
    expect(await disconnectXAccount({ admin: db as never, userId: USER, businessId: SITE_A, oauthClient: CLIENT, fetchImpl })).toMatchObject({ disconnected: true, revoked: false });
    expect(db.tables[X_POSTING_TABLE]).toEqual([]);
  });
});
