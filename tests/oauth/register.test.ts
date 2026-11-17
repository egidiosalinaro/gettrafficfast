import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeSupabase } from "../support/fake-supabase";
import { CLAUDE_CALLBACK, seedDb } from "./support";

/**
 * Dynamic client registration (RFC 7591) and the redirect URI rule. What is
 * pinned: https, or http on a loopback address and nothing else (MCP
 * authorization: "All redirect URIs MUST be either localhost or use HTTPS");
 * no fragment, no user name, no custom scheme; no implicit flow; a public
 * client gets no secret, a confidential one gets it once and the table
 * keeps its hash; matching is exact except for a loopback URI's port
 * (RFC 8252 §7.3, Claude Code); one address is rate-limited.
 */

const state = vi.hoisted(() => ({ db: null as unknown as FakeSupabase }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db }));

import { POST as registerRoute } from "@/app/oauth/register/route";
import { checkRegistration, redirectUriMatches, redirectUriProblem } from "@/lib/oauth/clients";
import { REGISTRATIONS_PER_IP_PER_HOUR } from "@/lib/oauth/config";
import { sha256Hex } from "@/lib/oauth/crypto";

beforeEach(() => {
  state.db = seedDb();
});

function post(body: unknown, headers: Record<string, string> = {}) {
  return registerRoute(
    new Request("https://gettrafficfa.st/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": "160.79.104.10", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    })
  );
}

describe("redirect URIs", () => {
  it("accepts https and loopback http only", () => {
    for (const ok of [
      CLAUDE_CALLBACK,
      "https://claude.com/api/mcp/auth_callback",
      "https://example.com:8443/cb?x=1",
      "http://localhost:3118/callback",
      "http://localhost/callback",
      "http://127.0.0.1:53682/callback",
      "http://[::1]:8080/cb",
    ]) {
      expect(redirectUriProblem(ok), ok).toBeNull();
    }
    for (const bad of [
      "http://example.com/callback",
      "http://localhost.evil.com/callback",
      "http://127.0.0.1.nip.io/callback",
      "https://claude.ai/cb#fragment",
      "https://user:pass@claude.ai/cb",
      "com.example.app:/callback",
      "javascript:alert(1)",
      "/relative/callback",
      "",
    ]) {
      expect(redirectUriProblem(bad), bad).not.toBeNull();
    }
  });

  it("matches exactly, ignoring only a loopback URI's port", () => {
    expect(redirectUriMatches([CLAUDE_CALLBACK], CLAUDE_CALLBACK)).toBe(true);
    expect(redirectUriMatches([CLAUDE_CALLBACK], `${CLAUDE_CALLBACK}/`)).toBe(false);
    expect(redirectUriMatches([CLAUDE_CALLBACK], "https://claude.ai/api/mcp/auth_callback?x=1")).toBe(false);
    expect(redirectUriMatches([CLAUDE_CALLBACK], "https://claude.ai:444/api/mcp/auth_callback")).toBe(false);
    expect(redirectUriMatches(["https://a.test:8443/cb"], "https://a.test:9443/cb")).toBe(false);

    expect(redirectUriMatches(["http://localhost/callback"], "http://localhost:3118/callback")).toBe(true);
    expect(redirectUriMatches(["http://127.0.0.1/callback"], "http://127.0.0.1:53682/callback")).toBe(true);
    expect(redirectUriMatches(["http://localhost:1/callback"], "http://localhost:2/callback")).toBe(true);
    expect(redirectUriMatches(["http://localhost/callback"], "http://localhost:3118/other")).toBe(false);
    expect(redirectUriMatches(["http://localhost/callback"], "http://127.0.0.1:3118/callback")).toBe(false);
  });
});

describe("checkRegistration", () => {
  it("refuses what this server does not do", () => {
    expect(checkRegistration({})).toMatchObject({ ok: false, error: "invalid_redirect_uri" });
    expect(checkRegistration({ redirect_uris: ["http://example.com/cb"] })).toMatchObject({ ok: false, error: "invalid_redirect_uri" });
    expect(checkRegistration({ redirect_uris: Array.from({ length: 11 }, (_, i) => `https://a.test/${i}`) })).toMatchObject({
      ok: false,
      error: "invalid_redirect_uri",
    });
    expect(checkRegistration({ redirect_uris: [CLAUDE_CALLBACK], response_types: ["token"] })).toMatchObject({
      ok: false,
      error: "invalid_client_metadata",
    });
    expect(checkRegistration({ redirect_uris: [CLAUDE_CALLBACK], grant_types: ["client_credentials"] })).toMatchObject({
      ok: false,
    });
    expect(checkRegistration({ redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: "private_key_jwt" })).toMatchObject({
      ok: false,
    });
    expect(checkRegistration([CLAUDE_CALLBACK])).toMatchObject({ ok: false });
  });

  it("defaults to a public client and cleans the name a person will read", () => {
    expect(checkRegistration({ redirect_uris: [CLAUDE_CALLBACK], client_name: "  Claude\n\u0007 " })).toEqual({
      ok: true,
      registration: { clientName: "Claude", redirectUris: [CLAUDE_CALLBACK], authMethod: "none" },
    });
    expect(checkRegistration({ redirect_uris: [CLAUDE_CALLBACK] })).toMatchObject({
      ok: true,
      registration: { clientName: "An app with no name" },
    });
  });
});

describe("POST /oauth/register", () => {
  it("registers a public client: 201, a client id, no secret", async () => {
    const response = await post({ client_name: "Claude", redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: "none" });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toMatchObject({
      client_name: "Claude",
      redirect_uris: [CLAUDE_CALLBACK],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
    expect(body.client_id).toMatch(/^gtfci_[A-Za-z0-9_-]{22}$/);
    expect(body).not.toHaveProperty("client_secret");
    const [row] = state.db.tables.oauth_clients;
    expect(row).toMatchObject({ client_id: body.client_id, client_secret_hash: null, token_endpoint_auth_method: "none" });
    // The address is kept as a hash, for the rate limit only.
    expect(row.registered_from).toBe(sha256Hex("oauth-registration:160.79.104.10"));
  });

  it("gives a confidential client its secret once and keeps only the hash", async () => {
    const response = await post({ redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: "client_secret_post" });
    const body = await response.json();
    expect(body.client_secret).toMatch(/^gtfcs_[A-Za-z0-9_-]{43}$/);
    expect(body.client_secret_expires_at).toBe(0);
    const [row] = state.db.tables.oauth_clients;
    expect(row.client_secret_hash).toBe(sha256Hex(body.client_secret));
    expect(JSON.stringify(state.db.tables.oauth_clients)).not.toContain(body.client_secret);
  });

  it("refuses a non-https redirect, a body that is not JSON, and too many registrations from one address", async () => {
    const insecure = await post({ redirect_uris: ["http://example.com/callback"] });
    expect(insecure.status).toBe(400);
    expect(await insecure.json()).toMatchObject({ error: "invalid_redirect_uri" });

    const notJson = await post("redirect_uris=x");
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toMatchObject({ error: "invalid_client_metadata" });

    const recent = new Date().toISOString();
    state.db.tables.oauth_clients.push(
      ...Array.from({ length: REGISTRATIONS_PER_IP_PER_HOUR }, (_, i) => ({
        client_id: `gtfci_seeded${i}`,
        registered_from: sha256Hex("oauth-registration:203.0.113.9"),
        created_at: recent,
      }))
    );
    const limited = await post({ redirect_uris: [CLAUDE_CALLBACK] }, { "x-real-ip": "203.0.113.9" });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("3600");
    // Another address is not held back by it.
    expect((await post({ redirect_uris: [CLAUDE_CALLBACK] }, { "x-real-ip": "203.0.113.10" })).status).toBe(201);
  });
});
