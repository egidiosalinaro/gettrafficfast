import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FakeSupabase } from "../support/fake-supabase";
import { SITE_A, SITE_B, USER, activePlan, apiCaller, businesses } from "./support";

/**
 * The two surfaces over the one registry. What is pinned: the REST runner
 * answers a tool's output as the body and every refusal as
 * `{ error: { code, message, hint? } }` (bad auth, bad JSON, unknown tool);
 * the catalogue lists every tool with its schemas; MCP's tools/list shows
 * what the key may call with the same schemas, and tools/call runs the
 * tool through the same runner, over the SDK's own client and through the
 * route's web-standard transport.
 */

const state = vi.hoisted(() => ({
  resolved: null as unknown,
}));
vi.mock("@/lib/api-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api-auth")>()),
  resolveCaller: async () => state.resolved,
}));

import { GET as listTools } from "@/app/api/v1/tools/route";
import { POST as runRoute } from "@/app/api/v1/tools/[name]/route";
import { GET as mcpGet, OPTIONS as mcpOptions, POST as mcpPost } from "@/app/api/mcp/route";
import { createMcpServer } from "@/lib/tools/mcp";
import { TOOLS } from "@/lib/tools/registry";

const db = () => new FakeSupabase({ businesses: businesses(), subscriptions: [activePlan()] });

function callRoute(name: string, body: string) {
  const request = new Request(`https://gettrafficfa.st/api/v1/tools/${name}`, { method: "POST", body });
  return runRoute(request as never, { params: Promise.resolve({ name }) });
}

let info: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  state.resolved = { ok: true, caller: apiCaller(db()) };
  info = vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => info.mockRestore());

describe("POST /api/v1/tools/:name", () => {
  it("answers the tool's output as the body", async () => {
    const response = await callRoute("whoami", "");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      userId: USER,
      via: "api_key",
      scopes: ["read", "write", "spend"],
      business: { id: SITE_A, name: "Acme" },
      businesses: [{ id: SITE_A, name: "Acme", websiteUrl: "https://acme.test" }],
    });
  });

  it("answers every refusal in the one error shape", async () => {
    state.resolved = {
      ok: false,
      status: 401,
      error: { code: "invalid_api_key", message: "Unknown API key.", hint: "Create one." },
    };
    const unauthorized = await callRoute("whoami", "{}");
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({ error: { code: "invalid_api_key", message: "Unknown API key.", hint: "Create one." } });

    state.resolved = { ok: true, caller: apiCaller(db()) };
    const notJson = await callRoute("whoami", "{not json");
    expect(notJson.status).toBe(400);
    expect(((await notJson.json()) as { error: { code: string } }).error.code).toBe("invalid_input");

    const unknown = await callRoute("format_disk", "{}");
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: { code: string } }).error).toMatchObject({ code: "unknown_tool" });

    const invalid = await callRoute("list_reply_inbox", JSON.stringify({ limit: 1000 }));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: { code: "invalid_input" } });
  });
});

describe("GET /api/v1/tools", () => {
  it("lists every tool with its scopes and JSON Schemas", async () => {
    const body = (await listTools().json()) as { tools: Array<Record<string, unknown>>; mcp: string };
    expect(body.tools.map((t) => t.name)).toEqual(TOOLS.list().map((t) => t.name));
    expect(body.mcp).toBe("https://gettrafficfa.st/api/mcp");
    const draft = body.tools.find((t) => t.name === "draft_reply")!;
    expect(draft).toMatchObject({ paid: true, subscription: true, scopes: ["write", "spend"] });
    expect(draft.inputSchema).toMatchObject({ type: "object", required: ["targetId"] });
  });
});

describe("MCP", () => {
  async function connect(scopes: Array<"read" | "write" | "spend">) {
    const server = createMcpServer(apiCaller(db(), { scopes }));
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1.0.0" });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    return client;
  }

  it("lists the tools a read-only key may call, with the registry's schemas", async () => {
    const client = await connect(["read"]);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(TOOLS.list().filter((t) => t.scope === "read").map((t) => t.name));
    const list = tools.find((t) => t.name === "list_reply_inbox")!;
    expect(list.inputSchema.type).toBe("object");
    expect(list.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    await client.close();
  });

  it("calls a tool through the runner and returns structured content", async () => {
    const client = await connect(["read", "write", "spend"]);
    const result = await client.callTool({ name: "whoami", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ userId: USER, business: { id: SITE_A } });
    expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)).toMatchObject({ userId: USER });
    await client.close();
  });

  it("answers a refusal as an error result in the API's shape", async () => {
    const client = await connect(["read"]);
    const result = await client.callTool({ name: "dismiss_reply_target", arguments: { targetId: SITE_B } });
    expect(result.isError).toBe(true);
    expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)).toMatchObject({
      error: { code: "forbidden_scope" },
    });
    await client.close();
  });

  it("serves JSON-RPC over the route's stateless HTTP transport", async () => {
    const rpc = (body: unknown) =>
      mcpPost(
        new Request("https://gettrafficfa.st/api/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2025-06-18",
          },
          body: JSON.stringify(body),
        })
      );

    const init = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "curl", version: "0" } },
    });
    expect(init.status).toBe(200);
    expect(await init.json()).toMatchObject({ id: 1, result: { serverInfo: { name: "gettrafficfast" } } });

    const listed = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const body = (await listed.json()) as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.map((t) => t.name)).toContain("draft_reply");

    const called = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "whoami", arguments: {} } });
    expect(await called.json()).toMatchObject({ id: 3, result: { structuredContent: { userId: USER } } });
  });

  it("refuses an unauthenticated call with 401 and WWW-Authenticate, and GET with 405", async () => {
    state.resolved = { ok: false, status: 401, error: { code: "unauthorized", message: "Send a key." } };
    const response = await mcpPost(new Request("https://gettrafficfa.st/api/mcp", { method: "POST", body: "{}" }));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toMatch(/^Bearer/);
    expect(await response.json()).toEqual({ error: { code: "unauthorized", message: "Send a key." } });
    expect(mcpGet().status).toBe(405);
  });

  it("answers CORS on the preflight and on every answer, the 401 included, for browser-based clients", async () => {
    const expectCors = (headers: Headers) => {
      expect(headers.get("access-control-allow-origin")).toBe("*");
      expect(headers.get("access-control-allow-methods")).toBe("POST, GET, DELETE, OPTIONS");
      const allowed = (headers.get("access-control-allow-headers") ?? "").toLowerCase();
      for (const name of ["authorization", "content-type", "accept", "mcp-session-id", "mcp-protocol-version", "last-event-id"]) {
        expect(allowed, name).toContain(name);
      }
      expect(headers.get("access-control-expose-headers")).toBe("Mcp-Session-Id, WWW-Authenticate");
    };

    const preflight = mcpOptions();
    expect(preflight.status).toBe(204);
    expectCors(preflight.headers);

    state.resolved = { ok: false, status: 401, error: { code: "unauthorized", message: "Send a key." } };
    const anonymous = await mcpPost(new Request("https://gettrafficfa.st/api/mcp", { method: "POST", body: "{}" }));
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toContain("resource_metadata=");
    expectCors(anonymous.headers);

    expectCors(mcpGet().headers);

    state.resolved = { ok: true, caller: apiCaller(db()) };
    const listed = await mcpPost(
      new Request("https://gettrafficfa.st/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      })
    );
    expect(listed.status).toBe(200);
    expectCors(listed.headers);
  });
});
