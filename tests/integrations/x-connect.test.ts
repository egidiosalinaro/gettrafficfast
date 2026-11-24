import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LedgerFake } from "../placements/x-fake";
import { decryptSecret } from "@/lib/integrations/crypto";
import { completeXConnect, startXConnect, xConnectPath, xRedirectUri } from "@/lib/integrations/x-connect";
import { openXOAuthState } from "@/lib/integrations/x-oauth-state";
import { X_POSTING_TABLE } from "@/lib/integrations/x-posting";
import { pkceChallenge } from "@/lib/providers/x/oauth";

/**
 * Connecting a site's X account, both halves, with X mocked: the start seals
 * the state and the PKCE verifier for this person and this site; the
 * callback checks them against what X sent, trades the code (one metered
 * account read in the platform's X ledger), stores the tokens encrypted for
 * the site the round trip started from, and saves the @username as the
 * site's X account when none was saved. Fictional accounts throughout.
 */

const USER = "user-1";
const SITE_A = "site-a";
const SITE_B = "site-b";
const CLIENT = { clientId: "test-client-id", clientSecret: "test-client-secret" };
const NOW = new Date("2026-11-24T10:00:00Z");
const REDIRECT = "https://app.example.test/api/integrations/x/callback";

beforeEach(() => {
  vi.stubEnv("INTEGRATIONS_ENCRYPTION_KEY", "ab".repeat(32));
});
afterEach(() => {
  vi.unstubAllEnvs();
});

function db(voice: Record<string, unknown> = {}) {
  return new LedgerFake({
    businesses: [
      { id: SITE_A, user_id: USER, name: "Acme", website_url: "https://acme.example.test", created_at: "2026-10-01T00:00:00Z", voice_settings: { aboutYou: "I run Acme.", ...voice } },
      { id: SITE_B, user_id: USER, name: "Bravo", website_url: "https://bravo.example.test", created_at: "2026-10-02T00:00:00Z", voice_settings: {} },
    ],
    [X_POSTING_TABLE]: [],
  });
}

/** X's token endpoint and /2/users/me, as a stub. */
function fakeX(username = "samrivdev", id = "1001") {
  return vi.fn(async (url: string) => {
    if (url.endsWith("/oauth2/token")) {
      return new Response(JSON.stringify({ access_token: "at-1", refresh_token: "rt-1", expires_in: 7200, scope: "tweet.read tweet.write users.read offline.access" }), { status: 200 });
    }
    if (url.endsWith("/users/me")) return new Response(JSON.stringify({ data: { id, username, name: "Sam" } }), { status: 200 });
    return new Response("", { status: 404 });
  });
}

function started(businessId = SITE_A) {
  const start = startXConnect({ userId: USER, businessId, oauthClient: CLIENT, redirectUri: REDIRECT, now: NOW });
  if (!start.ok) throw new Error("not started");
  const state = new URL(start.authorizeUrl).searchParams.get("state")!;
  return { ...start, state };
}

async function complete(fake: LedgerFake, over: Partial<Parameters<typeof completeXConnect>[0]> = {}) {
  const start = started();
  return completeXConnect({
    supabase: fake as never,
    admin: fake as never,
    userId: USER,
    sealed: start.cookie,
    query: { code: "the-code", state: start.state },
    oauthClient: CLIENT,
    redirectUri: REDIRECT,
    fetchImpl: fakeX() as never,
    now: NOW,
    ...over,
  });
}

describe("startXConnect", () => {
  it("binds the round trip to the person and the site, with a S256 challenge of the sealed verifier", () => {
    const start = started(SITE_B);
    const url = new URL(start.authorizeUrl);
    const opened = openXOAuthState(start.cookie, NOW)!;
    expect(opened).toMatchObject({ userId: USER, businessId: SITE_B, state: start.state });
    expect(url.searchParams.get("code_challenge")).toBe(pkceChallenge(opened.verifier));
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
  });

  it("is not offered without the deployment's client", () => {
    expect(startXConnect({ userId: USER, businessId: SITE_A, oauthClient: null })).toEqual({ ok: false, error: "not_configured" });
  });

  it("names the callback on the deployment's own origin, and the link that starts it for a site", () => {
    expect(xRedirectUri("https://app.example.test/")).toBe(REDIRECT);
    expect(xConnectPath(SITE_A)).toBe("/api/integrations/x/connect?business=site-a");
  });
});

describe("completeXConnect", () => {
  it("stores the tokens encrypted for the site, counts the account read, and saves the @username as the site's X account", async () => {
    const fake = db();
    expect(await complete(fake)).toEqual({ ok: true, businessId: SITE_A, username: "samrivdev", handleSaved: true });
    const row = fake.tables[X_POSTING_TABLE][0];
    expect(row).toMatchObject({ user_id: USER, business_id: SITE_A, x_user_id: "1001", username: "samrivdev", status: "connected" });
    expect(decryptSecret(String(row.access_token_encrypted))).toBe("at-1");
    expect(decryptSecret(String(row.refresh_token_encrypted))).toBe("rt-1");
    expect((fake.tables.businesses[0].voice_settings as Record<string, unknown>).xHandle).toBe("samrivdev");
    expect(fake.spend("2026-11-01")).toMatchObject({ calls: 1, posts: 1 });
  });

  it("sends the code with the sealed verifier to X's token endpoint", async () => {
    const fake = db();
    const fetchImpl = fakeX();
    const start = started();
    await completeXConnect({
      supabase: fake as never,
      admin: fake as never,
      userId: USER,
      sealed: start.cookie,
      query: { code: "the-code", state: start.state },
      oauthClient: CLIENT,
      redirectUri: REDIRECT,
      fetchImpl: fetchImpl as never,
      now: NOW,
    });
    const tokenCall = fetchImpl.mock.calls.find((call) => String(call[0]).endsWith("/oauth2/token")) as unknown as [string, RequestInit];
    const form = new URLSearchParams(String(tokenCall[1].body));
    expect(form.get("code_verifier")).toBe(openXOAuthState(start.cookie, NOW)!.verifier);
    expect(form.get("code")).toBe("the-code");
  });

  it("keeps an X account the person saved before", async () => {
    const fake = db({ xHandle: "postwren" });
    expect(await complete(fake)).toMatchObject({ ok: true, handleSaved: false });
    expect((fake.tables.businesses[0].voice_settings as Record<string, unknown>).xHandle).toBe("postwren");
  });

  it("refuses a state that does not match, another person's round trip, or an expired one, before calling X", async () => {
    const fetchImpl = fakeX();
    expect(await complete(db(), { query: { code: "c", state: "forged" }, fetchImpl: fetchImpl as never })).toEqual({ ok: false, error: "state_mismatch" });
    expect(await complete(db(), { userId: "someone-else", fetchImpl: fetchImpl as never })).toEqual({ ok: false, error: "state_mismatch" });
    expect(await complete(db(), { now: new Date(NOW.getTime() + 11 * 60 * 1000), fetchImpl: fetchImpl as never })).toEqual({ ok: false, error: "state_mismatch" });
    expect(await complete(db(), { sealed: null, fetchImpl: fetchImpl as never })).toEqual({ ok: false, error: "state_mismatch" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("stops when the person cancelled on X, or the site is no longer theirs", async () => {
    expect(await complete(db(), { query: { error: "access_denied" } })).toEqual({ ok: false, error: "denied" });
    const fake = db();
    fake.tables.businesses = fake.tables.businesses.filter((b) => b.id !== SITE_A);
    expect(await complete(fake)).toEqual({ ok: false, error: "site_not_found" });
    expect(fake.tables[X_POSTING_TABLE]).toEqual([]);
  });

  it("stores nothing when X refuses the code", async () => {
    const fake = db();
    const refused = vi.fn(async () => new Response(JSON.stringify({ error: "invalid_request" }), { status: 400 }));
    expect(await complete(fake, { fetchImpl: refused as never })).toMatchObject({ ok: false, error: "exchange_failed" });
    expect(fake.tables[X_POSTING_TABLE]).toEqual([]);
  });

  it("does not read the account over the platform's monthly X cap", async () => {
    vi.stubEnv("X_API_MONTHLY_CAP_USD", "1");
    const fake = db();
    fake.tables.provider_spend.push({ provider: "x-api", month: "2026-11-01", cost_usd: 1, calls: 0, posts: 0 });
    expect(await complete(fake)).toEqual({ ok: false, error: "cap_reached" });
    expect(fake.tables[X_POSTING_TABLE]).toEqual([]);
  });
});
