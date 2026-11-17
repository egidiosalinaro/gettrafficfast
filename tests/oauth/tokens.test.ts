import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeSupabase } from "../support/fake-supabase";
import { SITE_A, T0, USER, asClient, codeForm, consent, register, seedDb } from "./support";

/**
 * The token endpoint and what it issues. What is pinned: a code is
 * exchanged only with the verifier that hashes to its challenge, by its own
 * client, with its own redirect URI, before it expires, and once; a code
 * used twice revokes what it produced; refresh tokens rotate, and a spent
 * one presented again revokes the whole connection; a revoked, expired or
 * foreign-audience token is refused; a confidential client must show its
 * secret; nothing is stored but hashes.
 */

const state = vi.hoisted(() => ({ db: null as unknown as FakeSupabase }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db }));

import { POST as tokenRoute } from "@/app/oauth/token/route";
import { POST as revokeRoute } from "@/app/oauth/revoke/route";
import { findClient } from "@/lib/oauth/clients";
import { MCP_RESOURCE } from "@/lib/oauth/config";
import { sha256Hex } from "@/lib/oauth/crypto";
import {
  exchangeAuthorizationCode,
  listConnectedApps,
  refreshAccessToken,
  revokeConnectedApp,
  verifyAccessToken,
  type TokenResponse,
} from "@/lib/oauth/tokens";

const MINUTE = 60_000;
const at = (ms: number) => new Date(T0.getTime() + ms);

let clientId: string;
beforeEach(async () => {
  state.db = seedDb();
  clientId = (await register(state.db)).clientId;
});

async function client(id = clientId) {
  const found = await findClient(asClient(state.db), id);
  if (!found) throw new Error("no client");
  return found;
}

async function exchange(code: string, over: Record<string, string | null> = {}, now = at(MINUTE)) {
  return exchangeAuthorizationCode(asClient(state.db), await client(), codeForm(clientId, code, over), now);
}

async function tokens(choice: { grant?: string[]; site?: string } = {}): Promise<TokenResponse> {
  const result = await exchange(await consent(state.db, clientId, choice));
  if (!result.ok) throw new Error(result.description);
  return result.body;
}

async function refresh(refreshToken: string, now = at(30 * MINUTE), over: Record<string, string> = {}) {
  const params = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, ...over });
  return refreshAccessToken(asClient(state.db), await client(), params, now);
}

const verify = (token: string, now = at(2 * MINUTE), resource = MCP_RESOURCE) =>
  verifyAccessToken(token, { admin: asClient(state.db), resource, now });

describe("the authorization code exchange", () => {
  it("issues a Bearer pair for the right verifier, and stores only their hashes", async () => {
    const body = await tokens({ grant: ["read", "write"], site: SITE_A });
    expect(body).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "read write" });
    expect(body.access_token).toMatch(/^gtfat_[A-Za-z0-9_-]{43}$/);
    expect(body.refresh_token).toMatch(/^gtfrt_[A-Za-z0-9_-]{43}$/);

    const [row] = state.db.tables.oauth_tokens;
    expect(row).toMatchObject({
      client_id: clientId,
      user_id: USER,
      business_id: SITE_A,
      scopes: ["read", "write"],
      resource: MCP_RESOURCE,
      access_token_hash: sha256Hex(body.access_token),
      refresh_token_hash: sha256Hex(body.refresh_token),
      family_id: state.db.tables.oauth_authorization_codes[0].id,
    });
    expect(Date.parse(row.access_expires_at as string) - at(MINUTE).getTime()).toBe(60 * MINUTE);
    expect(Date.parse(row.refresh_expires_at as string) - at(MINUTE).getTime()).toBe(30 * 24 * 60 * MINUTE);
    const stored = JSON.stringify(state.db.tables);
    expect(stored).not.toContain(body.access_token);
    expect(stored).not.toContain(body.refresh_token);
    expect(state.db.tables.oauth_clients[0].last_used_at).toBe(at(MINUTE).toISOString());
  });

  it("refuses a wrong verifier, and the code still works with the right one", async () => {
    const code = await consent(state.db, clientId);
    const wrong = await exchange(code, { code_verifier: "x".repeat(43) });
    expect(wrong).toMatchObject({ ok: false, error: "invalid_grant" });
    expect(await exchange(code, { code_verifier: null })).toMatchObject({ ok: false, error: "invalid_grant" });
    expect(state.db.tables.oauth_tokens).toHaveLength(0);
    expect(await exchange(code)).toMatchObject({ ok: true });
  });

  it("is single-use: a second exchange fails and revokes what the first one issued", async () => {
    const code = await consent(state.db, clientId);
    const first = await exchange(code);
    if (!first.ok) throw new Error(first.description);
    expect((await verify(first.body.access_token)).ok).toBe(true);

    expect(await exchange(code)).toMatchObject({ ok: false, error: "invalid_grant" });
    expect(await verify(first.body.access_token)).toEqual({ ok: false, reason: "revoked" });
    expect(await refresh(first.body.refresh_token)).toMatchObject({ ok: false, error: "invalid_grant" });
  });

  it("expires", async () => {
    const code = await consent(state.db, clientId);
    expect(await exchange(code, {}, at(5 * MINUTE + 1))).toMatchObject({ ok: false, error: "invalid_grant" });
  });

  it("needs the same redirect URI, the same client and the same resource", async () => {
    const code = await consent(state.db, clientId);
    expect(await exchange(code, { redirect_uri: "https://claude.ai/other" })).toMatchObject({ ok: false, error: "invalid_grant" });
    expect(await exchange(code, { redirect_uri: null })).toMatchObject({ ok: false, error: "invalid_grant" });
    expect(await exchange(code, { resource: "https://other.test/mcp" })).toMatchObject({ ok: false, error: "invalid_target" });

    const other = await register(state.db, { client_name: "Other" });
    const foreign = await exchangeAuthorizationCode(asClient(state.db), await client(other.clientId), codeForm(other.clientId, code), at(MINUTE));
    expect(foreign).toMatchObject({ ok: false, error: "invalid_grant" });
    expect(await exchange("gtfco_not-a-real-code-but-the-right-length-xxxxx")).toMatchObject({ ok: false, error: "invalid_grant" });
    expect(await exchange(code)).toMatchObject({ ok: true });
  });
});

describe("refresh", () => {
  it("rotates: a new pair, the same grant, the old access token alive until it expires", async () => {
    const first = await tokens({ grant: ["read", "write", "spend"] });
    const second = await refresh(first.refresh_token);
    if (!second.ok) throw new Error(second.description);
    expect(second.body.refresh_token).not.toBe(first.refresh_token);
    expect(second.body.access_token).not.toBe(first.access_token);
    expect(second.body.scope).toBe("read write spend");

    const [old, current] = state.db.tables.oauth_tokens;
    expect(old.rotated_at).toBe(at(30 * MINUTE).toISOString());
    expect(current).toMatchObject({ family_id: old.family_id, granted_at: old.granted_at });
    expect(current.rotated_at ?? null).toBeNull();
    expect((await verify(second.body.access_token, at(31 * MINUTE))).ok).toBe(true);
    expect((await verify(first.access_token, at(31 * MINUTE))).ok).toBe(true);
    expect(await verify(first.access_token, at(61 * MINUTE + 1))).toEqual({ ok: false, reason: "expired" });
  });

  it("detects reuse: a spent refresh token revokes the whole connection", async () => {
    const first = await tokens();
    const second = await refresh(first.refresh_token);
    if (!second.ok) throw new Error(second.description);

    const replay = await refresh(first.refresh_token, at(40 * MINUTE));
    expect(replay).toMatchObject({ ok: false, error: "invalid_grant" });
    expect(await verify(second.body.access_token, at(41 * MINUTE))).toEqual({ ok: false, reason: "revoked" });
    expect(await refresh(second.body.refresh_token, at(42 * MINUTE))).toMatchObject({ ok: false, error: "invalid_grant" });
    expect(state.db.tables.oauth_tokens.every((row) => row.revoked_at)).toBe(true);
  });

  it("may narrow the scopes, never widen them", async () => {
    const first = await tokens({ grant: ["read", "write"] });
    expect(await refresh(first.refresh_token, at(10 * MINUTE), { scope: "read spend" })).toMatchObject({
      ok: false,
      error: "invalid_scope",
    });
    const narrowed = await refresh(first.refresh_token, at(11 * MINUTE), { scope: "read" });
    expect(narrowed).toMatchObject({ ok: true, body: { scope: "read" } });
  });

  it("refuses an expired, unknown or another client's refresh token", async () => {
    const first = await tokens();
    expect(await refresh(first.refresh_token, at(31 * 24 * 60 * MINUTE))).toMatchObject({ ok: false, error: "invalid_grant" });
    expect(await refresh("gtfrt_unknown")).toMatchObject({ ok: false, error: "invalid_grant" });
    const other = await register(state.db, { client_name: "Other" });
    const params = new URLSearchParams({ grant_type: "refresh_token", refresh_token: first.refresh_token });
    expect(await refreshAccessToken(asClient(state.db), await client(other.clientId), params, at(MINUTE))).toMatchObject({
      ok: false,
      error: "invalid_grant",
    });
  });
});

describe("access tokens", () => {
  it("are refused once revoked, and the refresh token with them", async () => {
    const body = await tokens();
    const familyId = state.db.tables.oauth_tokens[0].family_id as string;
    expect(await revokeConnectedApp(asClient(state.db), "someone-else", familyId)).toMatchObject({ ok: false, status: 404 });
    expect((await verify(body.access_token)).ok).toBe(true);

    expect(await revokeConnectedApp(asClient(state.db), USER, familyId, at(3 * MINUTE))).toEqual({ ok: true });
    expect(await verify(body.access_token, at(4 * MINUTE))).toEqual({ ok: false, reason: "revoked" });
    expect(await refresh(body.refresh_token)).toMatchObject({ ok: false, error: "invalid_grant" });
  });

  it("are valid only for the resource they were issued for", async () => {
    const body = await tokens();
    expect(await verify(body.access_token, at(2 * MINUTE), "https://gettrafficfa.st/api/other")).toEqual({
      ok: false,
      reason: "wrong_resource",
    });
    expect(await verify(body.refresh_token)).toEqual({ ok: false, reason: "malformed" });
    expect(await verify("gtf_an-api-key")).toEqual({ ok: false, reason: "malformed" });
  });

  it("write last used at most once a minute", async () => {
    const body = await tokens();
    await verify(body.access_token, at(2 * MINUTE));
    await verify(body.access_token, at(2 * MINUTE + 30_000));
    expect(state.db.tables.oauth_tokens[0].last_used_at).toBe(at(2 * MINUTE).toISOString());
    await verify(body.access_token, at(3 * MINUTE));
    expect(state.db.tables.oauth_tokens[0].last_used_at).toBe(at(3 * MINUTE).toISOString());
  });
});

describe("connected apps", () => {
  it("lists each live grant once, with the app, its scopes and site, and drops a revoked one", async () => {
    await tokens({ grant: ["read", "write", "spend"], site: SITE_A });
    const familyId = state.db.tables.oauth_tokens[0].family_id as string;
    const second = await tokens({ site: "all" });
    // A rotation leaves two rows in that family; the list shows the grant once.
    expect((await refresh(second.refresh_token)).ok).toBe(true);
    expect(state.db.tables.oauth_tokens).toHaveLength(3);

    const apps = await listConnectedApps(asClient(state.db), asClient(state.db), USER, at(31 * MINUTE));
    expect(apps).toHaveLength(2);
    expect(apps.map((app) => app.businessId).sort()).toEqual([SITE_A, null].sort());
    expect(apps[0]).toMatchObject({ clientName: "Claude", redirectHost: "claude.ai" });
    expect(apps.find((app) => app.businessId === SITE_A)?.scopes).toEqual(["read", "write", "spend"]);

    await revokeConnectedApp(asClient(state.db), USER, familyId);
    expect(await listConnectedApps(asClient(state.db), asClient(state.db), USER, at(31 * MINUTE))).toHaveLength(1);
  });
});

describe("POST /oauth/token", () => {
  function post(form: URLSearchParams, headers: Record<string, string> = {}) {
    return tokenRoute(
      new Request("https://gettrafficfa.st/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
        body: form.toString(),
      })
    );
  }

  it("exchanges a code form-encoded, uncached, and refreshes", async () => {
    const code = await consent(state.db, clientId, {}, new Date());
    const response = await post(codeForm(clientId, code));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as TokenResponse;
    expect(body.token_type).toBe("Bearer");

    const refreshed = await post(new URLSearchParams({ grant_type: "refresh_token", refresh_token: body.refresh_token, client_id: clientId }));
    expect(refreshed.status).toBe(200);
    const replay = await post(new URLSearchParams({ grant_type: "refresh_token", refresh_token: body.refresh_token, client_id: clientId }));
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("refuses an unknown grant type, an unknown client, and a parameter sent twice", async () => {
    expect(await (await post(new URLSearchParams({ grant_type: "client_credentials", client_id: clientId }))).json()).toMatchObject({
      error: "unsupported_grant_type",
    });
    const unknown = await post(codeForm("gtfci_AAAAAAAAAAAAAAAAAAAAAA", "gtfco_x"));
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toMatchObject({ error: "invalid_client" });
    const twice = codeForm(clientId, "gtfco_x");
    twice.append("code", "gtfco_y");
    expect(await (await post(twice)).json()).toMatchObject({ error: "invalid_request" });
  });

  it("makes a confidential client show its secret, in the body or with Basic", async () => {
    const confidential = await register(state.db, { token_endpoint_auth_method: "client_secret_post" });
    const secret = confidential.secret ?? "";
    const codeFor = () =>
      consent(state.db, confidential.clientId, {}, new Date());

    const withoutSecret = await post(codeForm(confidential.clientId, await codeFor()));
    expect(withoutSecret.status).toBe(401);
    const wrongSecret = await post(codeForm(confidential.clientId, await codeFor(), { client_secret: "gtfcs_wrong" }));
    expect(wrongSecret.status).toBe(401);

    const posted = await post(codeForm(confidential.clientId, await codeFor(), { client_secret: secret }));
    expect(posted.status).toBe(200);

    const basic = Buffer.from(`${confidential.clientId}:${secret}`).toString("base64");
    const viaBasic = await post(codeForm(confidential.clientId, await codeFor(), { client_id: null }), { authorization: `Basic ${basic}` });
    expect(viaBasic.status).toBe(200);
  });
});

describe("POST /oauth/revoke", () => {
  function post(form: Record<string, string>) {
    return revokeRoute(
      new Request("https://gettrafficfa.st/oauth/revoke", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(form).toString(),
      })
    );
  }

  it("ends the connection for its own client, and answers 200 whatever the token", async () => {
    const code = await consent(state.db, clientId, {}, new Date());
    const result = await exchangeAuthorizationCode(asClient(state.db), await client(), codeForm(clientId, code));
    if (!result.ok) throw new Error(result.description);

    const other = await register(state.db, { client_name: "Other" });
    expect((await post({ token: result.body.refresh_token, client_id: other.clientId })).status).toBe(200);
    expect((await verifyAccessToken(result.body.access_token, { admin: asClient(state.db), resource: MCP_RESOURCE })).ok).toBe(true);

    expect((await post({ token: result.body.refresh_token, client_id: clientId })).status).toBe(200);
    expect(await verifyAccessToken(result.body.access_token, { admin: asClient(state.db), resource: MCP_RESOURCE })).toEqual({
      ok: false,
      reason: "revoked",
    });
    expect((await post({ token: "gtfat_nothing", client_id: clientId })).status).toBe(200);
  });
});
