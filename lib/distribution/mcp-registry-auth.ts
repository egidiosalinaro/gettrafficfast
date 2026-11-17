/**
 * The MCP Registry's HTTP domain proof (docs/API.md, "Distribution").
 *
 * To publish under the `st.gettrafficfa/…` namespace, the registry fetches
 * `https://gettrafficfa.st/.well-known/mcp-registry-auth` and expects one
 * line naming the PUBLIC half of the key the publisher signs with:
 * `v=MCPv1; k=ed25519; p=<base64 public key>`. The line comes from the
 * `MCP_REGISTRY_AUTH` env var and nowhere else; the private key never
 * reaches this repository or Vercel.
 *
 * Off by default: with the variable unset, or set to anything that is not a
 * single proof line, the route answers 404, so a stray value (a PEM block
 * pasted by mistake, two lines) is never served.
 */

export const MCP_REGISTRY_AUTH_ENV = "MCP_REGISTRY_AUTH";

/** One line: version, key type, base64 key. A PEM block or anything multi-line fails. */
const PROOF_LINE = /^v=MCPv1; k=[a-z0-9]{2,32}; p=[A-Za-z0-9+/]{16,512}={0,2}$/;

/** The proof line to serve, or null when there is none to serve. */
export function mcpRegistryAuthLine(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const line = raw.trim();
  if (line === "" || /PRIVATE/i.test(line)) return null;
  return PROOF_LINE.test(line) ? line : null;
}
