import type { SupabaseClient } from "@supabase/supabase-js";
import { REGISTRATIONS_PER_IP_PER_HOUR } from "./config";
import { generateSecret, isSecretOf, matchesDigest, sha256Hex } from "./crypto";

/**
 * OAuth clients: dynamic client registration (RFC 7591), the lookup the
 * other endpoints make, the redirect URI rule, and client authentication.
 *
 * Claude registers itself here on every fresh connection (we advertise no
 * Client ID Metadata Document support, so it falls back to DCR), as a public
 * client: no secret, PKCE on every authorization. A client that registers as
 * confidential (`client_secret_post` or `client_secret_basic`) gets a secret
 * once, in the registration response; the table keeps its SHA-256.
 *
 * Redirect URIs: https, or http on a loopback address for a native client
 * (MCP authorization spec: "All redirect URIs MUST be either localhost or use
 * HTTPS"). They are compared exactly, except that the port of a loopback
 * URI is ignored (RFC 8252 §7.3): Claude Code listens on a new port each
 * session. The table checks the same rule (oauth_redirect_uris_ok).
 */

export const CLIENT_COLUMNS = "client_id, client_name, redirect_uris, token_endpoint_auth_method, client_secret_hash";

export type TokenEndpointAuthMethod = "none" | "client_secret_post" | "client_secret_basic";
const AUTH_METHODS: readonly TokenEndpointAuthMethod[] = ["none", "client_secret_post", "client_secret_basic"];

export const CLIENT_NAME_MAX = 100;
export const MAX_REDIRECT_URIS = 10;
const REDIRECT_URI_MAX = 2000;
const HOUR_MS = 60 * 60_000;

/** What a client asking for a name gets when it sent none. */
export const UNNAMED_CLIENT = "An app with no name";

export interface OAuthClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  authMethod: TokenEndpointAuthMethod;
  /** Null for a public client. */
  secretHash: string | null;
}

type Row = Record<string, unknown>;

export function mapClient(row: Row): OAuthClient {
  const method = row.token_endpoint_auth_method as TokenEndpointAuthMethod;
  return {
    clientId: row.client_id as string,
    clientName: (row.client_name as string) || UNNAMED_CLIENT,
    redirectUris: Array.isArray(row.redirect_uris) ? (row.redirect_uris as string[]) : [],
    authMethod: AUTH_METHODS.includes(method) ? method : "none",
    secretHash: (row.client_secret_hash as string | null) ?? null,
  };
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function parse(uri: string): URL | null {
  try {
    return new URL(uri);
  } catch {
    return null;
  }
}

function isLoopback(url: URL): boolean {
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
}

/**
 * Why a redirect URI cannot be registered, or null when it can: absolute,
 * https (or http on localhost, 127.0.0.1 or [::1]), no fragment, no
 * user name or password in it.
 */
export function redirectUriProblem(uri: unknown): string | null {
  if (typeof uri !== "string" || uri.length === 0) return "a redirect URI must be a non-empty string";
  if (uri.length > REDIRECT_URI_MAX) return `a redirect URI may be at most ${REDIRECT_URI_MAX} characters`;
  if (/\s/.test(uri)) return "a redirect URI may not contain spaces";
  const url = parse(uri);
  if (!url) return `${uri} is not an absolute URL`;
  if (uri.includes("#")) return `${uri} has a fragment, which a redirect URI may not have`;
  if (url.username || url.password) return `${uri} carries a user name or password`;
  if (url.protocol === "https:") return null;
  if (isLoopback(url)) return null;
  return `${uri} must use https (http only on localhost, 127.0.0.1 or [::1])`;
}

/**
 * True when `presented` is one of the client's redirect URIs: the same
 * string, or, for a loopback http URI, the same but for the port.
 */
export function redirectUriMatches(registered: readonly string[], presented: string): boolean {
  if (registered.includes(presented)) return true;
  const url = parse(presented);
  if (!url || !isLoopback(url)) return false;
  return registered.some((candidate) => {
    const other = parse(candidate);
    return (
      other !== null &&
      isLoopback(other) &&
      other.hostname === url.hostname &&
      other.pathname === url.pathname &&
      other.search === url.search
    );
  });
}

export interface ClientRegistration {
  clientName: string;
  redirectUris: string[];
  authMethod: TokenEndpointAuthMethod;
}

export type RegistrationCheck =
  | { ok: true; registration: ClientRegistration }
  | { ok: false; error: "invalid_redirect_uri" | "invalid_client_metadata"; description: string };

const invalid = (description: string): RegistrationCheck => ({ ok: false, error: "invalid_client_metadata", description });

/**
 * RFC 7591 §2 client metadata, checked. Only what this server uses is read;
 * other fields are ignored (a logo or a home page would only help an app
 * look like another on the consent screen). `token_endpoint_auth_method`
 * defaults to `none` rather than RFC 7591's `client_secret_basic`: every
 * MCP client we know registers as public, and one that omits the field and
 * then sends no secret would otherwise fail at the token endpoint.
 */
export function checkRegistration(body: unknown): RegistrationCheck {
  if (!body || typeof body !== "object" || Array.isArray(body)) return invalid("Send the client metadata as a JSON object.");
  const metadata = body as Record<string, unknown>;

  const uris = metadata.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0) {
    return { ok: false, error: "invalid_redirect_uri", description: "redirect_uris is required: at least one URI." };
  }
  if (uris.length > MAX_REDIRECT_URIS) {
    return { ok: false, error: "invalid_redirect_uri", description: `At most ${MAX_REDIRECT_URIS} redirect URIs.` };
  }
  for (const uri of uris) {
    const problem = redirectUriProblem(uri);
    if (problem) return { ok: false, error: "invalid_redirect_uri", description: problem };
  }

  const method = metadata.token_endpoint_auth_method ?? "none";
  if (!AUTH_METHODS.includes(method as TokenEndpointAuthMethod)) {
    return invalid(`token_endpoint_auth_method must be one of ${AUTH_METHODS.join(", ")}.`);
  }

  const grantTypes = metadata.grant_types ?? ["authorization_code"];
  if (!Array.isArray(grantTypes) || grantTypes.some((g) => g !== "authorization_code" && g !== "refresh_token")) {
    return invalid("grant_types may name authorization_code and refresh_token only.");
  }
  if (!grantTypes.includes("authorization_code")) return invalid("grant_types must include authorization_code.");

  const responseTypes = metadata.response_types ?? ["code"];
  if (!Array.isArray(responseTypes) || responseTypes.some((r) => r !== "code")) {
    return invalid("response_types may name code only: there is no implicit flow.");
  }

  const rawName = metadata.client_name;
  if (rawName !== undefined && typeof rawName !== "string") return invalid("client_name must be a string.");
  // Control characters out, whitespace collapsed: the name is shown to a person.
  const clientName = (rawName ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, CLIENT_NAME_MAX);

  return {
    ok: true,
    registration: {
      clientName: clientName || UNNAMED_CLIENT,
      redirectUris: [...new Set(uris as string[])],
      authMethod: method as TokenEndpointAuthMethod,
    },
  };
}

/** The hashed address a registration is counted under: enough to rate-limit, not to keep an address. */
export function registrationSource(ip: string): string {
  return sha256Hex(`oauth-registration:${ip}`);
}

export type RegisterResult =
  | { ok: true; status: 201; body: Record<string, unknown> }
  | { ok: false; status: 400 | 429 | 500; error: string; description: string };

/**
 * Registers a client: checks the metadata, holds one address to
 * REGISTRATIONS_PER_IP_PER_HOUR, stores the client (and the hash of its
 * secret, if confidential) and answers RFC 7591 §3.2.1's response. The
 * secret is in that response and nowhere else.
 */
export async function registerClient(
  admin: SupabaseClient,
  input: { body: unknown; ip: string; now?: Date }
): Promise<RegisterResult> {
  const checked = checkRegistration(input.body);
  if (!checked.ok) return { ok: false, status: 400, error: checked.error, description: checked.description };
  const now = input.now ?? new Date();
  const source = registrationSource(input.ip);

  const { count, error: countError } = await admin
    .from("oauth_clients")
    .select("client_id", { count: "exact", head: true })
    .eq("registered_from", source)
    .gte("created_at", new Date(now.getTime() - HOUR_MS).toISOString());
  if (countError) return { ok: false, status: 500, error: "server_error", description: "Registration is not available right now." };
  if ((count ?? 0) >= REGISTRATIONS_PER_IP_PER_HOUR) {
    return {
      ok: false,
      status: 429,
      error: "temporarily_unavailable",
      description: `This address registered ${REGISTRATIONS_PER_IP_PER_HOUR} clients in the last hour. Try again later.`,
    };
  }

  const { registration } = checked;
  const clientId = generateSecret("client");
  const secret = registration.authMethod === "none" ? null : generateSecret("clientSecret");
  const { error } = await admin.from("oauth_clients").insert({
    client_id: clientId,
    client_name: registration.clientName,
    redirect_uris: registration.redirectUris,
    token_endpoint_auth_method: registration.authMethod,
    client_secret_hash: secret ? sha256Hex(secret) : null,
    registered_from: source,
    created_at: now.toISOString(),
  });
  if (error) {
    console.error(JSON.stringify({ level: "error", event: "oauth.register_failed", error: error.message.slice(0, 300) }));
    return { ok: false, status: 500, error: "server_error", description: "The client could not be registered." };
  }

  return {
    ok: true,
    status: 201,
    body: {
      client_id: clientId,
      client_id_issued_at: Math.floor(now.getTime() / 1000),
      client_name: registration.clientName,
      redirect_uris: registration.redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: registration.authMethod,
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    },
  };
}

/** A registered client, or null (unknown, malformed, or the table cannot be read: fails closed). */
export async function findClient(admin: SupabaseClient, clientId: unknown): Promise<OAuthClient | null> {
  if (!isSecretOf("client", clientId)) return null;
  const { data, error } = await admin.from("oauth_clients").select(CLIENT_COLUMNS).eq("client_id", clientId).maybeSingle();
  if (error || !data) return null;
  return mapClient(data as Row);
}

export type ClientAuthentication = { ok: true; client: OAuthClient } | { ok: false; description: string };

/**
 * Who is calling the token or revocation endpoint (RFC 6749 §2.3). A public
 * client names itself; a confidential one proves it with its secret,
 * compared in constant time, sent the way it registered or the other
 * standard way. A secret sent by a public client is ignored.
 */
export async function authenticateClient(
  admin: SupabaseClient,
  credentials: { clientId: string | null; clientSecret: string | null }
): Promise<ClientAuthentication> {
  const client = await findClient(admin, credentials.clientId);
  if (!client) return { ok: false, description: "Unknown client." };
  if (client.authMethod === "none") return { ok: true, client };
  if (!credentials.clientSecret || !matchesDigest(client.secretHash, credentials.clientSecret)) {
    return { ok: false, description: "This client must authenticate with its client secret." };
  }
  return { ok: true, client };
}
