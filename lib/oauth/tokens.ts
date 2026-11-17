import type { SupabaseClient } from "@supabase/supabase-js";
import { isApiKeyScope, type ApiKeyScope } from "@/lib/api-keys";
import { ACCESS_TOKEN_TTL_MS, LAST_USED_RESOLUTION_MS, REFRESH_TOKEN_TTL_MS, isMcpResource } from "./config";
import type { OAuthClient } from "./clients";
import { generateSecret, isSecretOf, matchesDigest, sha256Hex, verifyPkce } from "./crypto";

/**
 * Tokens: the code exchange and the refresh (the token endpoint), checking
 * an access token (lib/api-auth.ts), revoking, and the connected apps a
 * person sees in Settings → API keys.
 *
 * One row of `oauth_tokens` is one access token and the refresh token
 * issued with it. Every row minted from one consent shares a `family_id`
 * (the id of the authorization code that started it): the family is the
 * grant, what Settings lists as one connected app and what Revoke ends.
 *
 * Refresh tokens rotate (OAuth 2.1 §4.3.1, required for public clients):
 * using one marks its row `rotated_at` and mints a new row. A refresh token
 * presented again after it rotated means two parties hold it, so the whole
 * family is revoked. The same for an authorization code used twice: the
 * tokens it already produced are revoked (OAuth 2.1 §4.1.3). Both claims
 * are a conditional update (`… where rotated_at is null`), so two requests
 * racing on one token cannot both win.
 *
 * Every value is stored as its SHA-256; a lookup is by digest, then the
 * digest is compared again in constant time. Nothing here logs a token.
 */

export const TOKEN_COLUMNS =
  "id, family_id, client_id, user_id, business_id, scopes, resource, access_token_hash, refresh_token_hash, access_expires_at, refresh_expires_at, rotated_at, revoked_at, last_used_at, granted_at";

const CODE_COLUMNS =
  "id, code_hash, client_id, user_id, business_id, scopes, code_challenge, redirect_uri, resource, expires_at, used_at";

type Row = Record<string, unknown>;

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

export type TokenResult =
  | { ok: true; body: TokenResponse }
  | { ok: false; status: 400 | 500; error: "invalid_request" | "invalid_grant" | "invalid_scope" | "invalid_target" | "server_error"; description: string };

const refuse = (error: Extract<TokenResult, { ok: false }>["error"], description: string, status: 400 | 500 = 400): TokenResult => ({
  ok: false,
  status,
  error,
  description,
});

const scopesOf = (row: Row): ApiKeyScope[] => (Array.isArray(row.scopes) ? row.scopes : []).filter(isApiKeyScope);
const time = (value: unknown): number => (typeof value === "string" ? Date.parse(value) : NaN);

function warn(event: string, error: { message: string } | null | undefined) {
  if (error) console.warn(JSON.stringify({ level: "warn", event, error: error.message.slice(0, 300) }));
}

/** Revokes every token of one grant. Idempotent. */
export async function revokeFamily(admin: SupabaseClient, familyId: string, now: Date = new Date()): Promise<void> {
  const { error } = await admin
    .from("oauth_tokens")
    .update({ revoked_at: now.toISOString() })
    .eq("family_id", familyId)
    .is("revoked_at", null);
  if (error) {
    console.error(JSON.stringify({ level: "error", event: "oauth.revoke_family_failed", family_id: familyId, error: error.message.slice(0, 300) }));
  }
}

interface Grant {
  familyId: string;
  clientId: string;
  userId: string;
  businessId: string | null;
  scopes: ApiKeyScope[];
  resource: string;
  grantedAt: string;
  lastUsedAt: string | null;
}

/** Mints an access and refresh token for `grant`, stores their digests, answers RFC 6749 §5.1. */
async function issueTokens(admin: SupabaseClient, grant: Grant, now: Date): Promise<TokenResult> {
  const access = generateSecret("access");
  const refresh = generateSecret("refresh");
  const { error } = await admin.from("oauth_tokens").insert({
    family_id: grant.familyId,
    client_id: grant.clientId,
    user_id: grant.userId,
    business_id: grant.businessId,
    scopes: grant.scopes,
    resource: grant.resource,
    access_token_hash: sha256Hex(access),
    refresh_token_hash: sha256Hex(refresh),
    access_expires_at: new Date(now.getTime() + ACCESS_TOKEN_TTL_MS).toISOString(),
    refresh_expires_at: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS).toISOString(),
    granted_at: grant.grantedAt,
    last_used_at: grant.lastUsedAt,
    created_at: now.toISOString(),
  });
  if (error) {
    console.error(JSON.stringify({ level: "error", event: "oauth.tokens_not_stored", error: error.message.slice(0, 300) }));
    return refuse("server_error", "The tokens could not be issued. Try again.", 500);
  }
  const { error: touchError } = await admin
    .from("oauth_clients")
    .update({ last_used_at: now.toISOString() })
    .eq("client_id", grant.clientId);
  warn("oauth.client_last_used_failed", touchError);

  return {
    ok: true,
    body: {
      access_token: access,
      token_type: "Bearer",
      expires_in: Math.round(ACCESS_TOKEN_TTL_MS / 1000),
      refresh_token: refresh,
      scope: grant.scopes.join(" "),
    },
  };
}

/** A `resource` sent to the token endpoint must be the one the grant is for. */
function resourceProblem(params: URLSearchParams, granted: string): TokenResult | null {
  const sent = params.getAll("resource");
  if (sent.length === 0) return null;
  if (sent.length > 1 || !isMcpResource(sent[0]) || sent[0].replace(/\/+$/, "") !== granted) {
    return refuse("invalid_target", "The resource does not match the one this grant is for.");
  }
  return null;
}

/**
 * `grant_type=authorization_code` (RFC 6749 §4.1.3 with RFC 7636 §4.6): the
 * code must be this client's, unexpired, unused, sent with the same
 * redirect URI, and the verifier must hash to the challenge. Then the code
 * is claimed, once.
 */
export async function exchangeAuthorizationCode(
  admin: SupabaseClient,
  client: OAuthClient,
  params: URLSearchParams,
  now: Date = new Date()
): Promise<TokenResult> {
  const code = params.get("code");
  if (!isSecretOf("code", code)) return refuse("invalid_grant", "Unknown authorization code.");
  const { data, error } = await admin.from("oauth_authorization_codes").select(CODE_COLUMNS).eq("code_hash", sha256Hex(code)).maybeSingle();
  if (error) return refuse("server_error", "The code could not be checked. Try again.", 500);
  const row = data as Row | null;
  if (!row || !matchesDigest(row.code_hash, code)) return refuse("invalid_grant", "Unknown authorization code.");
  if (row.client_id !== client.clientId) return refuse("invalid_grant", "This code was issued to another client.");

  if (row.used_at) {
    await revokeFamily(admin, row.id as string, now);
    return refuse("invalid_grant", "This code was already used; the tokens issued with it are revoked.");
  }
  if (!(time(row.expires_at) > now.getTime())) return refuse("invalid_grant", "This code expired. Authorize again.");
  if (params.get("redirect_uri") !== row.redirect_uri) {
    return refuse("invalid_grant", "redirect_uri must be the one sent to the authorization endpoint.");
  }
  const target = resourceProblem(params, row.resource as string);
  if (target) return target;
  if (!verifyPkce(params.get("code_verifier"), row.code_challenge as string)) {
    return refuse("invalid_grant", "The code_verifier does not match the code_challenge.");
  }

  const { data: claimed, error: claimError } = await admin
    .from("oauth_authorization_codes")
    .update({ used_at: now.toISOString() })
    .eq("id", row.id as string)
    .is("used_at", null)
    .select("id")
    .maybeSingle();
  if (claimError) return refuse("server_error", "The code could not be redeemed. Try again.", 500);
  if (!claimed) {
    await revokeFamily(admin, row.id as string, now);
    return refuse("invalid_grant", "This code was already used; the tokens issued with it are revoked.");
  }

  return issueTokens(
    admin,
    {
      familyId: row.id as string,
      clientId: client.clientId,
      userId: row.user_id as string,
      businessId: (row.business_id as string | null) ?? null,
      scopes: scopesOf(row),
      resource: row.resource as string,
      grantedAt: now.toISOString(),
      lastUsedAt: null,
    },
    now
  );
}

/**
 * `grant_type=refresh_token` (RFC 6749 §6) with rotation: the old refresh
 * token is spent, a new pair is issued, the family and what it grants carry
 * over. A narrower `scope` may be asked for, never a wider one.
 */
export async function refreshAccessToken(
  admin: SupabaseClient,
  client: OAuthClient,
  params: URLSearchParams,
  now: Date = new Date()
): Promise<TokenResult> {
  const token = params.get("refresh_token");
  if (!isSecretOf("refresh", token)) return refuse("invalid_grant", "Unknown refresh token.");
  const { data, error } = await admin.from("oauth_tokens").select(TOKEN_COLUMNS).eq("refresh_token_hash", sha256Hex(token)).maybeSingle();
  if (error) return refuse("server_error", "The refresh token could not be checked. Try again.", 500);
  const row = data as Row | null;
  if (!row || !matchesDigest(row.refresh_token_hash, token)) return refuse("invalid_grant", "Unknown refresh token.");
  if (row.client_id !== client.clientId) return refuse("invalid_grant", "This refresh token was issued to another client.");
  if (row.revoked_at) return refuse("invalid_grant", "This connection was revoked. Connect again.");
  if (row.rotated_at) {
    await revokeFamily(admin, row.family_id as string, now);
    return refuse("invalid_grant", "This refresh token was already used, so the connection was revoked. Connect again.");
  }
  if (!(time(row.refresh_expires_at) > now.getTime())) return refuse("invalid_grant", "This refresh token expired. Connect again.");

  const granted = scopesOf(row);
  let scopes = granted;
  const asked = params.get("scope");
  if (asked !== null) {
    const names = asked.split(/\s+/).filter(Boolean);
    if (names.some((name) => !granted.includes(name as ApiKeyScope))) {
      return refuse("invalid_scope", "A refresh can keep or narrow the scopes granted, never add one.");
    }
    scopes = granted.filter((scope) => names.includes(scope));
    if (scopes.length === 0) return refuse("invalid_scope", "Ask for at least one of the scopes granted.");
  }
  const target = resourceProblem(params, row.resource as string);
  if (target) return target;

  const { data: claimed, error: claimError } = await admin
    .from("oauth_tokens")
    .update({ rotated_at: now.toISOString() })
    .eq("id", row.id as string)
    .is("rotated_at", null)
    .is("revoked_at", null)
    .select("id")
    .maybeSingle();
  if (claimError) return refuse("server_error", "The refresh token could not be redeemed. Try again.", 500);
  if (!claimed) {
    await revokeFamily(admin, row.family_id as string, now);
    return refuse("invalid_grant", "This refresh token was already used, so the connection was revoked. Connect again.");
  }

  return issueTokens(
    admin,
    {
      familyId: row.family_id as string,
      clientId: client.clientId,
      userId: row.user_id as string,
      businessId: (row.business_id as string | null) ?? null,
      scopes,
      resource: row.resource as string,
      grantedAt: (row.granted_at as string) ?? now.toISOString(),
      lastUsedAt: (row.last_used_at as string | null) ?? null,
    },
    now
  );
}

/**
 * RFC 7009: revokes the grant a token belongs to, access or refresh, when
 * it was issued to this client. Answers nothing either way: an unknown
 * token, or another client's, is not this client's business.
 */
export async function revokePresentedToken(admin: SupabaseClient, client: OAuthClient, token: string | null, now: Date = new Date()): Promise<void> {
  const column = isSecretOf("refresh", token) ? "refresh_token_hash" : isSecretOf("access", token) ? "access_token_hash" : null;
  if (!column || !token) return;
  const { data } = await admin.from("oauth_tokens").select("family_id, client_id, access_token_hash, refresh_token_hash").eq(column, sha256Hex(token)).maybeSingle();
  const row = data as Row | null;
  if (!row || !matchesDigest(row[column], token) || row.client_id !== client.clientId) return;
  await revokeFamily(admin, row.family_id as string, now);
}

export interface VerifiedAccessToken {
  tokenId: string;
  familyId: string;
  clientId: string;
  userId: string;
  /** The one site the grant may act on; null for every site of the account. */
  businessId: string | null;
  scopes: ApiKeyScope[];
}

export type VerifyAccessTokenResult =
  | { ok: true; token: VerifiedAccessToken }
  | { ok: false; reason: "malformed" | "unknown" | "revoked" | "expired" | "wrong_resource" };

/**
 * Who an OAuth access token speaks for, at `resource`, or why it speaks for
 * no one. A token is accepted only by the resource it was issued for (MCP
 * authorization: audience validation). Fails closed: an unreadable table is
 * an unknown token. `last_used_at` is written at most once a minute.
 */
export async function verifyAccessToken(
  token: string,
  deps: { admin: SupabaseClient; resource: string; now?: Date }
): Promise<VerifyAccessTokenResult> {
  if (!isSecretOf("access", token)) return { ok: false, reason: "malformed" };
  const { data, error } = await deps.admin.from("oauth_tokens").select(TOKEN_COLUMNS).eq("access_token_hash", sha256Hex(token)).maybeSingle();
  if (error) {
    console.error(JSON.stringify({ level: "error", event: "oauth.verify_failed", error: error.message.slice(0, 300) }));
    return { ok: false, reason: "unknown" };
  }
  const row = data as Row | null;
  if (!row || !matchesDigest(row.access_token_hash, token)) return { ok: false, reason: "unknown" };
  if (row.revoked_at) return { ok: false, reason: "revoked" };
  const now = deps.now ?? new Date();
  if (!(time(row.access_expires_at) > now.getTime())) return { ok: false, reason: "expired" };
  if (row.resource !== deps.resource) return { ok: false, reason: "wrong_resource" };

  const lastUsed = time(row.last_used_at);
  if (!Number.isFinite(lastUsed) || now.getTime() - lastUsed >= LAST_USED_RESOLUTION_MS) {
    const { error: touchError } = await deps.admin
      .from("oauth_tokens")
      .update({ last_used_at: now.toISOString() })
      .eq("id", row.id as string);
    // "Last used" is a courtesy: failing to write it never refuses the call.
    warn("oauth.last_used_failed", touchError);
  }

  return {
    ok: true,
    token: {
      tokenId: row.id as string,
      familyId: row.family_id as string,
      clientId: row.client_id as string,
      userId: row.user_id as string,
      businessId: (row.business_id as string | null) ?? null,
      scopes: scopesOf(row),
    },
  };
}

/**
 * Live grants of one account: families whose newest row is neither revoked
 * nor past its refresh expiry. Null when they cannot be counted.
 */
export async function countLiveGrants(admin: SupabaseClient, userId: string, now: Date = new Date()): Promise<number | null> {
  const { count, error } = await admin
    .from("oauth_tokens")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .is("rotated_at", null)
    .is("revoked_at", null)
    .gt("refresh_expires_at", now.toISOString());
  if (error) return null;
  return count ?? 0;
}

export interface ConnectedApp {
  /** The grant (`family_id`): what Revoke takes. */
  id: string;
  clientName: string;
  /** Where the app receives its codes, as the consent screen showed it. */
  redirectHost: string | null;
  scopes: ApiKeyScope[];
  /** The one site it may act on; null for every site. */
  businessId: string | null;
  grantedAt: string;
  lastUsedAt: string | null;
}

/**
 * The apps a person has connected, newest first: the live head of each
 * family, read through the person's own client (RLS: their rows), and the
 * apps' names through the service role, for exactly the clients those rows
 * name (a client row has no owner a policy could check).
 */
export async function listConnectedApps(
  supabase: SupabaseClient,
  admin: SupabaseClient,
  userId: string,
  now: Date = new Date()
): Promise<ConnectedApp[]> {
  const { data, error } = await supabase
    .from("oauth_tokens")
    .select("family_id, client_id, business_id, scopes, granted_at, last_used_at")
    .eq("user_id", userId)
    .is("rotated_at", null)
    .is("revoked_at", null)
    .gt("refresh_expires_at", now.toISOString())
    .order("granted_at", { ascending: false })
    .limit(100);
  if (error) throw new Error(`oauth_tokens: ${error.message}`);
  const rows = (data ?? []) as Row[];
  if (rows.length === 0) return [];

  const clientIds = [...new Set(rows.map((row) => row.client_id as string))];
  const { data: clients, error: clientError } = await admin
    .from("oauth_clients")
    .select("client_id, client_name, redirect_uris")
    .in("client_id", clientIds);
  if (clientError) throw new Error(`oauth_clients: ${clientError.message}`);
  const byId = new Map(((clients ?? []) as Row[]).map((client) => [client.client_id as string, client]));

  return rows.map((row) => {
    const client = byId.get(row.client_id as string);
    const uris = Array.isArray(client?.redirect_uris) ? (client.redirect_uris as string[]) : [];
    let redirectHost: string | null = null;
    try {
      redirectHost = uris[0] ? new URL(uris[0]).hostname : null;
    } catch {
      redirectHost = null;
    }
    return {
      id: row.family_id as string,
      clientName: (client?.client_name as string | undefined) ?? "An app that no longer exists",
      redirectHost,
      scopes: scopesOf(row),
      businessId: (row.business_id as string | null) ?? null,
      grantedAt: row.granted_at as string,
      lastUsedAt: (row.last_used_at as string | null) ?? null,
    };
  });
}

/**
 * Revokes one of the person's grants (Settings → API keys → Connected apps).
 * Through the service role, so it names the person explicitly: a grant of
 * another account is not found.
 */
export async function revokeConnectedApp(
  admin: SupabaseClient,
  userId: string,
  familyId: string,
  now: Date = new Date()
): Promise<{ ok: true } | { ok: false; status: 404 | 500; error: string }> {
  const { data, error } = await admin
    .from("oauth_tokens")
    .select("id")
    .eq("family_id", familyId)
    .eq("user_id", userId)
    .limit(1);
  if (error) return { ok: false, status: 500, error: error.message };
  if (!data || data.length === 0) return { ok: false, status: 404, error: "Connected app not found" };
  const { error: updateError } = await admin
    .from("oauth_tokens")
    .update({ revoked_at: now.toISOString() })
    .eq("family_id", familyId)
    .eq("user_id", userId)
    .is("revoked_at", null);
  if (updateError) return { ok: false, status: 500, error: updateError.message };
  return { ok: true };
}
