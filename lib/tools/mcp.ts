import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type GetPromptResult,
  type Tool as McpTool,
} from "@modelcontextprotocol/sdk/types.js";
import type { Caller } from "@/lib/api-auth";
import { BILLING_URL } from "@/lib/paid-access";
import { describeTool } from "./schema";
import { runTool, type RunToolDeps } from "./runner";
import { registryFor } from "./owner";
import { PROMPTS, describePrompt, renderPrompt } from "./prompts";
import { requiredScopes, type Tool } from "./tool";

/**
 * The MCP face of the tool registry (docs/API.md "MCP").
 *
 * The low-level `Server` rather than `McpServer`, on purpose: McpServer
 * validates input with its own copy of each schema and phrases its own
 * errors, while here the registry is the single source. `tools/list`
 * publishes the same JSON Schemas as `GET /api/v1/tools`, and `tools/call`
 * goes through `runTool`, the REST runner's path: same scopes, ownership
 * checks, paywall, validation and error codes.
 *
 * One server per request, for one caller: the endpoint is stateless (no MCP
 * session id), which is what a serverless function can honour.
 *
 * Prompts (`prompts/list`, `prompts/get`) are the routine as commands a
 * person picks in Claude (lib/tools/prompts.ts): text templates that call
 * no tool themselves.
 */

export const MCP_SERVER_NAME = "gettrafficfast";
export const MCP_SERVER_VERSION = "1.0.0";

export const MCP_INSTRUCTIONS = [
  "GetTrafficFast writes and publishes the articles that make a business findable, and finds conversations worth answering and drafts replies in its owner's voice.",
  "Every tool acts on one site. A connection may cover several: whoami lists them (businesses) and the default one (business, the oldest). Every site-scoped tool takes an optional site argument, the site's id, name or domain: when the connection covers several sites, use the site the person names, ask which one when they name none, and pass site on every call of that task. Without site, the default site; a connection limited to one site cannot reach another.",
  "The product never posts on X, Reddit or any social site: get_reply_intent_url gives the link a person opens to post on X, and mark_reply_posted records that they did.",
  "publish_article is the only tool that writes to the owner's own site: it needs the publish scope and confirm: true.",
  `Every tool needs an active plan on the GetTrafficFast account. Without one, every tool call answers with the error code subscription_required: do not retry it, and tell the person plainly that this GetTrafficFast account has no active plan, so its tools are unavailable, and that the account owner can manage the plan at ${BILLING_URL}. Listing tools and prompts works without a plan.`,
  "Tools marked paid also need the spend scope (ticked on the key, or on the consent screen when connecting), and count against daily caps; a key or a connected app may make 60 calls a minute.",
  "draft_reply, run_reply_discovery and generate_article return a jobId; get_job says how it ended.",
  "A call that would start spending (a visibility run or cadence, autopilot, images) is refused with confirmation_required until it is sent again with confirm: true: ask the person first.",
  "Two prompts run the routine: daily_routine (Today, one reply at a time) and weekly_review (Growth and Content); both take an optional site.",
].join(" ");

/** A registry tool as MCP's `tools/list` describes it. */
export function toMcpTool(tool: Tool): McpTool {
  const described = describeTool(tool);
  return {
    name: described.name,
    title: described.title,
    // Every customer tool needs a plan (the instructions say so once); a paid one also needs spend.
    description: tool.paid ? `${described.description} Paid: needs the spend scope and an active plan.` : described.description,
    inputSchema: described.inputSchema as McpTool["inputSchema"],
    outputSchema: described.outputSchema as McpTool["outputSchema"],
    annotations: {
      title: described.title,
      readOnlyHint: tool.scope === "read",
      // Nothing posts on a social site; the few that delete the customer's data say so.
      destructiveHint: tool.destructive === true,
      // A publish tool reaches outside the product: the customer's live site.
      openWorldHint: tool.scope === "publish",
    },
    _meta: {
      "gettrafficfast/scopes": described.scopes,
      "gettrafficfast/paid": tool.paid,
      "gettrafficfast/subscription": described.subscription,
    },
  };
}

/**
 * An MCP server for `caller`. `tools/list` shows what the caller's key may
 * call (a read-only key sees the read tools); `tools/call` refuses the rest
 * all the same. A platform owner's caller also sees the owner's tools
 * (`registryFor`, lib/tools/owner.ts); nobody else ever sees them listed.
 */
export function createMcpServer(caller: Caller, deps: RunToolDeps = {}): Server {
  const registry = deps.registry ?? registryFor(caller.userId);
  const server = new Server(
    { name: MCP_SERVER_NAME, title: "GetTrafficFast", version: MCP_SERVER_VERSION },
    { capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } }, instructions: MCP_INSTRUCTIONS }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: registry
      .list()
      .filter((tool) => requiredScopes(tool).every((scope) => caller.scopes.includes(scope)))
      .map(toMcpTool),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const run = await runTool(caller, request.params.name, request.params.arguments ?? {}, { ...deps, registry });
    if (!run.ok) {
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ error: run.error }) }],
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(run.output) }],
      structuredContent: run.output,
    };
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: PROMPTS.map(describePrompt) }));

  // An unknown name or a refused argument is a JSON-RPC error -32602, the spec's "Invalid params".
  server.setRequestHandler(GetPromptRequestSchema, async (request): Promise<GetPromptResult> => {
    const rendered = renderPrompt(request.params.name, request.params.arguments, caller);
    if (!rendered.ok) throw new McpError(ErrorCode.InvalidParams, rendered.message);
    return {
      description: rendered.description,
      messages: [{ role: "user", content: { type: "text", text: rendered.text } }],
    };
  });

  return server;
}
