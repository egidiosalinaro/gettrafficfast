import { createAdminClient } from "@/lib/supabase/admin";
import { authenticateClient } from "@/lib/oauth/clients";
import { clientCredentials, oauthError, preflight, readParams } from "@/lib/oauth/http";
import { revokePresentedToken } from "@/lib/oauth/tokens";
import { OAUTH_CORS_HEADERS } from "@/lib/oauth/config";

/**
 * Token revocation (RFC 7009): a client ends its own connection by sending
 * its access or refresh token. The whole grant goes, every token rotated
 * from the same consent, as Settings → API keys → Revoke does. The answer is
 * 200 whether or not the token was known (RFC 7009 §2.2): a client learns
 * nothing about tokens that are not its own.
 */
export async function POST(request: Request) {
  const params = await readParams(request);
  if (!params) return oauthError(400, "invalid_request", "Send the parameters form-encoded.");
  const credentials = clientCredentials(request, params);
  if (!credentials.ok) return oauthError(400, "invalid_request", credentials.description);

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return oauthError(503, "temporarily_unavailable", "Revocation is not available right now.");
  }
  const authenticated = await authenticateClient(admin, credentials);
  if (!authenticated.ok) {
    return oauthError(401, "invalid_client", authenticated.description, { "WWW-Authenticate": 'Basic realm="gettrafficfast"' });
  }
  const token = params.get("token");
  if (!token) return oauthError(400, "invalid_request", "Send the token to revoke.");

  await revokePresentedToken(admin, authenticated.client, token);
  return new Response(null, { status: 200, headers: { ...OAUTH_CORS_HEADERS, "Cache-Control": "no-store" } });
}

export const OPTIONS = preflight;
