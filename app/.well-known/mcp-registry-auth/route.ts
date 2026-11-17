import { MCP_REGISTRY_AUTH_ENV, mcpRegistryAuthLine } from "@/lib/distribution/mcp-registry-auth";

/**
 * The MCP Registry's domain proof (lib/distribution/mcp-registry-auth.ts,
 * docs/API.md, "Distribution"): the public-key line from
 * `MCP_REGISTRY_AUTH`, as plain text, or 404 when it is unset or not a
 * proof line. Public: `/.well-known/` is open in the middleware
 * (lib/public-paths.ts). Read per request, so adding or removing the
 * variable takes effect on the next deploy with no code change.
 */

export const dynamic = "force-dynamic";

export function GET(): Response {
  const line = mcpRegistryAuthLine(process.env[MCP_REGISTRY_AUTH_ENV]);
  if (line === null) {
    return new Response("Not found\n", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  return new Response(line, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=300" },
  });
}
