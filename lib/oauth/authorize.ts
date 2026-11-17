import type { SupabaseClient } from "@supabase/supabase-js";
import { isApiKeyScope, type ApiKeyScope } from "@/lib/api-keys";
import {
  AUTHORIZATION_CODE_TTL_MS,
  MAX_LIVE_GRANTS,
  MCP_RESOURCE,
  OAUTH_ISSUER,
  OAUTH_PATHS,
  OAUTH_SCOPES,
  isMcpResource,
} from "./config";
import { findClient, redirectUriMatches, type OAuthClient } from "./clients";
import { CHALLENGE_PATTERN, generateSecret, sha256Hex } from "./crypto";
import { countLiveGrants } from "./tokens";

/**
 * The authorization endpoint (RFC 6749 §4.1.1, OAuth 2.1): check the
 * request, make sure a person is signed in, show them the consent screen
 * (app/oauth/authorize/page.tsx), and turn their decision into a code
 * (app/oauth/authorize/decision/route.ts).
 *
 * The order matters. An unknown client, or a redirect URI the client did
 * not register, is shown to the person and never redirected to: sending an
 * error to an unverified address is an open redirect. Every other problem is
 * sent back to the client's verified redirect URI with `error` and the
 * `state` it sent (RFC 6749 §4.1.2.1).
 *
 * Only the authorization code flow, only PKCE S256: no implicit flow, no
 * plain challenge. The `resource` (RFC 8707), when sent, must be the MCP
 * endpoint, the one resource this server issues tokens for.
 *
 * What the person grants is what they tick: `read` and `write` start ticked
 * when the client asked for them, `spend` and `publish` never do, and a
 * scope the client did not ask for cannot be granted. As with API keys,
 * spending and publishing are the person's choice, never a default
 * (AGENTS.md §12).
 */

/** The parameters of an authorization request, as the consent form carries them back. */
export const AUTHORIZATION_PARAMS = [
  "response_type",
  "client_id",
  "redirect_uri",
  "scope",
  "state",
  "code_challenge",
  "code_challenge_method",
  "resource",
] as const;

/** The state a client sends back to itself. Bounded, so a link cannot carry a novel. */
const STATE_MAX = 2000;

export interface AuthorizationRequest {
  client: OAuthClient;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  /** What the client asked for, among the scopes that exist; every scope when it named none of them. */
  requestedScopes: ApiKeyScope[];
  resource: string;
}

export type AuthorizationCheck =
  | { ok: true; request: AuthorizationRequest }
  /** Shown to the person; never sent anywhere. */
  | { ok: false; kind: "page"; message: string }
  /** An error the client receives at its verified redirect URI. */
  | { ok: false; kind: "redirect"; location: string };

type ParamSource = URLSearchParams | Record<string, string | string[] | undefined>;

function toParams(source: ParamSource): URLSearchParams {
  if (source instanceof URLSearchParams) return source;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(source)) {
    if (Array.isArray(value)) for (const item of value) params.append(key, item);
    else if (typeof value === "string") params.append(key, value);
  }
  return params;
}

/** `redirectUri` with `params` added, and `iss` (RFC 9207) so the client knows who answered. */
export function clientRedirect(redirectUri: string, params: Record<string, string | null>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null) url.searchParams.set(key, value);
  }
  url.searchParams.set("iss", OAUTH_ISSUER);
  return url.toString();
}

/**
 * The known scopes in a space-separated scope string, in the canonical
 * order. Unknown values (`offline_access`, `openid`, a client's own) are
 * ignored, as RFC 6749 §3.3 allows: a refresh token is issued regardless.
 * Null when the string names no scope this server has.
 */
export function parseScopes(scope: string | null | undefined): ApiKeyScope[] | null {
  const asked = new Set((scope ?? "").split(/\s+/).filter(isApiKeyScope));
  const known = OAUTH_SCOPES.filter((s) => asked.has(s));
  return known.length > 0 ? known : null;
}

/** The scopes the consent screen ticks: `read` and `write` when asked for. Never `spend` or `publish`. */
export function defaultGrantedScopes(requested: readonly ApiKeyScope[]): ApiKeyScope[] {
  return requested.filter((scope) => scope === "read" || scope === "write");
}

/** Checks an authorization request in the order RFC 6749 §4.1.2.1 asks for. */
export async function checkAuthorizationRequest(source: ParamSource, deps: { admin: SupabaseClient }): Promise<AuthorizationCheck> {
  const params = toParams(source);
  const twice = AUTHORIZATION_PARAMS.find((name) => params.getAll(name).length > 1);
  const get = (name: string) => params.get(name);

  const client = await findClient(deps.admin, get("client_id"));
  if (!client) {
    return {
      ok: false,
      kind: "page",
      message: "The app that sent you here is not registered with GetTrafficFast. Go back to it and connect again.",
    };
  }
  const redirectUri = get("redirect_uri");
  if (!redirectUri || params.getAll("redirect_uri").length > 1 || !redirectUriMatches(client.redirectUris, redirectUri)) {
    return {
      ok: false,
      kind: "page",
      message: `The address ${client.clientName} asked to send you back to is not one it registered, so nothing was sent there.`,
    };
  }

  const state = params.getAll("state").length === 1 ? get("state") : null;
  const fail = (error: string, description: string): AuthorizationCheck => ({
    ok: false,
    kind: "redirect",
    location: clientRedirect(redirectUri, { error, error_description: description, state }),
  });

  if (twice) return fail("invalid_request", `${twice} was sent more than once.`);
  if (state !== null && state.length > STATE_MAX) return fail("invalid_request", `state may be at most ${STATE_MAX} characters.`);
  if (get("response_type") !== "code") {
    return fail("unsupported_response_type", "Only the authorization code flow (response_type=code) is supported.");
  }
  const codeChallenge = get("code_challenge");
  if (!codeChallenge) return fail("invalid_request", "PKCE is required: send code_challenge with code_challenge_method=S256.");
  if (get("code_challenge_method") !== "S256") return fail("invalid_request", "code_challenge_method must be S256.");
  if (!CHALLENGE_PATTERN.test(codeChallenge)) return fail("invalid_request", "code_challenge is not an S256 challenge.");

  const resourceParam = get("resource");
  if (resourceParam !== null && !isMcpResource(resourceParam)) {
    return fail("invalid_target", `This server issues tokens for ${MCP_RESOURCE} only.`);
  }

  return {
    ok: true,
    request: {
      client,
      redirectUri,
      state,
      codeChallenge,
      requestedScopes: parseScopes(get("scope")) ?? [...OAUTH_SCOPES],
      resource: MCP_RESOURCE,
    },
  };
}

/** The authorization request's own parameters, to carry through sign-in and the consent form. */
export function authorizationQuery(source: ParamSource): URLSearchParams {
  const params = toParams(source);
  const query = new URLSearchParams();
  for (const name of AUTHORIZATION_PARAMS) {
    for (const value of params.getAll(name)) query.append(name, value);
  }
  return query;
}

/** Sign-in, then back to this same authorization request (`next` is a path on this site: lib/app-home.ts). */
export function signInLocation(source: ParamSource): string {
  const next = `${OAUTH_PATHS.authorize}?${authorizationQuery(source).toString()}`;
  return `/auth/sign-up?next=${encodeURIComponent(next)}`;
}

export type ConsentStep =
  | { kind: "page"; message: string }
  | { kind: "redirect"; location: string }
  | { kind: "consent"; request: AuthorizationRequest; defaults: ApiKeyScope[] };

/**
 * What the authorization endpoint does with a request: an error page, a
 * redirect (an error back to the client, or sign-in for a person who is not
 * signed in), or the consent screen. A session is required before anything
 * is shown or granted.
 */
export async function prepareConsent(
  source: ParamSource,
  deps: { admin: SupabaseClient; userId: string | null }
): Promise<ConsentStep> {
  const checked = await checkAuthorizationRequest(source, deps);
  if (!checked.ok) return checked.kind === "page" ? { kind: "page", message: checked.message } : { kind: "redirect", location: checked.location };
  if (!deps.userId) return { kind: "redirect", location: signInLocation(source) };
  return { kind: "consent", request: checked.request, defaults: defaultGrantedScopes(checked.request.requestedScopes) };
}

/** Why the consent screen is shown again, with the request unchanged. */
export const CONSENT_NOTICES = {
  choose_scope: "Tick at least one permission, or choose Deny.",
  choose_site: "Choose one of your sites, or all of them.",
  too_many_apps: `You have ${MAX_LIVE_GRANTS} connected apps, the most an account can have. Revoke one you no longer use in Settings → Claude and API, then try again.`,
  unavailable: "Your connected apps could not be read just now. Try again in a moment.",
} as const;

export type ConsentNotice = keyof typeof CONSENT_NOTICES;

/** The consent screen again, for the same request, with a notice. */
export function consentLocation(source: ParamSource, notice?: ConsentNotice): string {
  const query = authorizationQuery(source);
  if (notice) query.set("notice", notice);
  return `${OAUTH_PATHS.authorize}?${query.toString()}`;
}

/**
 * The person's answer on the consent screen, as the form posts it:
 * the request's own parameters, `decision` (allow or deny), `grant` once per
 * ticked scope, and `site` (`all`, or one of their sites' ids). Always a
 * place to send the browser: the client's redirect URI with a code or an
 * error, or the consent screen again (which shows its own error when the
 * request itself is wrong).
 *
 * Allow mints a code for exactly the ticked scopes the client asked for and
 * the chosen site, stores its SHA-256 with the PKCE challenge, the redirect
 * URI and the resource, and sends the code back with the client's `state`.
 * Deny sends `access_denied`.
 */
export async function decideConsent(
  form: URLSearchParams,
  deps: { admin: SupabaseClient; userId: string; ownedBusinessIds: readonly string[]; now?: Date }
): Promise<{ location: string }> {
  const checked = await checkAuthorizationRequest(form, deps);
  if (!checked.ok) return { location: checked.kind === "page" ? consentLocation(form) : checked.location };
  const { request } = checked;

  if (form.get("decision") !== "allow") {
    return {
      location: clientRedirect(request.redirectUri, {
        error: "access_denied",
        error_description: "The person declined to connect.",
        state: request.state,
      }),
    };
  }

  const ticked = new Set(form.getAll("grant"));
  const scopes = request.requestedScopes.filter((scope) => ticked.has(scope));
  if (scopes.length === 0) return { location: consentLocation(form, "choose_scope") };

  const site = form.get("site") ?? "";
  let businessId: string | null = null;
  if (site !== "all") {
    if (!deps.ownedBusinessIds.includes(site)) return { location: consentLocation(form, "choose_site") };
    businessId = site;
  }

  const now = deps.now ?? new Date();
  const live = await countLiveGrants(deps.admin, deps.userId, now);
  if (live === null) return { location: consentLocation(form, "unavailable") };
  if (live >= MAX_LIVE_GRANTS) return { location: consentLocation(form, "too_many_apps") };

  const code = generateSecret("code");
  const { error } = await deps.admin.from("oauth_authorization_codes").insert({
    code_hash: sha256Hex(code),
    client_id: request.client.clientId,
    user_id: deps.userId,
    business_id: businessId,
    scopes,
    code_challenge: request.codeChallenge,
    code_challenge_method: "S256",
    redirect_uri: request.redirectUri,
    resource: request.resource,
    expires_at: new Date(now.getTime() + AUTHORIZATION_CODE_TTL_MS).toISOString(),
    created_at: now.toISOString(),
  });
  if (error) {
    console.error(JSON.stringify({ level: "error", event: "oauth.code_not_stored", error: error.message.slice(0, 300) }));
    return {
      location: clientRedirect(request.redirectUri, {
        error: "server_error",
        error_description: "The authorization could not be saved. Try connecting again.",
        state: request.state,
      }),
    };
  }

  return { location: clientRedirect(request.redirectUri, { code, state: request.state }) };
}
