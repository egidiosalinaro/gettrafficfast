import { OAUTH_CORS_HEADERS, protectedResourceMetadata } from "@/lib/oauth/config";
import { preflight } from "@/lib/oauth/http";

/**
 * RFC 9728 protected resource metadata for the MCP endpoint, at the root
 * well-known path. The path-suffixed copy
 * (`/.well-known/oauth-protected-resource/api/mcp`) is the one the MCP
 * endpoint's 401 points at and the one clients try first; this one is the
 * fallback Claude probes when a 401 carries no pointer. Public, no I/O.
 */
export function GET() {
  return Response.json(protectedResourceMetadata(), {
    headers: { ...OAUTH_CORS_HEADERS, "Cache-Control": "public, max-age=300" },
  });
}

export const OPTIONS = preflight;
