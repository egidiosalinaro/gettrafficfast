import { API_KEY_SCOPES } from "@/lib/api-keys";
import { SITE_URL } from "@/lib/site";

/**
 * The authorization server this app runs for its own MCP endpoint
 * (docs/API.md "Connect from claude.ai"), in one place: who issues tokens,
 * for which resource, where the endpoints are, how long things live.
 *
 * Every URL is built from SITE_URL, never from the request: the issuer and
 * the resource are identities a client compares byte for byte, and a
 * deployment URL (VERCEL_URL) sits behind the auth wall (lib/site.ts).
 *
 * Claude's connector client reads the protected resource metadata, takes the
 * FIRST authorization server it lists, reads that server's RFC 8414
 * metadata, registers itself (RFC 7591, since we do not advertise Client ID
 * Metadata Documents), and runs the authorization code flow with PKCE S256
 * and the `resource` parameter (RFC 8707). Requirements as verified on
 * 2026-11-10: https://claude.com/docs/connectors/building/authentication.
 */

/** The issuer: this site's origin, no path, so its metadata lives at /.well-known/oauth-authorization-server. */
export const OAUTH_ISSUER = SITE_URL;

/**
 * The one protected resource, the MCP endpoint, exactly as a person types it
 * into Claude. Claude requires the metadata's `resource` to equal it, and a
 * token is accepted only by the resource it was issued for.
 */
export const MCP_RESOURCE = `${SITE_URL}/api/mcp`;

export const OAUTH_PATHS = {
  authorize: "/oauth/authorize",
  decision: "/oauth/authorize/decision",
  token: "/oauth/token",
  register: "/oauth/register",
  revoke: "/oauth/revoke",
  /** RFC 9728 §3.1: the well-known prefix inserted before the resource's path. */
  protectedResource: "/.well-known/oauth-protected-resource/api/mcp",
  protectedResourceRoot: "/.well-known/oauth-protected-resource",
  authorizationServer: "/.well-known/oauth-authorization-server",
} as const;

/** Where a 401 from the MCP endpoint points (`resource_metadata`). */
export const PROTECTED_RESOURCE_METADATA_URL = `${SITE_URL}${OAUTH_PATHS.protectedResource}`;

/**
 * The permissions a grant can carry: the API keys' scopes, with the same
 * meaning (docs/API.md "Scopes"). Advertised in full, so a client asks for
 * all four; the consent screen ticks `read` and `write` only, and `spend`
 * and `publish` are granted only when the person ticks them.
 */
export const OAUTH_SCOPES = API_KEY_SCOPES;

/** Lifetimes. Claude refreshes on a 401 and up to five minutes before expiry. */
export const AUTHORIZATION_CODE_TTL_MS = 5 * 60_000;
export const ACCESS_TOKEN_TTL_MS = 60 * 60_000;
/** Idle lifetime: each refresh starts a new 30 days, so a connection in use stays connected. */
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60_000;

/** Live grants one account may hold, like MAX_ACTIVE_API_KEYS: per-grant caps times this bounds what OAuth can reach. */
export const MAX_LIVE_GRANTS = 20;

/**
 * Dynamic client registrations one IP address may make in an hour. Generous
 * on purpose: Claude registers a client on every fresh connection, and all
 * of claude.ai's registrations come from Anthropic's egress range.
 */
export const REGISTRATIONS_PER_IP_PER_HOUR = 60;

/** `last_used_at` is written at most once a minute per token, as for API keys. */
export const LAST_USED_RESOLUTION_MS = 60_000;

/**
 * CORS for the machine endpoints (metadata, registration, token,
 * revocation): a browser-based MCP client reads them cross-origin. None of
 * them reads a cookie, so allowing any origin grants nothing.
 */
export const OAUTH_CORS_HEADERS: Readonly<Record<string, string>> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version",
  "Access-Control-Max-Age": "86400",
};

/**
 * CORS for the MCP endpoint itself (app/api/mcp/route.ts), on the preflight
 * and on every answer, 401 included: a browser-based MCP client, or a
 * registry's inspector, calls it cross-origin and must be able to read the
 * `WWW-Authenticate` that starts sign-in. The credential is a Bearer header,
 * never a cookie, so allowing any origin grants nothing. The session
 * headers are allowed and exposed for clients that send them, though this
 * stateless server issues none.
 */
export const MCP_CORS_HEADERS: Readonly<Record<string, string>> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID, x-gtf-business",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, WWW-Authenticate",
  "Access-Control-Max-Age": "86400",
};

/** RFC 9728 protected resource metadata for the MCP endpoint. */
export function protectedResourceMetadata() {
  return {
    resource: MCP_RESOURCE,
    authorization_servers: [OAUTH_ISSUER],
    scopes_supported: [...OAUTH_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "GetTrafficFast",
  };
}

/** RFC 8414 authorization server metadata. No implicit flow, no plain PKCE, no CIMD. */
export function authorizationServerMetadata() {
  return {
    issuer: OAUTH_ISSUER,
    authorization_endpoint: `${OAUTH_ISSUER}${OAUTH_PATHS.authorize}`,
    token_endpoint: `${OAUTH_ISSUER}${OAUTH_PATHS.token}`,
    registration_endpoint: `${OAUTH_ISSUER}${OAUTH_PATHS.register}`,
    revocation_endpoint: `${OAUTH_ISSUER}${OAUTH_PATHS.revoke}`,
    scopes_supported: [...OAUTH_SCOPES],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    revocation_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    code_challenge_methods_supported: ["S256"],
    authorization_response_iss_parameter_supported: true,
  };
}

/**
 * The `WWW-Authenticate` value of a 401 from the MCP endpoint (RFC 6750 §3,
 * RFC 9728 §5.1). `resource_metadata` is how Claude finds the authorization
 * server; `error="invalid_token"` is added when a token was sent and refused.
 * No `scope`: Claude then asks for every scope the metadata lists, and the
 * person chooses on the consent screen.
 */
export function mcpChallenge(options: { invalidToken?: boolean } = {}): string {
  const parts = [`realm="gettrafficfast"`];
  if (options.invalidToken) parts.push(`error="invalid_token"`);
  parts.push(`resource_metadata="${PROTECTED_RESOURCE_METADATA_URL}"`);
  return `Bearer ${parts.join(", ")}`;
}

/** True when `value` names the MCP endpoint (a trailing slash allowed). */
export function isMcpResource(value: string): boolean {
  return value.replace(/\/+$/, "") === MCP_RESOURCE;
}
