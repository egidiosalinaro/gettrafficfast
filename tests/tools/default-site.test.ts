import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeSupabase } from "../support/fake-supabase";
import { SITE_A, SITE_B, SITE_C, USER, asClient, codeForm, consent, register, seedDb } from "../oauth/support";

/**
 * The default site of a connection (lib/tools/site.ts `saveDefaultSite`, the
 * `set_default_site` tool, Settings → Claude and API). Pinned: the default
 * is saved on the credential the call comes with (the grant of a connected
 * app, or the API key), named by id, name or domain among the sites that
 * credential covers, and never outside them; null goes back to the oldest;
 * a call that names no site then acts on it, a refresh keeps it, and the
 * header or the `site` argument still win for one call; a saved site that
 * is gone falls back to the oldest; whoami and list_businesses say which
 * default and where it comes from; a browser session is told to use the
 * site picker; it needs the write scope; the screen's routes save through
 * the same function.
 */

const state = vi.hoisted(() => ({
  db: null as unknown as FakeSupabase,
  sessionUser: null as { id: string } | null,
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: state.sessionUser } }) },
    from: (table: string) => state.db.from(table),
  }),
}));
vi.mock("@/lib/subscription", () => ({ hasActiveSubscription: async () => true }));

import { chooseBusiness, resolveCaller, type Caller } from "@/lib/api-auth";
import { createApiKey } from "@/lib/api-keys";
import { findClient } from "@/lib/oauth/clients";
import { MCP_RESOURCE } from "@/lib/oauth/config";
import { exchangeAuthorizationCode, listConnectedApps, refreshAccessToken } from "@/lib/oauth/tokens";
import { runTool } from "@/lib/tools/runner";
import { callerForSite } from "@/lib/tools/site";
import { PATCH as patchKey } from "@/app/api/api-keys/[id]/route";
import { PATCH as patchApp } from "@/app/api/connected-apps/[id]/route";

let clientId: string;
let errorSpy: ReturnType<typeof vi.spyOn>;
let infoSpy: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  state.db = seedDb();
  state.db.tables.api_keys = [];
  state.sessionUser = null;
  clientId = (await register(state.db)).clientId;
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  errorSpy.mockRestore();
  infoSpy.mockRestore();
});

async function tokensFor(choice: { grant?: string[]; site?: string } = {}) {
  const code = await consent(state.db, clientId, { grant: ["read", "write"], ...choice }, new Date());
  const client = await findClient(asClient(state.db), clientId);
  if (!client) throw new Error("no client");
  const result = await exchangeAuthorizationCode(asClient(state.db), client, codeForm(clientId, code));
  if (!result.ok) throw new Error(result.description);
  return result.body;
}

const atMcp = { allowSession: false, oauthResource: MCP_RESOURCE };

function request(authorization: string, headers: Record<string, string> = {}) {
  return new Request("https://gettrafficfa.st/api/mcp", { method: "POST", headers: { authorization, ...headers } });
}

async function callerOf(
  authorization: string,
  headers: Record<string, string> = {},
  options: { allowSession?: boolean; oauthResource?: string } = atMcp
): Promise<Caller> {
  const resolved = await resolveCaller(request(authorization, headers), options);
  if (!resolved.ok) throw new Error(resolved.error.message);
  return resolved.caller;
}

const run = (caller: Caller, name: string, input: unknown) => runTool(caller, name, input, { admin: () => asClient(state.db) });

async function keyFor(businessId: string | null, scopes = ["read", "write"]) {
  const created = await createApiKey(asClient(state.db), { userId: USER, name: "k", businessId, scopes });
  if (!created.ok) throw new Error(created.error);
  return created;
}

describe("set_default_site on a connected app", () => {
  it("saves the site named by name, domain or id on the grant, and calls that name none act on it", async () => {
    const { access_token } = await tokensFor({ site: "all" });
    const bearer = `Bearer ${access_token}`;
    expect((await callerOf(bearer)).businessId).toBe(SITE_A);

    expect(await run(await callerOf(bearer), "set_default_site", { site: "bravo" })).toEqual({
      ok: true,
      output: { defaultSite: { id: SITE_B, name: "Bravo", websiteUrl: "https://bravo.test" }, defaultSource: "saved" },
    });
    expect(state.db.tables.oauth_tokens.every((row) => row.default_business_id === SITE_B)).toBe(true);
    expect(await callerOf(bearer)).toMatchObject({ businessId: SITE_B, defaultSite: { businessId: SITE_B, source: "saved" } });

    await run(await callerOf(bearer), "set_default_site", { site: "https://www.ACME.test/blog" });
    expect((await callerOf(bearer)).businessId).toBe(SITE_A);
    await run(await callerOf(bearer), "set_default_site", { site: SITE_B });
    expect((await callerOf(bearer)).businessId).toBe(SITE_B);
  });

  it("goes back to the oldest site with site null", async () => {
    const { access_token } = await tokensFor({ site: "all" });
    const bearer = `Bearer ${access_token}`;
    await run(await callerOf(bearer), "set_default_site", { site: "Bravo" });
    expect(await run(await callerOf(bearer), "set_default_site", { site: null })).toMatchObject({
      ok: true,
      output: { defaultSite: { id: SITE_A }, defaultSource: "oldest" },
    });
    expect(await callerOf(bearer)).toMatchObject({ businessId: SITE_A, defaultSite: { source: "oldest" } });
  });

  it("refuses a site outside the grant, or another account's, and saves nothing", async () => {
    const { access_token } = await tokensFor({ site: "all" });
    const caller = await callerOf(`Bearer ${access_token}`);
    expect(await run(caller, "set_default_site", { site: "Charlie" })).toMatchObject({
      ok: false,
      status: 404,
      error: { code: "business_not_found" },
    });
    expect(await run(caller, "set_default_site", { site: SITE_C })).toMatchObject({ ok: false, status: 404 });
    expect(state.db.tables.oauth_tokens.every((row) => !row.default_business_id)).toBe(true);
  });

  it("keeps a one-site grant on its site: another of the owner's sites is refused, its own is accepted", async () => {
    const { access_token } = await tokensFor({ site: SITE_A });
    const caller = await callerOf(`Bearer ${access_token}`);
    expect(await run(caller, "set_default_site", { site: "Bravo" })).toMatchObject({
      ok: false,
      status: 403,
      error: { code: "forbidden_business" },
    });
    expect(await run(caller, "set_default_site", { site: "acme" })).toMatchObject({
      ok: true,
      output: { defaultSite: { id: SITE_A }, defaultSource: "only_site" },
    });
    expect(await run(caller, "whoami", {})).toMatchObject({ ok: true, output: { defaultSite: { id: SITE_A }, defaultSource: "only_site" } });
  });

  it("needs the write scope", async () => {
    const { access_token } = await tokensFor({ site: "all", grant: ["read"] });
    expect(await run(await callerOf(`Bearer ${access_token}`), "set_default_site", { site: "Bravo" })).toMatchObject({
      ok: false,
      status: 403,
      error: { code: "forbidden_scope" },
    });
  });

  it("is kept by a refresh", async () => {
    const first = await tokensFor({ site: "all" });
    await run(await callerOf(`Bearer ${first.access_token}`), "set_default_site", { site: "Bravo" });
    const client = await findClient(asClient(state.db), clientId);
    if (!client) throw new Error("no client");
    const params = new URLSearchParams({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: clientId });
    const second = await refreshAccessToken(asClient(state.db), client, params);
    if (!second.ok) throw new Error(second.description);
    expect((await callerOf(`Bearer ${second.body.access_token}`)).businessId).toBe(SITE_B);
    const apps = await listConnectedApps(asClient(state.db), asClient(state.db), USER);
    expect(apps.map((app) => app.defaultBusinessId)).toEqual([SITE_B]);
  });

  it("falls back to the oldest site when the saved one is no longer the account's", async () => {
    const { access_token } = await tokensFor({ site: "all" });
    const bearer = `Bearer ${access_token}`;
    await run(await callerOf(bearer), "set_default_site", { site: "Bravo" });
    // Bravo is deleted (the database sets the default null; a stale value must not matter either).
    state.db.tables.businesses = state.db.tables.businesses.filter((row) => row.id !== SITE_B);
    expect(await callerOf(bearer)).toMatchObject({ businessId: SITE_A, defaultSite: { businessId: SITE_A, source: "oldest" } });
  });

  it("is overridden for one call by the header or the site argument", async () => {
    const { access_token } = await tokensFor({ site: "all" });
    const bearer = `Bearer ${access_token}`;
    await run(await callerOf(bearer), "set_default_site", { site: "Bravo" });
    const named = await callerOf(bearer, { "x-gtf-business": SITE_A });
    expect(named).toMatchObject({ businessId: SITE_A, defaultSite: { businessId: SITE_B, source: "saved" } });
    expect(await run(named, "whoami", {})).toMatchObject({ ok: true, output: { business: { id: SITE_A }, defaultSite: { id: SITE_B } } });
    const argued = await callerForSite(await callerOf(bearer), "acme", () => asClient(state.db));
    expect(argued.businessId).toBe(SITE_A);
    // The saved default is untouched by either.
    expect((await callerOf(bearer)).businessId).toBe(SITE_B);
  });
});

describe("whoami and list_businesses", () => {
  it("report the default and where it comes from", async () => {
    const { access_token } = await tokensFor({ site: "all" });
    const bearer = `Bearer ${access_token}`;
    expect(await run(await callerOf(bearer), "whoami", {})).toMatchObject({
      ok: true,
      output: { business: { id: SITE_A }, defaultSite: { id: SITE_A }, defaultSource: "oldest" },
    });
    await run(await callerOf(bearer), "set_default_site", { site: "bravo.test" });
    expect(await run(await callerOf(bearer), "whoami", {})).toMatchObject({
      ok: true,
      output: { business: { id: SITE_B }, defaultSite: { id: SITE_B, name: "Bravo" }, defaultSource: "saved" },
    });
    expect(await run(await callerOf(bearer), "list_businesses", {})).toMatchObject({
      ok: true,
      output: { selectedId: SITE_B, defaultId: SITE_B, defaultSource: "saved" },
    });
  });
});

describe("set_default_site with an API key", () => {
  it("saves it on the key, and the key's calls that name no site act on it", async () => {
    const { key } = await keyFor(null);
    const bearer = `Bearer ${key}`;
    expect((await callerOf(bearer, {}, {})).businessId).toBe(SITE_A);
    expect(await run(await callerOf(bearer, {}, {}), "set_default_site", { site: "Bravo" })).toMatchObject({
      ok: true,
      output: { defaultSite: { id: SITE_B }, defaultSource: "saved" },
    });
    expect(state.db.tables.api_keys[0].default_business_id).toBe(SITE_B);
    expect(await callerOf(bearer, {}, {})).toMatchObject({ businessId: SITE_B, defaultSite: { source: "saved" } });
  });

  it("keeps a one-site key on its site", async () => {
    const { key } = await keyFor(SITE_A);
    expect(await run(await callerOf(`Bearer ${key}`, {}, {}), "set_default_site", { site: "Bravo" })).toMatchObject({
      ok: false,
      status: 403,
      error: { code: "forbidden_business", message: expect.stringContaining("This key is limited") },
    });
  });
});

describe("set_default_site in a browser session", () => {
  it("is refused: the site picker is a session's default", async () => {
    state.sessionUser = { id: USER };
    const resolved = await resolveCaller(new Request("https://gettrafficfa.st/api/v1/tools/set_default_site", { method: "POST" }));
    if (!resolved.ok) throw new Error("no session");
    expect(resolved.caller.defaultSite).toEqual({ businessId: SITE_A, source: "selected" });
    expect(await run(resolved.caller, "set_default_site", { site: "Bravo" })).toMatchObject({
      ok: false,
      status: 409,
      error: { code: "invalid_state", message: expect.stringContaining("site picker") },
    });
  });
});

describe("chooseBusiness with a saved default", () => {
  const owned = [{ id: SITE_A }, { id: SITE_B }];
  it("uses it when the request names none and it is still owned; else the oldest", () => {
    expect(chooseBusiness(owned, { savedDefault: SITE_B })).toMatchObject({
      businessId: SITE_B,
      defaultSite: { businessId: SITE_B, source: "saved" },
    });
    expect(chooseBusiness(owned, { savedDefault: SITE_C })).toMatchObject({
      businessId: SITE_A,
      defaultSite: { businessId: SITE_A, source: "oldest" },
    });
    expect(chooseBusiness(owned, {})).toMatchObject({ businessId: SITE_A, defaultSite: { source: "oldest" } });
  });

  it("lets the header win, and a key's one site win over anything saved", () => {
    expect(chooseBusiness(owned, { savedDefault: SITE_B, requested: SITE_A })).toMatchObject({
      businessId: SITE_A,
      defaultSite: { businessId: SITE_B, source: "saved" },
    });
    expect(chooseBusiness(owned, { keyBusinessId: SITE_A, savedDefault: SITE_B })).toMatchObject({
      businessId: SITE_A,
      defaultSite: { businessId: SITE_A, source: "only_site" },
    });
  });

  it("never applies a saved default to a browser session", () => {
    expect(chooseBusiness(owned, { savedDefault: SITE_B, allowFallback: true, preferred: null })).toMatchObject({
      businessId: SITE_A,
      defaultSite: { source: "selected" },
    });
  });
});

describe("Settings → Claude and API saves through the same function", () => {
  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  const patch = (body: unknown) =>
    new Request("https://gettrafficfa.st/api", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }) as unknown as Parameters<typeof patchKey>[0];

  it("changes a key's default, and refuses a site that is not the person's", async () => {
    state.sessionUser = { id: USER };
    const { apiKey } = await keyFor(null);
    // The routes take a uuid, as the database issues them.
    apiKey.id = state.db.tables.api_keys[0].id = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const saved = await patchKey(patch({ defaultSite: SITE_B }), params(apiKey.id));
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ defaultSite: { id: SITE_B }, defaultSource: "saved" });
    expect(state.db.tables.api_keys[0].default_business_id).toBe(SITE_B);

    const refused = await patchKey(patch({ defaultSite: SITE_C }), params(apiKey.id));
    expect(refused.status).toBe(404);
    expect(state.db.tables.api_keys[0].default_business_id).toBe(SITE_B);

    expect((await patchKey(patch({ defaultSite: null }), params(apiKey.id))).status).toBe(200);
    expect(state.db.tables.api_keys[0].default_business_id).toBeNull();
  });

  it("changes a connected app's default; another person's app is not found", async () => {
    await tokensFor({ site: "all" });
    const familyId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    state.db.tables.oauth_tokens[0].family_id = familyId;
    state.sessionUser = { id: "33333333-3333-4333-8333-333333333333" };
    expect((await patchApp(patch({ defaultSite: SITE_B }), params(familyId))).status).toBe(404);
    state.sessionUser = { id: USER };
    const saved = await patchApp(patch({ defaultSite: SITE_B }), params(familyId));
    expect(saved.status).toBe(200);
    expect(state.db.tables.oauth_tokens[0].default_business_id).toBe(SITE_B);
  });

  it("needs a session", async () => {
    const { apiKey } = await keyFor(null);
    expect((await patchKey(patch({ defaultSite: SITE_B }), params(apiKey.id))).status).toBe(401);
  });
});
