import { createAdminClient } from "@/lib/supabase/admin";
import { registerClient } from "@/lib/oauth/clients";
import { callerIp, oauthError, oauthJson, preflight } from "@/lib/oauth/http";

/**
 * Dynamic client registration (RFC 7591): how Claude, and any MCP client,
 * becomes a client of this authorization server without anyone creating
 * one by hand. JSON in, JSON out, no authentication (an open registration
 * endpoint, as MCP clients expect), rate-limited per address
 * (lib/oauth/clients.ts). Registering grants nothing: every authorization
 * still needs a signed-in person's consent.
 */

const BODY_MAX = 16_384;

export async function POST(request: Request) {
  const text = await request.text().catch(() => "");
  if (text.length > BODY_MAX) return oauthError(400, "invalid_client_metadata", "The registration request is too large.");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return oauthError(400, "invalid_client_metadata", "Send the client metadata as JSON.");
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return oauthError(503, "temporarily_unavailable", "Registration is not available right now.");
  }
  const result = await registerClient(admin, { body, ip: callerIp(request) });
  if (!result.ok) {
    return oauthError(result.status, result.error, result.description, result.status === 429 ? { "Retry-After": "3600" } : {});
  }
  return oauthJson(result.body, result.status);
}

export const OPTIONS = preflight;
