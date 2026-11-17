import { OAUTH_CORS_HEADERS, authorizationServerMetadata } from "@/lib/oauth/config";
import { preflight } from "@/lib/oauth/http";

/**
 * RFC 8414 authorization server metadata. The issuer is this site's origin
 * with no path, so this is its one well-known location. Claude reads it
 * after the protected resource metadata names the issuer, and a client
 * following the MCP spec refuses to go on unless
 * `code_challenge_methods_supported` lists S256. Public, no I/O.
 */
export function GET() {
  return Response.json(authorizationServerMetadata(), {
    headers: { ...OAUTH_CORS_HEADERS, "Cache-Control": "public, max-age=300" },
  });
}

export const OPTIONS = preflight;
