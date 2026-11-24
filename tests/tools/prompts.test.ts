import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { FakeSupabase } from "../support/fake-supabase";
import { apiCaller, businesses } from "./support";

/**
 * MCP prompts (lib/tools/prompts.ts): the routine as commands in Claude.
 * Pinned: the server advertises the capability; prompts/list names the two
 * routines and their arguments; prompts/get renders text for the caller's
 * grant, validates its string arguments (an unknown prompt or a bad
 * argument is JSON-RPC -32602), calls no tool and writes nothing; every
 * tool a prompt names is in the registry; the product's rules are in the
 * text (never posts, null is not measured, sampled, per engine, no dollar).
 */

const state = vi.hoisted(() => ({ resolved: null as unknown }));
vi.mock("@/lib/api-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api-auth")>()),
  resolveCaller: async () => state.resolved,
}));

import { POST as mcpPost } from "@/app/api/mcp/route";
import { createMcpServer } from "@/lib/tools/mcp";
import { PROMPTS, renderPrompt } from "@/lib/tools/prompts";
import { TOOLS } from "@/lib/tools/registry";

type Scope = "read" | "write" | "spend";

async function connect(db: FakeSupabase, scopes: Scope[] = ["read", "write", "spend"]) {
  const server = createMcpServer(apiCaller(db, { scopes }));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

const textOf = (result: { messages: Array<{ role: string; content: { type: string; text?: string } }> }) => {
  expect(result.messages).toHaveLength(1);
  expect(result.messages[0]).toMatchObject({ role: "user", content: { type: "text" } });
  return result.messages[0].content.text ?? "";
};

let info: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  info = vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => info.mockRestore());

describe("prompts/list", () => {
  it("is advertised, and lists daily_routine and weekly_review with their arguments", async () => {
    const client = await connect(new FakeSupabase({ businesses: businesses() }));
    expect(client.getServerCapabilities()?.prompts).toEqual({ listChanged: false });
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(["daily_routine", "weekly_review"]);
    expect(prompts[0]).toMatchObject({
      title: "Run my day",
      arguments: [
        { name: "timeZone", required: false },
        { name: "site", required: false },
      ],
    });
    expect(prompts[1].arguments?.map((a) => a.name)).toEqual(["days", "topics", "site"]);
    for (const prompt of prompts) expect(prompt.description?.length).toBeGreaterThan(40);
    await client.close();
  });
});

describe("prompts/get", () => {
  it("daily_routine walks Today: get_today, each reply in To do, the intent link, I posted it, Also today", async () => {
    const db = new FakeSupabase({ businesses: businesses() });
    const client = await connect(db);
    const text = textOf(await client.getPrompt({ name: "daily_routine", arguments: { timeZone: "Europe/Berlin" } }));
    expect(text).toContain('get_today with timeZone "Europe/Berlin"');
    expect(text).toContain('list_reply_inbox with status "open"');
    // The screen's order, so the person and Claude are on the same reply (2026-11-24).
    expect(text).toMatch(/exactly the order list_reply_inbox returns them[\s\S]*Never reorder them by score/);
    expect(text).toMatch(/get_reply_intent_url[\s\S]*post it myself[\s\S]*mark_reply_posted/);
    expect(text).toMatch(/correct_reply_draft with the draftId and that reason/);
    expect(text).toContain("dismiss_reply_target");
    expect(text).toContain("alsoToday");
    expect(text).toMatch(/GTF never posts on X or anywhere else, and neither do you/);
    expect(text).toMatch(/names no product and carries no link/);
    expect(text).not.toMatch(/can only read|no Spend permission/);
    // A template: nothing was called, nothing was recorded.
    expect(db.tables.tool_calls ?? []).toEqual([]);
    await client.close();
  });

  it("weekly_review reads Growth, the AI answers and Content, per engine and sampled", async () => {
    const client = await connect(new FakeSupabase({ businesses: businesses() }));
    const text = textOf(await client.getPrompt({ name: "weekly_review", arguments: { days: "28", topics: "8" } }));
    expect(text).toContain("get_growth with days 28");
    expect(text).toContain("list_ai_answers with days 28");
    expect(text).toContain("get_content with topics 8");
    expect(text).toMatch(/sampled/);
    expect(text).toMatch(/Never average engines together/);
    expect(text).toMatch(/"not measured"/);
    expect(text).toMatch(/delete_keywords with its id, only after my yes/);
    await client.close();
  });

  it("fills the defaults, and reads an empty string as an argument not given", () => {
    const caller = { scopes: ["read", "write", "spend"] as const };
    const daily = renderPrompt("daily_routine", { timeZone: "" }, caller);
    expect(daily.ok && daily.text).toContain('get_today with timeZone "UTC"');
    const weekly = renderPrompt("weekly_review", {}, caller);
    expect(weekly.ok && weekly.text).toContain("get_growth with days 7");
    expect(weekly.ok && weekly.text).toContain("get_content with topics 5");
  });

  it("refuses an unknown prompt and a bad argument as Invalid params (-32602)", async () => {
    const client = await connect(new FakeSupabase({ businesses: businesses() }));
    const refused = async (name: string, args: Record<string, string>) => {
      const error = await client.getPrompt({ name, arguments: args }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(McpError);
      expect((error as McpError).code).toBe(ErrorCode.InvalidParams);
      return (error as McpError).message;
    };
    expect(await refused("monthly_report", {})).toMatch(/no prompt named monthly_report.*daily_routine, weekly_review/);
    expect(await refused("daily_routine", { timeZone: "Mars/Olympus" })).toMatch(/timeZone: not an IANA time zone/);
    expect(await refused("weekly_review", { days: "14" })).toMatch(/days: 7 or 28/);
    expect(await refused("weekly_review", { topics: "0" })).toMatch(/topics: at least 1/);
    expect(await refused("weekly_review", { topics: "lots" })).toMatch(/topics: a whole number/);
    await client.close();
  });

  it("says what the grant cannot do instead of letting Claude try", async () => {
    const readOnly = await connect(new FakeSupabase({ businesses: businesses() }), ["read"]);
    const daily = textOf(await readOnly.getPrompt({ name: "daily_routine", arguments: {} }));
    expect(daily).toMatch(/This connection can only read/);
    expect(daily).toMatch(/no Spend permission[\s\S]*edit_reply_draft/);
    const weekly = textOf(await readOnly.getPrompt({ name: "weekly_review", arguments: {} }));
    expect(weekly).toMatch(/Removing a topic needs the Write permission/);
    await readOnly.close();

    const noSpend = await connect(new FakeSupabase({ businesses: businesses() }), ["read", "write"]);
    const text = textOf(await noSpend.getPrompt({ name: "daily_routine", arguments: {} }));
    expect(text).not.toMatch(/can only read/);
    expect(text).toMatch(/no Spend permission/);
    await noSpend.close();
  });

  it("is served over the route's stateless HTTP transport", async () => {
    state.resolved = { ok: true, caller: apiCaller(new FakeSupabase({ businesses: businesses() })) };
    const rpc = (body: unknown) =>
      mcpPost(
        new Request("https://gettrafficfa.st/api/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2025-11-25",
          },
          body: JSON.stringify(body),
        })
      );
    const listed = await rpc({ jsonrpc: "2.0", id: 1, method: "prompts/list" });
    expect(await listed.json()).toMatchObject({ id: 1, result: { prompts: [{ name: "daily_routine" }, { name: "weekly_review" }] } });
    const got = await rpc({ jsonrpc: "2.0", id: 2, method: "prompts/get", params: { name: "weekly_review", arguments: { days: "7" } } });
    expect(await got.json()).toMatchObject({ id: 2, result: { messages: [{ role: "user", content: { type: "text" } }] } });
    const bad = await rpc({ jsonrpc: "2.0", id: 3, method: "prompts/get", params: { name: "daily_routine", arguments: { timeZone: "nowhere" } } });
    expect(await bad.json()).toMatchObject({ id: 3, error: { code: -32602 } });
  });
});

describe("the prompts' text", () => {
  const all = { scopes: ["read", "write", "spend"] as const };
  const readOnly = { scopes: ["read"] as const };
  const texts = PROMPTS.flatMap((prompt) =>
    [all, readOnly].map((caller) => {
      const rendered = renderPrompt(prompt.name, {}, caller);
      if (!rendered.ok) throw new Error(rendered.message);
      return { prompt, text: rendered.text };
    })
  );

  it("names only registered tools, and declares each in uses", () => {
    const registered = new Set(TOOLS.list().map((t) => t.name));
    for (const { prompt, text } of texts) {
      for (const name of prompt.uses) expect(registered.has(name), `${prompt.name} uses ${name}`).toBe(true);
      const named = [...text.matchAll(/\b[a-z]+(?:_[a-z]+)+\b/g)].map((m) => m[0]).filter((word) => registered.has(word));
      for (const name of named) expect(prompt.uses, `${prompt.name} names ${name}`).toContain(name);
    }
    for (const prompt of PROMPTS) {
      const full = renderPrompt(prompt.name, {}, all);
      for (const name of prompt.uses) expect(full.ok && full.text, `${prompt.name} declares ${name}`).toContain(name);
    }
  });

  it("names no tool that does not exist (snake_case words are tools, or values the tools answer)", () => {
    const registered = new Set(TOOLS.list().map((t) => t.name));
    const values = new Set(["article_held", "article_failed", "reply_link", "fact_stale"]);
    for (const { prompt, text } of texts) {
      const words = [...text.matchAll(/\b[a-z]+(?:_[a-z]+)+\b/g)].map((m) => m[0]);
      expect(words.filter((w) => !registered.has(w) && !values.has(w)), prompt.name).toEqual([]);
    }
  });

  it("shows no dollar amount and never asks Claude to post", () => {
    for (const { text } of texts) {
      expect(text).not.toMatch(/\$\d|\bUSD\b|dollar(?! amounts)/i);
      expect(text).toMatch(/never posts/);
    }
  });
});
