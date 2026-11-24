import { createHash, randomBytes } from "crypto";
import { z } from "zod";
import { X_API_BASE, X_API_TIMEOUT_MS } from "./api";

/**
 * Connecting the X account a site posts from: OAuth 2.0 Authorization Code
 * with PKCE, X's user-context flow (docs/INTEGRATIONS.md, "X: the account GTF
 * posts from").
 *
 * The deployment is a confidential client: the token endpoint is called with
 * HTTP Basic auth (client id and secret), and the code verifier proves the
 * code was asked for by the same browser round trip. Without both
 * `X_OAUTH_CLIENT_ID` and `X_OAUTH_CLIENT_SECRET` the connection is not
 * offered at all: that pair is the deployment's switch.
 *
 * This file only speaks HTTP to X's OAuth endpoints and `/2/users/me`. It
 * reads no table and stores nothing; it is handed a `fetch` so tests never
 * reach X. Storing, encrypting and refreshing are lib/integrations/x-posting.ts.
 */

export const X_AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
export const X_TOKEN_URL = "https://api.x.com/2/oauth2/token";
export const X_REVOKE_URL = "https://api.x.com/2/oauth2/revoke";

/**
 * What the connection asks for: read and write posts (a reply is a post),
 * read the account itself (its id and @username), and a refresh token
 * (`offline.access`), without which the connection would last two hours.
 */
export const X_POSTING_SCOPES = ["tweet.read", "tweet.write", "users.read", "offline.access"] as const;

/** The path X sends the person back to. Registered in X's developer portal as `${SITE_URL}${X_CALLBACK_PATH}`. */
export const X_CALLBACK_PATH = "/api/integrations/x/callback";

type Env = Record<string, string | undefined>;

export interface XOAuthClient {
  clientId: string;
  clientSecret: string;
}

/** The deployment's OAuth client, or null when either half is missing: then nothing about posting is offered. */
export function xOAuthClientFromEnv(env: Env = process.env): XOAuthClient | null {
  const clientId = env.X_OAUTH_CLIENT_ID?.trim();
  const clientSecret = env.X_OAUTH_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/** True when the deployment can connect an X account to post from. */
export function isXPostingConfigured(env: Env = process.env): boolean {
  return xOAuthClientFromEnv(env) !== null;
}

// ── PKCE ─────────────────────────────────────────────────────────────────────

function base64url(bytes: Buffer): string {
  return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** S256 challenge of a verifier (RFC 7636 §4.2). */
export function pkceChallenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

/** A fresh verifier (43 characters of base64url, RFC 7636's minimum length) and its S256 challenge. */
export function createPkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: pkceChallenge(verifier) };
}

/** A fresh `state`: 32 random bytes, base64url. */
export function createOAuthState(): string {
  return base64url(randomBytes(32));
}

/** The address of X's consent screen for this round trip. */
export function buildXAuthorizeUrl(params: { clientId: string; redirectUri: string; state: string; challenge: string }): string {
  const url = new URL(X_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("scope", X_POSTING_SCOPES.join(" "));
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

// ── Tokens ───────────────────────────────────────────────────────────────────

/**
 * Why an OAuth call failed:
 *   invalid_grant — X refused the code or the refresh token (used, expired,
 *                   revoked): the person has to connect again;
 *   rate_limited  — 429;
 *   other         — anything else (a network failure, an unexpected answer).
 */
export type XOAuthErrorKind = "invalid_grant" | "rate_limited" | "other";

export class XOAuthError extends Error {
  constructor(
    message: string,
    readonly kind: XOAuthErrorKind,
    readonly status?: number
  ) {
    super(message);
    this.name = "XOAuthError";
  }
}

const TokenResponse = z
  .object({
    access_token: z.string().min(1),
    token_type: z.string().optional(),
    expires_in: z.number().optional(),
    refresh_token: z.string().min(1).optional(),
    scope: z.string().optional(),
  })
  .passthrough();

export interface XTokens {
  accessToken: string;
  /** Null when X sent none (no `offline.access`): the connection then lasts until the access token expires. */
  refreshToken: string | null;
  /** When the access token expires; null when X did not say. */
  expiresAt: Date | null;
  scopes: string[];
}

interface CallOptions {
  fetchImpl?: typeof fetch;
  now?: Date;
}

function basicAuth(client: XOAuthClient): string {
  return `Basic ${Buffer.from(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`).toString("base64")}`;
}

async function postForm(url: string, client: XOAuthClient, form: Record<string, string>, options: CallOptions): Promise<{ status: number; body: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: basicAuth(client),
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(X_API_TIMEOUT_MS),
    });
  } catch (err) {
    throw new XOAuthError(`X did not answer: ${err instanceof Error ? err.message : String(err)}`, "other");
  }
  return { status: response.status, body: await response.text().catch(() => "") };
}

function tokensFrom(status: number, body: string, now: Date): XTokens {
  if (status === 429) throw new XOAuthError("X rate-limited the token request (429).", "rate_limited", status);
  if (status === 400 || status === 401) {
    // X answers 400 invalid_request / invalid_grant for a used, expired or revoked code or refresh token.
    throw new XOAuthError(`X refused the token request (${status}): ${body.slice(0, 200)}`, "invalid_grant", status);
  }
  if (status < 200 || status >= 300) throw new XOAuthError(`X token request failed (${status}): ${body.slice(0, 200)}`, "other", status);
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new XOAuthError("X answered the token request with something that is not JSON.", "other", status);
  }
  const parsed = TokenResponse.safeParse(json);
  if (!parsed.success) throw new XOAuthError("X answered the token request in an unexpected shape.", "other", status);
  const { access_token, refresh_token, expires_in, scope } = parsed.data;
  return {
    accessToken: access_token,
    refreshToken: refresh_token ?? null,
    expiresAt: typeof expires_in === "number" && expires_in > 0 ? new Date(now.getTime() + expires_in * 1000) : null,
    scopes: (scope ?? "").split(/\s+/).filter(Boolean),
  };
}

/** Trades the code X handed back for tokens, proving the round trip with the verifier. */
export async function exchangeXCode(
  client: XOAuthClient,
  params: { code: string; verifier: string; redirectUri: string },
  options: CallOptions = {}
): Promise<XTokens> {
  const { status, body } = await postForm(
    X_TOKEN_URL,
    client,
    {
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: params.redirectUri,
      code_verifier: params.verifier,
      client_id: client.clientId,
    },
    options
  );
  return tokensFrom(status, body, options.now ?? new Date());
}

/**
 * A new access token from the refresh token. X rotates refresh tokens: the
 * answer carries a new one, and the old one stops working, so the caller
 * must store what this returns before anything else uses the connection.
 */
export async function refreshXTokens(client: XOAuthClient, refreshToken: string, options: CallOptions = {}): Promise<XTokens> {
  const { status, body } = await postForm(
    X_TOKEN_URL,
    client,
    { grant_type: "refresh_token", refresh_token: refreshToken, client_id: client.clientId },
    options
  );
  const tokens = tokensFrom(status, body, options.now ?? new Date());
  // An answer without a new refresh token keeps the old one usable.
  return tokens.refreshToken ? tokens : { ...tokens, refreshToken };
}

/** Revokes a token at X. Best effort: false when X did not confirm it (the row is deleted here either way). */
export async function revokeXToken(
  client: XOAuthClient,
  token: string,
  tokenTypeHint: "access_token" | "refresh_token",
  options: CallOptions = {}
): Promise<boolean> {
  try {
    const { status } = await postForm(X_REVOKE_URL, client, { token, token_type_hint: tokenTypeHint, client_id: client.clientId }, options);
    return status >= 200 && status < 300;
  } catch {
    return false;
  }
}

// ── Who connected ────────────────────────────────────────────────────────────

const MeResponse = z.object({
  data: z.object({ id: z.string().regex(/^\d{1,20}$/), username: z.string().regex(/^\w{1,15}$/), name: z.string().optional() }).passthrough(),
});

export interface XMe {
  id: string;
  /** As X spells it, without "@". */
  username: string;
}

/** The account the access token acts for (`GET /2/users/me`). One user read. */
export async function fetchXMe(accessToken: string, options: CallOptions = {}): Promise<XMe> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${X_API_BASE}/users/me`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      signal: AbortSignal.timeout(X_API_TIMEOUT_MS),
    });
  } catch (err) {
    throw new XOAuthError(`X did not answer: ${err instanceof Error ? err.message : String(err)}`, "other");
  }
  const body = await response.text().catch(() => "");
  if (response.status === 429) throw new XOAuthError("X rate-limited the account read (429).", "rate_limited", 429);
  if (response.status === 401) throw new XOAuthError("X refused the new token (401).", "invalid_grant", 401);
  if (!response.ok) throw new XOAuthError(`X account read failed (${response.status}): ${body.slice(0, 200)}`, "other", response.status);
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new XOAuthError("X answered the account read with something that is not JSON.", "other", response.status);
  }
  const parsed = MeResponse.safeParse(json);
  if (!parsed.success) throw new XOAuthError("X answered the account read in an unexpected shape.", "other", response.status);
  return { id: parsed.data.data.id, username: parsed.data.data.username };
}
