import { createAdminClient } from "@/lib/supabase/admin";
import { authenticateClient } from "@/lib/oauth/clients";
import { clientCredentials, oauthError, oauthJson, preflight, readParams, repeated } from "@/lib/oauth/http";
import { exchangeAuthorizationCode, refreshAccessToken } from "@/lib/oauth/tokens";

/**
 * The token endpoint (RFC 6749 §3.2): `authorization_code` with PKCE S256,
 * and `refresh_token` with rotation (lib/oauth/tokens.ts). Form-encoded, as
 * Claude sends it; a JSON body is read too. The client authenticates the
 * way it registered: by naming itself (a public client), or with its secret
 * in the body or in HTTP Basic (a confidential one).
 *
 * Refusals are RFC 6749 §5.2 errors; a refresh token that no longer works is
 * `invalid_grant`, which is what tells Claude to sign in again. Nothing here
 * logs a code or a token.
 */

const SINGLE_VALUED = ["grant_type", "code", "redirect_uri", "code_verifier", "refresh_token", "scope", "client_id", "client_secret"];

export async function POST(request: Request) {
  const params = await readParams(request);
  if (!params) return oauthError(400, "invalid_request", "Send the parameters form-encoded.");
  const twice = repeated(params, SINGLE_VALUED);
  if (twice) return oauthError(400, "invalid_request", `${twice} was sent more than once.`);

  const grantType = params.get("grant_type");
  if (grantType !== "authorization_code" && grantType !== "refresh_token") {
    return oauthError(400, "unsupported_grant_type", "grant_type must be authorization_code or refresh_token.");
  }

  const credentials = clientCredentials(request, params);
  if (!credentials.ok) return oauthError(400, "invalid_request", credentials.description);

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return oauthError(503, "temporarily_unavailable", "The token endpoint is not available right now.");
  }
  const authenticated = await authenticateClient(admin, credentials);
  if (!authenticated.ok) {
    return oauthError(401, "invalid_client", authenticated.description, { "WWW-Authenticate": 'Basic realm="gettrafficfast"' });
  }

  const result =
    grantType === "authorization_code"
      ? await exchangeAuthorizationCode(admin, authenticated.client, params)
      : await refreshAccessToken(admin, authenticated.client, params);
  if (!result.ok) return oauthError(result.status, result.error, result.description);
  return oauthJson(result.body);
}

export const OPTIONS = preflight;
