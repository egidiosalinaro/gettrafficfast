import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { FakeSupabase } from "./support/fake-supabase";

/**
 * Who is calling (lib/api-auth.ts). What is pinned: a cookie session gets
 * its own RLS client and the selected site, falling back to the oldest as
 * the screens do; an API key gets the owner-scoped service role and its
 * site; a Bearer header that does not verify is a refusal, never a fall-back
 * to the cookie; `x-gtf-business` naming a site the account does not have
 * is 404, and a key for site A naming site B is 403.
 */

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const SITE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SITE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SITE_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const state = vi.hoisted(() => ({
  db: null as unknown as FakeSupabase,
  sessionUser: null as { id: string } | null,
  sessionClient: null as unknown,
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const client = {
      auth: { getUser: async () => ({ data: { user: state.sessionUser } }) },
      from: (table: string) => state.db.from(table),
    };
    state.sessionClient = client;
    return client;
  },
}));

import { chooseBusiness, cookieValue, resolveCaller } from "@/lib/api-auth";
import { createApiKey } from "@/lib/api-keys";
import { BUSINESS_COOKIE } from "@/lib/tenancy";

function seed() {
  state.db = new FakeSupabase({
    businesses: [
      { id: SITE_A, user_id: USER, name: "A", website_url: "https://a.test", created_at: "2026-01-01T00:00:00Z" },
      { id: SITE_B, user_id: USER, name: "B", website_url: "https://b.test", created_at: "2026-02-01T00:00:00Z" },
      { id: SITE_C, user_id: OTHER, name: "C", website_url: "https://c.test", created_at: "2026-01-15T00:00:00Z" },
    ],
    placement_targets: [
      { id: "t-a", user_id: USER, business_id: SITE_A },
      { id: "t-c", user_id: OTHER, business_id: SITE_C },
    ],
    api_keys: [],
  });
  return state.db;
}

async function keyFor(businessId: string | null, scopes = ["read", "write"]) {
  const created = await createApiKey(state.db as unknown as SupabaseClient, { userId: USER, name: "k", businessId, scopes });
  if (!created.ok) throw new Error(created.error);
  return created.key;
}

function request(headers: Record<string, string> = {}) {
  return new Request("https://gettrafficfa.st/api/v1/tools/whoami", { method: "POST", headers });
}

let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  seed();
  state.sessionUser = null;
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => errorSpy.mockRestore());

describe("resolveCaller with the session cookie", () => {
  it("uses the person's own client and the site the cookie selects", async () => {
    state.sessionUser = { id: USER };
    const resolved = await resolveCaller(request({ cookie: `other=1; ${BUSINESS_COOKIE}=${SITE_B}` }));
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.caller).toMatchObject({
      via: "session",
      userId: USER,
      businessId: SITE_B,
      businessIds: [SITE_A, SITE_B],
      keyId: null,
      scopes: ["read", "write", "spend", "publish"],
    });
    expect(resolved.caller.client).toBe(state.sessionClient);
  });

  it("falls back to the oldest site for a cookie naming someone else's, as the screens do", async () => {
    state.sessionUser = { id: USER };
    const resolved = await resolveCaller(request({ cookie: `${BUSINESS_COOKIE}=${SITE_C}` }));
    expect(resolved.ok && resolved.caller.businessId).toBe(SITE_A);
  });

  it("answers 404 for an x-gtf-business header naming a site the account does not have", async () => {
    state.sessionUser = { id: USER };
    const resolved = await resolveCaller(request({ "x-gtf-business": SITE_C }));
    expect(resolved).toMatchObject({ ok: false, status: 404, error: { code: "business_not_found" } });
  });

  it("answers 401 without a session", async () => {
    const resolved = await resolveCaller(request());
    expect(resolved).toMatchObject({ ok: false, status: 401, error: { code: "unauthorized" } });
  });
});

describe("resolveCaller with an API key", () => {
  it("acts for the key's owner, on the key's site, through the owner-scoped service role", async () => {
    const key = await keyFor(SITE_A, ["read", "write", "spend"]);
    const resolved = await resolveCaller(request({ authorization: `Bearer ${key}` }));
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.caller).toMatchObject({
      via: "api_key",
      userId: USER,
      businessId: SITE_A,
      businessIds: [SITE_A],
      scopes: ["read", "write", "spend"],
    });
    expect(resolved.caller.keyId).toBe(state.db.tables.api_keys[0].id);
    // The service role, narrowed: another account's row is not there.
    const { data } = await resolved.caller.client.from("placement_targets").select("id");
    expect((data as Array<{ id: string }>).map((r) => r.id)).toEqual(["t-a"]);
  });

  it("takes the header's site for a key for every site, and the oldest without one", async () => {
    const key = await keyFor(null);
    const named = await resolveCaller(request({ authorization: `Bearer ${key}`, "x-gtf-business": SITE_B }));
    expect(named.ok && named.caller.businessId).toBe(SITE_B);
    const first = await resolveCaller(request({ authorization: `Bearer ${key}`, cookie: `${BUSINESS_COOKIE}=${SITE_B}` }));
    // The cookie is a browser's preference: an API key ignores it.
    expect(first.ok && first.caller.businessId).toBe(SITE_A);
  });

  it("refuses site B with a key for site A (403), and a site that is not the account's (404)", async () => {
    const key = await keyFor(SITE_A);
    expect(await resolveCaller(request({ authorization: `Bearer ${key}`, "x-gtf-business": SITE_B }))).toMatchObject({
      ok: false,
      status: 403,
      error: { code: "forbidden_business" },
    });
    expect(await resolveCaller(request({ authorization: `Bearer ${key}`, "x-gtf-business": SITE_C }))).toMatchObject({
      ok: false,
      status: 404,
      error: { code: "business_not_found" },
    });
  });

  it("refuses a bad key with 401 and never falls back to the cookie", async () => {
    state.sessionUser = { id: USER };
    const bad = await resolveCaller(request({ authorization: "Bearer gtf_not-a-real-key", cookie: `${BUSINESS_COOKIE}=${SITE_A}` }));
    expect(bad).toMatchObject({ ok: false, status: 401, error: { code: "invalid_api_key" } });
    const basic = await resolveCaller(request({ authorization: "Basic dXNlcjpwYXNz" }));
    expect(basic).toMatchObject({ ok: false, status: 401, error: { code: "invalid_api_key" } });
  });

  it("refuses a revoked key", async () => {
    const key = await keyFor(SITE_A);
    state.db.tables.api_keys[0].revoked_at = "2026-11-09T10:00:00.000Z";
    expect(await resolveCaller(request({ authorization: `Bearer ${key}` }))).toMatchObject({
      ok: false,
      status: 401,
      error: { code: "revoked_api_key" },
    });
  });

  it("takes only a key where sessions are not allowed (MCP)", async () => {
    state.sessionUser = { id: USER };
    expect(await resolveCaller(request(), { allowSession: false })).toMatchObject({
      ok: false,
      status: 401,
      error: { code: "unauthorized" },
    });
  });
});

describe("chooseBusiness", () => {
  const owned = [{ id: SITE_A }, { id: SITE_B }];

  it("honours the cookie only with the screens' fall-back, and never for a key", () => {
    expect(chooseBusiness(owned, { preferred: SITE_B, allowFallback: true })).toMatchObject({ ok: true, businessId: SITE_B });
    expect(chooseBusiness(owned, { preferred: SITE_B })).toMatchObject({ ok: true, businessId: SITE_A });
    expect(chooseBusiness([], { allowFallback: true })).toMatchObject({ ok: true, businessId: null, businessIds: [] });
  });

  it("refuses a key whose site left the account", () => {
    expect(chooseBusiness(owned, { keyBusinessId: SITE_C })).toMatchObject({ ok: false, status: 403 });
  });
});

describe("cookieValue", () => {
  it("reads one cookie off the header", () => {
    const req = new Request("https://x.test", { headers: { cookie: "a=1; gtf-business=abc%20d; b=2" } });
    expect(cookieValue(req, "gtf-business")).toBe("abc d");
    expect(cookieValue(req, "missing")).toBeNull();
  });
});
