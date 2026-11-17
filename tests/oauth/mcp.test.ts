import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeSupabase } from "../support/fake-supabase";
import { SITE_A, SITE_B, SITE_C, USER, asClient, codeForm, consent, register, seedDb } from "./support";

/**
 * An OAuth token at the MCP endpoint. What is pinned: `resolveCaller` turns
 * a token into the same caller a key gives (the grant's owner, its site or
 * every site, its scopes, the owner-scoped service role, no key id, the
 * app); the REST runner does not take one; a key still works at MCP; the
 * MCP endpoint answers 401 with `WWW-Authenticate: Bearer
 * resource_metadata=…` without a credential or with a bad one; a call
 * through OAuth is audited with the app and held to the per-key limits,
 * counted per app; a scope that was not granted is refused with a hint to
 * reconnect; the account's own limits (the daily AI spend ceiling, the
 * per-account caps) hold an OAuth caller exactly as they hold a key, and
 * its calls count toward them.
 */

const state = vi.hoisted(() => ({ db: null as unknown as FakeSupabase }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
}));
vi.mock("@/lib/subscription", () => ({ hasActiveSubscription: async () => true }));

import { z } from "zod";
import { POST as mcpPost } from "@/app/api/mcp/route";
import { createRegistry } from "@/lib/tools/registry";
import { defineTool } from "@/lib/tools/tool";
import { resolveCaller } from "@/lib/api-auth";
import { createApiKey } from "@/lib/api-keys";
import { findClient } from "@/lib/oauth/clients";
import { MCP_RESOURCE } from "@/lib/oauth/config";
import { exchangeAuthorizationCode } from "@/lib/oauth/tokens";
import { runTool } from "@/lib/tools/runner";
import { TOOL_LIMITS } from "@/lib/tools/usage";

let clientId: string;
beforeEach(async () => {
  state.db = seedDb();
  clientId = (await register(state.db)).clientId;
});

async function accessToken(choice: { grant?: string[]; site?: string } = {}): Promise<string> {
  const code = await consent(state.db, clientId, choice, new Date());
  const client = await findClient(asClient(state.db), clientId);
  if (!client) throw new Error("no client");
  const result = await exchangeAuthorizationCode(asClient(state.db), client, codeForm(clientId, code));
  if (!result.ok) throw new Error(result.description);
  return result.body.access_token;
}

const mcpRequest = (headers: Record<string, string> = {}, body: unknown = { jsonrpc: "2.0", id: 1, method: "tools/list" }) =>
  new Request("https://gettrafficfa.st/api/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });

const atMcp = { allowSession: false, oauthResource: MCP_RESOURCE };

describe("resolveCaller with an OAuth access token", () => {
  it("acts for the grant's owner, on the granted site, with the granted scopes", async () => {
    const token = await accessToken({ grant: ["read", "write", "spend"], site: SITE_B });
    const resolved = await resolveCaller(mcpRequest({ authorization: `Bearer ${token}` }), atMcp);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.caller).toMatchObject({
      via: "oauth",
      userId: USER,
      businessId: SITE_B,
      businessIds: [SITE_B],
      scopes: ["read", "write", "spend"],
      keyId: null,
      oauth: { clientId, siteLimited: true },
    });
    // The service role, narrowed to the owner: another account's rows are not there.
    const { data } = await resolved.caller.client.from("placement_targets").select("id");
    expect((data as Array<{ id: string }>).map((r) => r.id)).toEqual(["t-a", "t-b"]);
    expect(() => resolved.caller.client.from("oauth_tokens")).toThrow(/not reachable/);
  });

  it("takes the oldest site for a grant on every site, and the header's site when it is the owner's", async () => {
    const token = await accessToken({ site: "all" });
    const oldest = await resolveCaller(mcpRequest({ authorization: `Bearer ${token}` }), atMcp);
    expect(oldest.ok && oldest.caller).toMatchObject({ businessId: SITE_A, businessIds: [SITE_A, SITE_B], oauth: { siteLimited: false } });
    const named = await resolveCaller(mcpRequest({ authorization: `Bearer ${token}`, "x-gtf-business": SITE_B }), atMcp);
    expect(named.ok && named.caller.businessId).toBe(SITE_B);
    expect(await resolveCaller(mcpRequest({ authorization: `Bearer ${token}`, "x-gtf-business": SITE_C }), atMcp)).toMatchObject({
      ok: false,
      status: 404,
    });
  });

  it("refuses another site with a grant for one site", async () => {
    const token = await accessToken({ site: SITE_A });
    expect(await resolveCaller(mcpRequest({ authorization: `Bearer ${token}`, "x-gtf-business": SITE_B }), atMcp)).toMatchObject({
      ok: false,
      status: 403,
      error: { code: "forbidden_business" },
    });
  });

  it("is refused where OAuth tokens are not accepted (the REST runner)", async () => {
    const token = await accessToken();
    expect(await resolveCaller(mcpRequest({ authorization: `Bearer ${token}` }))).toMatchObject({
      ok: false,
      status: 401,
      error: { code: "invalid_token" },
    });
  });

  it("refuses an unknown, malformed or revoked token, and still takes an API key", async () => {
    expect(await resolveCaller(mcpRequest({ authorization: "Bearer gtfat_unknown" }), atMcp)).toMatchObject({
      ok: false,
      status: 401,
      error: { code: "invalid_token" },
    });
    expect(await resolveCaller(mcpRequest({ authorization: "Bearer something-else" }), atMcp)).toMatchObject({
      error: { code: "invalid_token" },
    });

    const token = await accessToken();
    for (const row of state.db.tables.oauth_tokens) row.revoked_at = new Date().toISOString();
    expect(await resolveCaller(mcpRequest({ authorization: `Bearer ${token}` }), atMcp)).toMatchObject({
      ok: false,
      error: { code: "invalid_token" },
    });

    state.db.tables.api_keys = [];
    const key = await createApiKey(asClient(state.db), { userId: USER, name: "k", businessId: SITE_A });
    if (!key.ok) throw new Error(key.error);
    const viaKey = await resolveCaller(mcpRequest({ authorization: `Bearer ${key.key}` }), atMcp);
    expect(viaKey.ok && viaKey.caller).toMatchObject({ via: "api_key", businessId: SITE_A });
  });
});

describe("POST /api/mcp", () => {
  it("answers 401 with resource_metadata without a credential, and adds invalid_token for a bad one", async () => {
    const anonymous = await mcpPost(mcpRequest());
    expect(anonymous.status).toBe(401);
    const challenge = anonymous.headers.get("www-authenticate") ?? "";
    expect(challenge).toMatch(/^Bearer /);
    expect(challenge).toContain('resource_metadata="https://gettrafficfa.st/.well-known/oauth-protected-resource/api/mcp"');
    expect(challenge).not.toContain("error=");

    const bad = await mcpPost(mcpRequest({ authorization: "Bearer gtfat_expired-or-unknown" }));
    expect(bad.status).toBe(401);
    expect(bad.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect(bad.headers.get("www-authenticate")).toContain("resource_metadata=");
    expect(await bad.json()).toMatchObject({ error: { code: "invalid_token" } });
  });

  it("serves the tools the grant allows, and audits the call with the app", async () => {
    const token = await accessToken({ grant: ["read", "write"], site: SITE_A });
    const listed = await mcpPost(mcpRequest({ authorization: `Bearer ${token}` }));
    expect(listed.status).toBe(200);
    const names = ((await listed.json()) as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);
    expect(names).toContain("whoami");
    expect(names).not.toContain("draft_reply");
    expect(names).not.toContain("publish_article");

    const called = await mcpPost(
      mcpRequest({ authorization: `Bearer ${token}` }, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "whoami", arguments: {} } })
    );
    expect(await called.json()).toMatchObject({
      result: { structuredContent: { via: "oauth", userId: USER, keyId: null, oauthClientId: clientId, scopes: ["read", "write"] } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.db.tables.tool_calls.at(-1)).toMatchObject({ tool: "whoami", status: "ok", api_key_id: null, oauth_client_id: clientId });
  });
});

describe("the runner for an OAuth caller", () => {
  async function caller(grant: string[] = ["read", "write"]) {
    const token = await accessToken({ grant, site: SITE_A });
    const resolved = await resolveCaller(mcpRequest({ authorization: `Bearer ${token}` }), atMcp);
    if (!resolved.ok) throw new Error("not resolved");
    return resolved.caller;
  }

  it("refuses a scope the person did not grant, with a hint to reconnect", async () => {
    const run = await runTool(await caller(), "draft_reply", { targetId: "t-a" }, { admin: () => asClient(state.db) });
    expect(run).toMatchObject({ ok: false, status: 403, error: { code: "forbidden_scope" } });
    if (run.ok) return;
    expect(run.error.message).toContain("this connection was not granted");
    expect(run.error.hint).toContain("connect again");
  });

  it("does not let a grant for one site add another site", async () => {
    const run = await runTool(await caller(), "create_business", { name: "New", websiteUrl: "https://new.test" }, { admin: () => asClient(state.db) });
    expect(run).toMatchObject({ ok: false, status: 403, error: { code: "forbidden_business" } });
    expect(state.db.tables.businesses).toHaveLength(3);
  });

  it("holds an app to the burst limit, counted per app for this account", async () => {
    const oauthCaller = await caller();
    const now = new Date();
    state.db.tables.tool_calls.push(
      ...Array.from({ length: TOOL_LIMITS.perMinute }, (_, i) => ({
        id: `call-${i}`,
        user_id: USER,
        oauth_client_id: clientId,
        api_key_id: null,
        tool: "whoami",
        status: "ok",
        created_at: new Date(now.getTime() - 1000).toISOString(),
      }))
    );
    const run = await runTool(oauthCaller, "whoami", {}, { admin: () => asClient(state.db), now: () => now });
    expect(run).toMatchObject({ ok: false, status: 429, error: { code: "rate_limited" } });
    if (!run.ok) expect(run.error.message).toContain("This connected app made 60 calls");

    // Another account's calls through the same app are not this account's.
    for (const row of state.db.tables.tool_calls) row.user_id = "someone-else";
    expect((await runTool(oauthCaller, "whoami", {}, { admin: () => asClient(state.db), now: () => now })).ok).toBe(true);
  });
});

describe("the account's limits for an OAuth caller", () => {
  const HOUR = 60 * 60 * 1000;
  const registry = createRegistry([
    defineTool({
      name: "suggest_keywords",
      title: "suggest_keywords",
      description: "Pretends to be suggest_keywords, for tests of the account's limits.",
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      scope: "write",
      paid: true,
      handler: async () => ({ ok: true }),
    }),
  ]);

  async function spender() {
    const token = await accessToken({ grant: ["read", "write", "spend"], site: SITE_A });
    const resolved = await resolveCaller(mcpRequest({ authorization: `Bearer ${token}` }), atMcp);
    if (!resolved.ok) throw new Error("not resolved");
    return resolved.caller;
  }

  it("refuses a paid tool at the daily AI spend ceiling, as for a key", async () => {
    const oauthCaller = await spender();
    const now = new Date();
    const deps = { registry, admin: () => asClient(state.db), now: () => now };
    expect(await runTool(oauthCaller, "suggest_keywords", {}, deps)).toMatchObject({ ok: true });

    state.db.tables.agent_runs.push({
      user_id: USER,
      agent: "writing",
      model: "claude-sonnet-5-5",
      cost_usd: 5,
      created_at: new Date(now.getTime() - 2 * HOUR).toISOString(),
    });
    expect(await runTool(oauthCaller, "suggest_keywords", {}, deps)).toMatchObject({
      ok: false,
      status: 429,
      error: { code: "spend_cap_reached" },
    });
  });

  it("counts the app's calls in the account's daily cap, with the keys' and the screens'", async () => {
    const oauthCaller = await spender();
    const now = new Date();
    const row = (over: Record<string, unknown>) => ({
      user_id: USER,
      business_id: SITE_A,
      tool: "suggest_keywords",
      status: "ok",
      created_at: new Date(now.getTime() - 2 * HOUR).toISOString(),
      ...over,
    });
    // Under the app's own cap of 30 (10 of its calls), but the account has made 30.
    state.db.tables.tool_calls.push(
      ...Array.from({ length: 10 }, () => row({ oauth_client_id: clientId, api_key_id: null })),
      ...Array.from({ length: 15 }, () => row({ api_key_id: "key-1" })),
      ...Array.from({ length: 5 }, () => row({ api_key_id: null }))
    );
    expect(await runTool(oauthCaller, "suggest_keywords", {}, { registry, admin: () => asClient(state.db), now: () => now })).toMatchObject({
      ok: false,
      status: 429,
      error: { code: "cap_reached" },
    });
  });
});
