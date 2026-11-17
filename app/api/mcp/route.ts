import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { resolveCaller } from "@/lib/api-auth";
import { apiError, apiErrorResponse } from "@/lib/api-errors";
import { MCP_CORS_HEADERS, MCP_RESOURCE, mcpChallenge } from "@/lib/oauth/config";
import { createMcpServer } from "@/lib/tools/mcp";

/**
 * The MCP endpoint: Streamable HTTP, stateless, JSON responses
 * (docs/API.md "MCP"). Two credentials reach it, both as
 * `Authorization: Bearer …`:
 *
 * - an API key (`gtf_…`), which Claude Code, scripts and any client that
 *   can send a header use;
 * - an OAuth access token (`gtfat_…`) issued for this endpoint by this
 *   site's authorization server, which is how claude.ai and the Claude apps
 *   connect (a custom connector cannot send a header of its own).
 *
 * Without a credential, or with one that does not verify, the answer is 401
 * with `WWW-Authenticate: Bearer resource_metadata="…"` (MCP authorization,
 * RFC 9728 §5.1): that header is what makes Claude start its sign-in, and
 * where it learns which authorization server to use. The session cookie is
 * not accepted here: a browser never calls this.
 *
 * Each POST builds a server for its caller and answers through the SDK's
 * web-standard transport, which takes the route's Request and returns a
 * Response, so no adapter is needed. Stateless means no MCP session id and
 * no server-sent stream: GET (the optional notification stream) and DELETE
 * (ending a session) answer 405, as the spec allows. Every answer, the
 * preflight (OPTIONS) and the 401 included, carries CORS headers
 * (`MCP_CORS_HEADERS`), so a browser-based client can connect.
 */
export const maxDuration = 120;

/** `response` with the MCP endpoint's CORS headers (lib/oauth/config.ts), whatever it answered. */
function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(MCP_CORS_HEADERS)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export async function POST(request: Request) {
  return withCors(await handle(request));
}

async function handle(request: Request): Promise<Response> {
  const resolved = await resolveCaller(request, { allowSession: false, oauthResource: MCP_RESOURCE });
  if (!resolved.ok) {
    return apiErrorResponse(
      resolved.status,
      resolved.error,
      resolved.status === 401
        ? { "WWW-Authenticate": mcpChallenge({ invalidToken: Boolean(request.headers.get("authorization")) }) }
        : undefined
    );
  }

  const server = createMcpServer(resolved.caller);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    // With JSON responses the answer is complete once handleRequest returns.
    await server.close().catch(() => undefined);
  }
}

function methodNotAllowed() {
  return withCors(
    apiErrorResponse(
      405,
      apiError("invalid_input", "This MCP endpoint is stateless: send JSON-RPC requests with POST."),
      { Allow: "POST, OPTIONS" }
    )
  );
}

export const GET = methodNotAllowed;
export const DELETE = methodNotAllowed;

/** The CORS preflight: 204 with the headers a browser needs before the POST. */
export function OPTIONS() {
  return new Response(null, { status: 204, headers: MCP_CORS_HEADERS });
}
