import { afterEach, describe, expect, it, vi } from "vitest";
import { mcpRegistryAuthLine } from "@/lib/distribution/mcp-registry-auth";
import { isPublicPath } from "@/lib/public-paths";
import { GET } from "@/app/.well-known/mcp-registry-auth/route";

/**
 * /.well-known/mcp-registry-auth serves the MCP Registry's domain proof from
 * MCP_REGISTRY_AUTH, and nothing when the variable is unset or not one
 * proof line: off by default, never a private key.
 */

const LINE = "v=MCPv1; k=ed25519; p=q2nJm3Xc0fV9v4c7aQm1o2pW8eZt5yLk3dRrU6sH0g4=";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("mcpRegistryAuthLine", () => {
  it("is null when the variable is unset or empty", () => {
    expect(mcpRegistryAuthLine(undefined)).toBeNull();
    expect(mcpRegistryAuthLine("")).toBeNull();
    expect(mcpRegistryAuthLine("   ")).toBeNull();
  });

  it("serves a proof line, trimmed", () => {
    expect(mcpRegistryAuthLine(`  ${LINE}\n`)).toBe(LINE);
  });

  it("refuses anything that is not one proof line", () => {
    expect(mcpRegistryAuthLine("-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIA==\n-----END PRIVATE KEY-----")).toBeNull();
    expect(mcpRegistryAuthLine(`${LINE}\n${LINE}`)).toBeNull();
    expect(mcpRegistryAuthLine("v=MCPv1; k=ed25519; p=")).toBeNull();
    expect(mcpRegistryAuthLine("hello")).toBeNull();
    expect(mcpRegistryAuthLine("v=MCPv1; k=ed25519; p=PRIVATEKEYAAAAAAAAAAAAAAAAAAAAAAAA=")).toBeNull();
  });
});

describe("GET /.well-known/mcp-registry-auth", () => {
  it("is 404 when MCP_REGISTRY_AUTH is unset", () => {
    vi.stubEnv("MCP_REGISTRY_AUTH", undefined);
    expect(GET().status).toBe(404);
  });

  it("is 404 when the value is not a proof line", () => {
    vi.stubEnv("MCP_REGISTRY_AUTH", "not a key");
    expect(GET().status).toBe(404);
  });

  it("serves the line as plain text when set", async () => {
    vi.stubEnv("MCP_REGISTRY_AUTH", LINE);
    const res = GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe(LINE);
  });

  it("is a public path: the registry fetches it with no session", () => {
    expect(isPublicPath("/.well-known/mcp-registry-auth")).toBe(true);
  });
});
