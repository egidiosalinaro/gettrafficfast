import type { SupabaseClient } from "@supabase/supabase-js";
import { FakeSupabase } from "../support/fake-supabase";
import { registerClient } from "@/lib/oauth/clients";
import { decideConsent } from "@/lib/oauth/authorize";
import { pkceChallenge } from "@/lib/oauth/crypto";
import { MCP_RESOURCE } from "@/lib/oauth/config";

/**
 * The OAuth tests' world: two accounts, three sites (the user owns A and B,
 * someone else owns C), and helpers that walk the flow the way Claude does:
 * register, consent, exchange.
 */

export const USER = "11111111-1111-4111-8111-111111111111";
export const OTHER = "22222222-2222-4222-8222-222222222222";
export const SITE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const SITE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const SITE_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

export const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";
export const VERIFIER = "a-long-pkce-verifier-0123456789-abcdefghijklmnopqrstuvwxyz";
export const CHALLENGE = pkceChallenge(VERIFIER);
export const T0 = new Date("2026-11-10T12:00:00.000Z");

export function seedDb(): FakeSupabase {
  return new FakeSupabase({
    businesses: [
      { id: SITE_A, user_id: USER, name: "Acme", website_url: "https://acme.test", created_at: "2026-01-01T00:00:00Z" },
      { id: SITE_B, user_id: USER, name: "Bravo", website_url: "https://bravo.test", created_at: "2026-02-01T00:00:00Z" },
      { id: SITE_C, user_id: OTHER, name: "Charlie", website_url: "https://charlie.test", created_at: "2026-01-15T00:00:00Z" },
    ],
    placement_targets: [
      { id: "t-a", user_id: USER, business_id: SITE_A },
      { id: "t-b", user_id: USER, business_id: SITE_B },
      { id: "t-c", user_id: OTHER, business_id: SITE_C },
    ],
    oauth_clients: [],
    oauth_authorization_codes: [],
    oauth_tokens: [],
    tool_calls: [],
  });
}

export const asClient = (db: FakeSupabase) => db as unknown as SupabaseClient;

/** Registers a client as Claude does (public, PKCE) and answers its client_id. */
export async function register(
  db: FakeSupabase,
  over: Record<string, unknown> = {},
  ip = "160.79.104.10"
): Promise<{ clientId: string; secret?: string }> {
  const result = await registerClient(asClient(db), {
    body: {
      client_name: "Claude",
      redirect_uris: [CLAUDE_CALLBACK],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      ...over,
    },
    ip,
    now: T0,
  });
  if (!result.ok) throw new Error(result.description);
  return { clientId: result.body.client_id as string, secret: result.body.client_secret as string | undefined };
}

/** The authorization request Claude sends, as query parameters. */
export function authorizeParams(clientId: string, over: Record<string, string | null> = {}): URLSearchParams {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CLAUDE_CALLBACK,
    scope: "read write spend publish",
    state: "state-from-claude",
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    resource: MCP_RESOURCE,
  });
  for (const [key, value] of Object.entries(over)) {
    if (value === null) params.delete(key);
    else params.set(key, value);
  }
  return params;
}

/** The consent form as the screen posts it. */
export function consentForm(
  clientId: string,
  choice: { decision?: "allow" | "deny"; grant?: string[]; site?: string } = {},
  over: Record<string, string | null> = {}
): URLSearchParams {
  const form = authorizeParams(clientId, over);
  form.set("decision", choice.decision ?? "allow");
  for (const scope of choice.grant ?? ["read", "write"]) form.append("grant", scope);
  form.set("site", choice.site ?? SITE_A);
  return form;
}

/** Allow on the consent screen; answers the code from the redirect. */
export async function consent(
  db: FakeSupabase,
  clientId: string,
  choice: { grant?: string[]; site?: string } = {},
  now: Date = T0
): Promise<string> {
  const { location } = await decideConsent(consentForm(clientId, choice), {
    admin: asClient(db),
    userId: USER,
    ownedBusinessIds: [SITE_A, SITE_B],
    now,
  });
  const code = new URL(location).searchParams.get("code");
  if (!code) throw new Error(`no code in ${location}`);
  return code;
}

/** The token request's form for a code, as Claude sends it. */
export function codeForm(clientId: string, code: string, over: Record<string, string | null> = {}): URLSearchParams {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: CLAUDE_CALLBACK,
    code_verifier: VERIFIER,
    client_id: clientId,
    resource: MCP_RESOURCE,
  });
  for (const [key, value] of Object.entries(over)) {
    if (value === null) form.delete(key);
    else form.set(key, value);
  }
  return form;
}
