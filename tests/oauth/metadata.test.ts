import { describe, expect, it } from "vitest";
import { GET as protectedResourceRoot, OPTIONS as preflightRoot } from "@/app/.well-known/oauth-protected-resource/route";
import { GET as protectedResource } from "@/app/.well-known/oauth-protected-resource/api/mcp/route";
import { GET as authorizationServer } from "@/app/.well-known/oauth-authorization-server/route";
import { MCP_RESOURCE, PROTECTED_RESOURCE_METADATA_URL, mcpChallenge } from "@/lib/oauth/config";

/**
 * The discovery documents Claude reads before it can sign anyone in
 * (https://claude.com/docs/connectors/building/authentication). What is
 * pinned: the protected resource metadata names the MCP endpoint exactly as
 * a person types it, the issuer first, and the four scopes, at the
 * path-suffixed location the 401 points to and at the root; the
 * authorization server metadata offers the code flow only, PKCE S256 only,
 * dynamic registration, refresh and revocation, and does not advertise
 * Client ID Metadata Documents (Claude would pick CIMD over DCR if it did).
 */

describe("protected resource metadata (RFC 9728)", () => {
  it("names the MCP endpoint, this issuer and the scopes, at both locations", async () => {
    for (const handler of [protectedResource, protectedResourceRoot]) {
      const response = handler();
      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(await response.json()).toEqual({
        resource: "https://gettrafficfa.st/api/mcp",
        authorization_servers: ["https://gettrafficfa.st"],
        scopes_supported: ["read", "write", "spend", "publish"],
        bearer_methods_supported: ["header"],
        resource_name: "GetTrafficFast",
      });
    }
  });

  it("is where the MCP endpoint's 401 points", () => {
    expect(PROTECTED_RESOURCE_METADATA_URL).toBe("https://gettrafficfa.st/.well-known/oauth-protected-resource/api/mcp");
    expect(MCP_RESOURCE).toBe("https://gettrafficfa.st/api/mcp");
    expect(mcpChallenge()).toBe(
      'Bearer realm="gettrafficfast", resource_metadata="https://gettrafficfa.st/.well-known/oauth-protected-resource/api/mcp"'
    );
    expect(mcpChallenge({ invalidToken: true })).toContain('error="invalid_token"');
  });

  it("answers a CORS preflight", () => {
    const response = preflightRoot();
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toContain("GET");
  });
});

describe("authorization server metadata (RFC 8414)", () => {
  it("offers the code flow with PKCE S256, registration, refresh and revocation", async () => {
    const response = authorizationServer();
    expect(response.status).toBe(200);
    const metadata = await response.json();
    expect(metadata).toMatchObject({
      issuer: "https://gettrafficfa.st",
      authorization_endpoint: "https://gettrafficfa.st/oauth/authorize",
      token_endpoint: "https://gettrafficfa.st/oauth/token",
      registration_endpoint: "https://gettrafficfa.st/oauth/register",
      revocation_endpoint: "https://gettrafficfa.st/oauth/revoke",
      scopes_supported: ["read", "write", "spend", "publish"],
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      authorization_response_iss_parameter_supported: true,
    });
    expect(metadata.token_endpoint_auth_methods_supported).toEqual(["none", "client_secret_post", "client_secret_basic"]);
    // No implicit flow, no plain PKCE, no client credentials, no CIMD.
    expect(JSON.stringify(metadata)).not.toMatch(/"token"|"plain"|client_credentials|implicit/);
    expect(metadata).not.toHaveProperty("client_id_metadata_document_supported");
    // offline_access is not offered: a refresh token comes with every code exchange.
    expect(metadata.scopes_supported).not.toContain("offline_access");
  });
});
