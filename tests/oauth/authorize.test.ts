import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeSupabase } from "../support/fake-supabase";
import {
  CHALLENGE,
  CLAUDE_CALLBACK,
  OTHER,
  SITE_A,
  SITE_B,
  SITE_C,
  T0,
  USER,
  asClient,
  authorizeParams,
  consentForm,
  register,
  seedDb,
} from "./support";

/**
 * The authorization endpoint and the consent screen. What is pinned: an
 * unknown client or an unregistered redirect URI is shown to the person and
 * never redirected to; every other problem goes back to the client with its
 * state; PKCE S256 is required; a person must be signed in, and sign-in
 * comes back to the same request; Read and Write are ticked by default and
 * Spend and Publish never are; what is granted is exactly what was ticked
 * among what was asked; the code is stored as a hash only; the decision
 * route refuses a post from another site.
 */

const state = vi.hoisted(() => ({
  db: null as unknown as FakeSupabase,
  sessionUser: null as { id: string; email?: string } | null,
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: state.sessionUser } }) },
    from: (table: string) => state.db.from(table),
  }),
}));

import { POST as decisionRoute } from "@/app/oauth/authorize/decision/route";
import { decideConsent, defaultGrantedScopes, parseScopes, prepareConsent } from "@/lib/oauth/authorize";
import { sha256Hex } from "@/lib/oauth/crypto";
import { MAX_LIVE_GRANTS } from "@/lib/oauth/config";

let clientId: string;
beforeEach(async () => {
  state.db = seedDb();
  state.sessionUser = null;
  clientId = (await register(state.db)).clientId;
});

const deps = (userId: string | null = USER) => ({ admin: asClient(state.db), userId });
const decide = (form: URLSearchParams, now: Date = T0) =>
  decideConsent(form, { admin: asClient(state.db), userId: USER, ownedBusinessIds: [SITE_A, SITE_B], now });
const query = (location: string) => new URL(location, "https://gettrafficfa.st").searchParams;

describe("checking the authorization request", () => {
  it("shows an unknown client or an unregistered redirect URI to the person, and redirects nowhere", async () => {
    const unknown = await prepareConsent(authorizeParams("gtfci_AAAAAAAAAAAAAAAAAAAAAA"), deps());
    expect(unknown).toMatchObject({ kind: "page" });

    const elsewhere = await prepareConsent(authorizeParams(clientId, { redirect_uri: "https://evil.test/callback" }), deps());
    expect(elsewhere).toMatchObject({ kind: "page" });
    expect(JSON.stringify(elsewhere)).not.toContain("evil.test");

    const missing = await prepareConsent(authorizeParams(clientId, { redirect_uri: null }), deps());
    expect(missing).toMatchObject({ kind: "page" });
  });

  it("sends every other problem back to the client with its state", async () => {
    const cases: Array<[Record<string, string | null>, string]> = [
      [{ code_challenge: null }, "invalid_request"],
      [{ code_challenge_method: "plain" }, "invalid_request"],
      [{ code_challenge_method: null }, "invalid_request"],
      [{ code_challenge: "too-short" }, "invalid_request"],
      [{ response_type: "token" }, "unsupported_response_type"],
      [{ resource: "https://other.test/mcp" }, "invalid_target"],
    ];
    for (const [over, error] of cases) {
      const step = await prepareConsent(authorizeParams(clientId, over), deps());
      expect(step.kind, JSON.stringify(over)).toBe("redirect");
      if (step.kind !== "redirect") continue;
      expect(step.location.startsWith(`${CLAUDE_CALLBACK}?`)).toBe(true);
      expect(query(step.location).get("error")).toBe(error);
      expect(query(step.location).get("state")).toBe("state-from-claude");
      expect(query(step.location).get("iss")).toBe("https://gettrafficfa.st");
    }
  });

  it("refuses a parameter sent twice", async () => {
    const params = authorizeParams(clientId);
    params.append("scope", "read");
    const step = await prepareConsent(params, deps());
    expect(step.kind === "redirect" && query(step.location).get("error")).toBe("invalid_request");
  });

  it("requires a session: sign-in first, then back to the same request", async () => {
    const step = await prepareConsent(authorizeParams(clientId), deps(null));
    expect(step.kind).toBe("redirect");
    if (step.kind !== "redirect") return;
    const url = new URL(step.location, "https://gettrafficfa.st");
    expect(url.pathname).toBe("/auth/sign-up");
    const next = url.searchParams.get("next") ?? "";
    expect(next.startsWith("/oauth/authorize?")).toBe(true);
    const back = new URLSearchParams(next.slice(next.indexOf("?") + 1));
    expect(back.get("client_id")).toBe(clientId);
    expect(back.get("code_challenge")).toBe(CHALLENGE);
    expect(back.get("state")).toBe("state-from-claude");
    expect(state.db.tables.oauth_authorization_codes).toHaveLength(0);
  });

  it("shows the consent screen to a signed-in person, Read and Write ticked", async () => {
    const step = await prepareConsent(authorizeParams(clientId), deps());
    expect(step).toMatchObject({
      kind: "consent",
      defaults: ["read", "write"],
      request: { requestedScopes: ["read", "write", "spend", "publish"], state: "state-from-claude", redirectUri: CLAUDE_CALLBACK },
    });
  });
});

describe("scopes", () => {
  it("reads the known scopes, and offers all four when the client names none of them", () => {
    expect(parseScopes("publish read offline_access")).toEqual(["read", "publish"]);
    expect(parseScopes("openid profile")).toBeNull();
    expect(parseScopes(null)).toBeNull();
  });

  it("never ticks spend or publish by default", () => {
    expect(defaultGrantedScopes(["read", "write", "spend", "publish"])).toEqual(["read", "write"]);
    expect(defaultGrantedScopes(["spend", "publish"])).toEqual([]);
  });
});

describe("the decision", () => {
  it("mints a code for what was ticked and stores only its hash", async () => {
    const { location } = await decide(consentForm(clientId, { grant: ["read", "write"], site: SITE_B }));
    expect(location.startsWith(`${CLAUDE_CALLBACK}?`)).toBe(true);
    const code = query(location).get("code") ?? "";
    expect(code).toMatch(/^gtfco_[A-Za-z0-9_-]{43}$/);
    expect(query(location).get("state")).toBe("state-from-claude");
    expect(query(location).get("iss")).toBe("https://gettrafficfa.st");

    const [row] = state.db.tables.oauth_authorization_codes;
    expect(row).toMatchObject({
      code_hash: sha256Hex(code),
      client_id: clientId,
      user_id: USER,
      business_id: SITE_B,
      scopes: ["read", "write"],
      code_challenge: CHALLENGE,
      code_challenge_method: "S256",
      redirect_uri: CLAUDE_CALLBACK,
      resource: "https://gettrafficfa.st/api/mcp",
    });
    expect(row.used_at ?? null).toBeNull();
    expect(Date.parse(row.expires_at as string) - T0.getTime()).toBeLessThanOrEqual(10 * 60_000);
    expect(JSON.stringify(state.db.tables)).not.toContain(code);
  });

  it("grants spend and publish only when ticked, and never a scope the client did not ask for", async () => {
    await decide(consentForm(clientId, { grant: ["read", "write"] }));
    await decide(consentForm(clientId, { grant: ["read", "spend"] }));
    await decide(consentForm(clientId, { grant: ["read", "write", "spend", "publish"] }, { scope: "read write" }));
    expect(state.db.tables.oauth_authorization_codes.map((row) => row.scopes)).toEqual([
      ["read", "write"],
      ["read", "spend"],
      ["read", "write"],
    ]);
  });

  it("grants every site with `all`, and refuses a site that is not the person's", async () => {
    await decide(consentForm(clientId, { site: "all" }));
    expect(state.db.tables.oauth_authorization_codes[0].business_id).toBeNull();

    const foreign = await decide(consentForm(clientId, { site: SITE_C }));
    expect(foreign.location.startsWith("/oauth/authorize?")).toBe(true);
    expect(query(foreign.location).get("notice")).toBe("choose_site");
    expect(state.db.tables.oauth_authorization_codes).toHaveLength(1);
  });

  it("sends access_denied on Deny, and asks again when nothing is ticked", async () => {
    const denied = await decide(consentForm(clientId, { decision: "deny" }));
    expect(query(denied.location).get("error")).toBe("access_denied");
    expect(query(denied.location).get("state")).toBe("state-from-claude");

    const none = await decide(consentForm(clientId, { grant: [] }));
    expect(query(none.location).get("notice")).toBe("choose_scope");
    expect(query(none.location).get("client_id")).toBe(clientId);
    expect(state.db.tables.oauth_authorization_codes).toHaveLength(0);
  });

  it("re-checks the request: a tampered redirect URI goes nowhere", async () => {
    const { location } = await decide(consentForm(clientId, {}, { redirect_uri: "https://evil.test/cb" }));
    expect(location.startsWith("/oauth/authorize?")).toBe(true);
    expect(state.db.tables.oauth_authorization_codes).toHaveLength(0);
  });

  it("stops at the live-grant cap", async () => {
    state.db.tables.oauth_tokens.push(
      ...Array.from({ length: MAX_LIVE_GRANTS }, (_, i) => ({
        id: `t-${i}`,
        family_id: `f-${i}`,
        user_id: USER,
        rotated_at: null,
        revoked_at: null,
        refresh_expires_at: "2026-12-01T00:00:00.000Z",
      })),
      // Another account's grants do not count.
      { id: "t-other", family_id: "f-other", user_id: OTHER, rotated_at: null, revoked_at: null, refresh_expires_at: "2026-12-01T00:00:00.000Z" }
    );
    const { location } = await decide(consentForm(clientId));
    expect(query(location).get("notice")).toBe("too_many_apps");
    state.db.tables.oauth_tokens[0].revoked_at = T0.toISOString();
    expect(query((await decide(consentForm(clientId))).location).get("code")).toBeTruthy();
  });
});

describe("POST /oauth/authorize/decision", () => {
  function post(form: URLSearchParams, headers: Record<string, string> = { origin: "https://gettrafficfa.st" }) {
    return decisionRoute(
      new Request("https://gettrafficfa.st/oauth/authorize/decision", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
        body: form.toString(),
      })
    );
  }

  it("refuses a post from another site (CSRF)", async () => {
    state.sessionUser = { id: USER };
    expect((await post(consentForm(clientId), { origin: "https://evil.test" })).status).toBe(403);
    expect((await post(consentForm(clientId), {})).status).toBe(403);
    expect((await post(consentForm(clientId), { "sec-fetch-site": "same-origin" })).status).toBe(303);
    expect(state.db.tables.oauth_authorization_codes).toHaveLength(1);
  });

  it("sends a person without a session to sign in, and back", async () => {
    const response = await post(consentForm(clientId));
    expect(response.status).toBe(303);
    expect(new URL(response.headers.get("location") ?? "").pathname).toBe("/auth/sign-up");
    expect(state.db.tables.oauth_authorization_codes).toHaveLength(0);
  });

  it("answers the client's redirect URI with the code", async () => {
    state.sessionUser = { id: USER };
    const response = await post(consentForm(clientId, { site: SITE_A }));
    expect(response.status).toBe(303);
    const location = response.headers.get("location") ?? "";
    expect(location.startsWith(`${CLAUDE_CALLBACK}?`)).toBe(true);
    expect(query(location).get("code")).toMatch(/^gtfco_/);
  });
});
