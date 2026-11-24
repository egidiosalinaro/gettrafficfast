import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  X_POSTING_SCOPES,
  XOAuthError,
  buildXAuthorizeUrl,
  createPkce,
  exchangeXCode,
  fetchXMe,
  isXPostingConfigured,
  pkceChallenge,
  refreshXTokens,
  revokeXToken,
} from "@/lib/providers/x/oauth";

/**
 * X's OAuth 2.0 with PKCE, as the provider speaks it: the challenge, the
 * consent address, the code and refresh exchanges (Basic auth, form body),
 * and the account read. No call reaches X: every fetch is a stub.
 */

const CLIENT = { clientId: "test-client-id", clientSecret: "test-client-secret" };
const NOW = new Date("2026-11-24T10:00:00Z");

function answer(status: number, body: unknown) {
  return vi.fn(async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));
}

describe("PKCE and the consent address", () => {
  it("derives the S256 challenge as RFC 7636 §4.2 does: BASE64URL(SHA256(verifier)), no padding", () => {
    const verifier = "a-fixed-verifier-for-tests-0123456789-abcdefgh";
    expect(pkceChallenge(verifier)).toBe(createHash("sha256").update(verifier, "ascii").digest("base64url"));
    expect(pkceChallenge(verifier)).not.toMatch(/[+/=]/);
  });

  it("makes a fresh verifier of RFC length each time, with its challenge", () => {
    const a = createPkce();
    const b = createPkce();
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).toBe(pkceChallenge(a.verifier));
  });

  it("asks X for read, write, the account and a refresh token, with the state and the S256 challenge", () => {
    const url = new URL(buildXAuthorizeUrl({ clientId: "cid", redirectUri: "https://app.example.test/api/integrations/x/callback", state: "st", challenge: "ch" }));
    expect(url.origin + url.pathname).toBe("https://x.com/i/oauth2/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "cid",
      redirect_uri: "https://app.example.test/api/integrations/x/callback",
      scope: "tweet.read tweet.write users.read offline.access",
      state: "st",
      code_challenge: "ch",
      code_challenge_method: "S256",
    });
    expect(X_POSTING_SCOPES).toContain("offline.access");
  });

  it("is offered only with both halves of the client", () => {
    expect(isXPostingConfigured({ X_OAUTH_CLIENT_ID: "a", X_OAUTH_CLIENT_SECRET: "b" })).toBe(true);
    expect(isXPostingConfigured({ X_OAUTH_CLIENT_ID: "a" })).toBe(false);
    expect(isXPostingConfigured({ X_OAUTH_CLIENT_SECRET: "b" })).toBe(false);
    expect(isXPostingConfigured({})).toBe(false);
  });
});

describe("the token exchanges", () => {
  it("trades the code with the verifier, as a confidential client (Basic auth, form body)", async () => {
    const fetchImpl = answer(200, { token_type: "bearer", expires_in: 7200, access_token: "at-1", refresh_token: "rt-1", scope: "tweet.read tweet.write users.read offline.access" });
    const tokens = await exchangeXCode(CLIENT, { code: "the-code", verifier: "v".repeat(43), redirectUri: "https://app.example.test/cb" }, { fetchImpl, now: NOW });
    expect(tokens).toEqual({
      accessToken: "at-1",
      refreshToken: "rt-1",
      expiresAt: new Date(NOW.getTime() + 7200 * 1000),
      scopes: ["tweet.read", "tweet.write", "users.read", "offline.access"],
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.x.com/2/oauth2/token");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from("test-client-id:test-client-secret").toString("base64")}`);
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(String(init.body));
    expect(Object.fromEntries(form)).toMatchObject({
      grant_type: "authorization_code",
      code: "the-code",
      code_verifier: "v".repeat(43),
      redirect_uri: "https://app.example.test/cb",
    });
  });

  it("reads a refused code as invalid_grant, a 429 as rate_limited", async () => {
    await expect(exchangeXCode(CLIENT, { code: "used", verifier: "v".repeat(43), redirectUri: "x" }, { fetchImpl: answer(400, { error: "invalid_request" }) })).rejects.toMatchObject({
      kind: "invalid_grant",
    });
    await expect(exchangeXCode(CLIENT, { code: "c", verifier: "v".repeat(43), redirectUri: "x" }, { fetchImpl: answer(429, "") })).rejects.toBeInstanceOf(XOAuthError);
  });

  it("refreshes, keeping the old refresh token only when X sends no new one", async () => {
    const rotated = await refreshXTokens(CLIENT, "rt-old", { fetchImpl: answer(200, { access_token: "at-2", refresh_token: "rt-new", expires_in: 7200 }), now: NOW });
    expect(rotated).toMatchObject({ accessToken: "at-2", refreshToken: "rt-new" });
    const kept = await refreshXTokens(CLIENT, "rt-old", { fetchImpl: answer(200, { access_token: "at-3", expires_in: 7200 }), now: NOW });
    expect(kept.refreshToken).toBe("rt-old");
  });

  it("revokes best effort: true on 2xx, false otherwise, never a throw", async () => {
    expect(await revokeXToken(CLIENT, "rt", "refresh_token", { fetchImpl: answer(200, { revoked: true }) })).toBe(true);
    expect(await revokeXToken(CLIENT, "rt", "refresh_token", { fetchImpl: answer(500, "") })).toBe(false);
    const broken = vi.fn(async () => {
      throw new Error("offline");
    });
    expect(await revokeXToken(CLIENT, "rt", "refresh_token", { fetchImpl: broken as never })).toBe(false);
  });

  it("reads who connected: the id and the @username", async () => {
    const fetchImpl = answer(200, { data: { id: "1001", username: "samrivdev", name: "Sam Rivera" } });
    expect(await fetchXMe("at-1", { fetchImpl })).toEqual({ id: "1001", username: "samrivdev" });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer at-1");
  });
});
