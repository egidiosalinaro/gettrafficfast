import type { SupabaseClient } from "@supabase/supabase-js";
import {
  XOAuthError,
  isXPostingConfigured,
  refreshXTokens,
  revokeXToken,
  xOAuthClientFromEnv,
  type XMe,
  type XOAuthClient,
  type XTokens,
} from "@/lib/providers/x/oauth";
import { decryptSecret, encryptSecret } from "./crypto";

/**
 * The X account a site posts from (docs/INTEGRATIONS.md, "X: the account GTF
 * posts from"), one row per site in `x_posting_connections`
 * (migration 20261125100000). Two sites may connect the same X account or
 * different ones; a site has at most one.
 *
 * The tokens are encrypted at rest with the integrations key, like every
 * other credential, and never leave the server: `loadXPostingAccount` and
 * everything a screen or a tool reads select named columns without them.
 * Writes go through the service role (the owner may read the row, never
 * write it), each narrowed by the verified user AND site.
 *
 * Connecting is the person's act, on X's consent screen. GTF then posts
 * from that account only when the person presses Post on an allowed reply
 * (or confirms it to their agent, `post_on_x`); it never posts on its own.
 */

export const X_POSTING_TABLE = "x_posting_connections";

/** The columns a screen or a tool may read: no token among them. */
export const X_POSTING_PUBLIC_COLUMNS = "username, x_user_id, status, last_error, created_at, updated_at";

/** Refresh when the access token has less than this left, so a post never starts with a token about to lapse. */
export const X_TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

export interface XPostingAccount {
  /** As X spells it, without "@". */
  username: string;
  xUserId: string;
  /** "error": X refused the stored token; the person connects again. */
  status: "connected" | "error";
  lastError: string | null;
  connectedAt: string;
}

/** Whether the deployment offers the connection at all (X_OAUTH_CLIENT_ID and X_OAUTH_CLIENT_SECRET). */
export function xPostingAvailable(): boolean {
  return isXPostingConfigured();
}

type Row = Record<string, unknown>;

function mapAccount(row: Row): XPostingAccount {
  return {
    username: String(row.username),
    xUserId: String(row.x_user_id),
    status: row.status === "error" ? "error" : "connected",
    lastError: typeof row.last_error === "string" ? row.last_error : null,
    connectedAt: String(row.created_at),
  };
}

/**
 * The site's connected account, without its tokens, or null. `supabase` is
 * the caller's client (RLS: the owner's own rows) or the service role, with
 * `userId` naming the owner either way.
 */
export async function loadXPostingAccount(supabase: SupabaseClient, userId: string, businessId: string): Promise<XPostingAccount | null> {
  try {
    const { data, error } = await supabase
      .from(X_POSTING_TABLE)
      .select(X_POSTING_PUBLIC_COLUMNS)
      .eq("business_id", businessId)
      .eq("user_id", userId)
      .maybeSingle();
    if (error || !data) return null;
    return mapAccount(data as Row);
  } catch {
    // A database without the table reads as not connected: posting is then simply not offered.
    return null;
  }
}

/** Saves (or replaces) the site's connection after X's consent screen. Service role. */
export async function saveXConnection(input: {
  admin: SupabaseClient;
  userId: string;
  businessId: string;
  me: XMe;
  tokens: XTokens;
  now?: Date;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const now = (input.now ?? new Date()).toISOString();
  const { error } = await input.admin.from(X_POSTING_TABLE).upsert(
    {
      user_id: input.userId,
      business_id: input.businessId,
      x_user_id: input.me.id,
      username: input.me.username,
      access_token_encrypted: encryptSecret(input.tokens.accessToken),
      refresh_token_encrypted: input.tokens.refreshToken ? encryptSecret(input.tokens.refreshToken) : null,
      expires_at: input.tokens.expiresAt ? input.tokens.expiresAt.toISOString() : null,
      scopes: input.tokens.scopes,
      status: "connected",
      last_error: null,
      updated_at: now,
    },
    { onConflict: "business_id" }
  );
  return error ? { ok: false, error: error.message } : { ok: true };
}

export type XAccessToken =
  | { ok: true; accessToken: string; account: XPostingAccount }
  | { ok: false; reason: "unavailable" | "not_connected" | "auth_expired" | "error"; message: string };

export const X_NOT_CONNECTED = "This site has no X account connected. Connect one in Settings → Connections → X.";
export const X_RECONNECT = "X no longer accepts this site's connection. Connect the X account again in Settings → Connections → X.";

/**
 * A usable access token for the site's account, refreshed first when it is
 * about to lapse. X rotates refresh tokens, so the new pair is stored
 * before the token is handed out; a refresh X refuses marks the row
 * `error` and asks the person to connect again. Service role.
 */
export async function xAccessTokenFor(input: {
  admin: SupabaseClient;
  userId: string;
  businessId: string;
  oauthClient?: XOAuthClient | null;
  fetchImpl?: typeof fetch;
  now?: Date;
}): Promise<XAccessToken> {
  const oauthClient = input.oauthClient === undefined ? xOAuthClientFromEnv() : input.oauthClient;
  if (!oauthClient) return { ok: false, reason: "unavailable", message: "Posting on X is not set up on this deployment." };
  const now = input.now ?? new Date();

  const { data, error } = await input.admin
    .from(X_POSTING_TABLE)
    .select(`${X_POSTING_PUBLIC_COLUMNS}, access_token_encrypted, refresh_token_encrypted, expires_at`)
    .eq("business_id", input.businessId)
    .eq("user_id", input.userId)
    .maybeSingle();
  if (error) return { ok: false, reason: "error", message: error.message };
  if (!data) return { ok: false, reason: "not_connected", message: X_NOT_CONNECTED };
  const row = data as Row;
  const account = mapAccount(row);
  if (account.status === "error") return { ok: false, reason: "auth_expired", message: X_RECONNECT };

  let accessToken: string;
  try {
    accessToken = decryptSecret(String(row.access_token_encrypted));
  } catch {
    return { ok: false, reason: "error", message: "The stored X token could not be read. Connect the X account again." };
  }
  const expiresAt = typeof row.expires_at === "string" ? new Date(row.expires_at) : null;
  const fresh = !expiresAt || expiresAt.getTime() - now.getTime() > X_TOKEN_REFRESH_MARGIN_MS;
  if (fresh) return { ok: true, accessToken, account };

  const sealedRefresh = typeof row.refresh_token_encrypted === "string" ? row.refresh_token_encrypted : null;
  if (!sealedRefresh) {
    await markXConnectionError(input.admin, input.userId, input.businessId, "The access token expired and there is no refresh token.", now);
    return { ok: false, reason: "auth_expired", message: X_RECONNECT };
  }

  let tokens: XTokens;
  try {
    tokens = await refreshXTokens(oauthClient, decryptSecret(sealedRefresh), { fetchImpl: input.fetchImpl, now });
  } catch (err) {
    if (err instanceof XOAuthError && err.kind === "invalid_grant") {
      await markXConnectionError(input.admin, input.userId, input.businessId, err.message, now);
      return { ok: false, reason: "auth_expired", message: X_RECONNECT };
    }
    return { ok: false, reason: "error", message: err instanceof Error ? err.message : String(err) };
  }

  // Stored only if the row still holds the refresh token just used: a
  // concurrent refresh that won keeps its pair, and this one is not saved.
  const { data: saved, error: saveError } = await input.admin
    .from(X_POSTING_TABLE)
    .update({
      access_token_encrypted: encryptSecret(tokens.accessToken),
      refresh_token_encrypted: tokens.refreshToken ? encryptSecret(tokens.refreshToken) : sealedRefresh,
      expires_at: tokens.expiresAt ? tokens.expiresAt.toISOString() : null,
      ...(tokens.scopes.length > 0 ? { scopes: tokens.scopes } : {}),
      updated_at: now.toISOString(),
    })
    .eq("business_id", input.businessId)
    .eq("user_id", input.userId)
    .eq("refresh_token_encrypted", sealedRefresh)
    .select("business_id")
    .maybeSingle();
  if (saveError) return { ok: false, reason: "error", message: saveError.message };
  if (!saved) {
    // Another request refreshed first and stored its own pair: use its access token.
    const { data: winner } = await input.admin
      .from(X_POSTING_TABLE)
      .select("access_token_encrypted")
      .eq("business_id", input.businessId)
      .eq("user_id", input.userId)
      .maybeSingle();
    try {
      const sealed = (winner as Row | null)?.access_token_encrypted;
      if (typeof sealed === "string") return { ok: true, accessToken: decryptSecret(sealed), account };
    } catch {
      // Falls through.
    }
    return { ok: false, reason: "error", message: "The X connection changed while it was being refreshed. Try again." };
  }
  return { ok: true, accessToken: tokens.accessToken, account };
}

async function markXConnectionError(admin: SupabaseClient, userId: string, businessId: string, detail: string, now: Date) {
  await admin
    .from(X_POSTING_TABLE)
    .update({ status: "error", last_error: detail.slice(0, 500), updated_at: now.toISOString() })
    .eq("business_id", businessId)
    .eq("user_id", userId);
}

/** The answer when X refused a post's token (401): the row is marked so Settings says to connect again. */
export async function markXConnectionExpired(admin: SupabaseClient, userId: string, businessId: string, now: Date = new Date()) {
  await markXConnectionError(admin, userId, businessId, "X refused the token when posting (401).", now);
}

/**
 * Disconnects the site's X account: the tokens are revoked at X (best
 * effort: a token X does not confirm revoking still stops existing here)
 * and the row is deleted. Service role.
 */
export async function disconnectXAccount(input: {
  admin: SupabaseClient;
  userId: string;
  businessId: string;
  oauthClient?: XOAuthClient | null;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: true; disconnected: boolean; revoked: boolean } | { ok: false; status: 500; error: string }> {
  const { data, error } = await input.admin
    .from(X_POSTING_TABLE)
    .select("access_token_encrypted, refresh_token_encrypted")
    .eq("business_id", input.businessId)
    .eq("user_id", input.userId)
    .maybeSingle();
  if (error) return { ok: false, status: 500, error: error.message };
  if (!data) return { ok: true, disconnected: false, revoked: false };

  const oauthClient = input.oauthClient === undefined ? xOAuthClientFromEnv() : input.oauthClient;
  let revoked = false;
  if (oauthClient) {
    const row = data as Row;
    const open = (sealed: unknown) => {
      try {
        return typeof sealed === "string" ? decryptSecret(sealed) : null;
      } catch {
        return null;
      }
    };
    const refresh = open(row.refresh_token_encrypted);
    const access = open(row.access_token_encrypted);
    // Revoking the refresh token ends the grant; the access token too, so nothing lingers for its last hour.
    const results = await Promise.all([
      refresh ? revokeXToken(oauthClient, refresh, "refresh_token", { fetchImpl: input.fetchImpl }) : Promise.resolve(false),
      access ? revokeXToken(oauthClient, access, "access_token", { fetchImpl: input.fetchImpl }) : Promise.resolve(false),
    ]);
    revoked = results.some(Boolean);
  }

  const { error: deleteError } = await input.admin
    .from(X_POSTING_TABLE)
    .delete()
    .eq("business_id", input.businessId)
    .eq("user_id", input.userId);
  if (deleteError) return { ok: false, status: 500, error: deleteError.message };
  return { ok: true, disconnected: true, revoked };
}
