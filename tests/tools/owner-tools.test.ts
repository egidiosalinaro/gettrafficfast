import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FakeSupabase } from "../support/fake-supabase";
import { OTHER, SITE_A, USER, apiCaller, businesses } from "./support";

/**
 * The owner's tools and the customer's read of his plan (lib/tools/owner.ts,
 * `get_plan_usage`). What is pinned:
 *
 * - `get_platform_costs` is not in the registry everyone sees: not in the
 *   public catalogue, not in a customer's MCP `tools/list`, and a customer's
 *   call is the 404 `unknown_tool` a made-up name gets, word for word;
 * - with PLATFORM_OWNER_USER_IDS unset, nobody gets it (fail closed);
 * - an owner's key lists it and reads the costs with it, in dollars;
 * - no tool can set a ceiling: there is none in either registry;
 * - `get_plan_usage` answers quotas in units, and nothing in it, or in
 *   `get_subscription`, is a dollar amount or the platform's provider spend.
 */

const OWNER = OTHER;

const m = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => m.db }));

import { runTool } from "@/lib/tools/runner";
import { createMcpServer } from "@/lib/tools/mcp";
import { TOOLS } from "@/lib/tools/registry";
import { OWNER_TOOLS, registryFor } from "@/lib/tools/owner";
import { GET as listCatalogue } from "@/app/api/v1/tools/route";
import { DAILY_DRAFT_CAP } from "@/lib/paid-access";
import { describeTool } from "@/lib/tools/schema";

const NOW = new Date("2026-11-14T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

let db: FakeSupabase;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.unstubAllEnvs();
  vi.stubEnv("PLATFORM_OWNER_USER_IDS", OWNER);
  db = new FakeSupabase({
    businesses: businesses(),
    subscriptions: [{ user_id: USER, status: "active", updated_at: "2026-11-01T00:00:00Z" }],
    provider_spend: [{ provider: "x-api", month: "2026-11-01", cost_usd: 3.4, calls: 120, posts: 680 }],
    agent_runs: [
      { user_id: USER, agent: "writing", model: "claude-sonnet-5-5", cost_usd: 1.5, created_at: ago(3_600_000) },
      { user_id: OWNER, agent: "writing", model: "claude-sonnet-5-5", cost_usd: 0.25, created_at: ago(3_600_000) },
    ],
    account_limits: [{ user_id: USER, daily_spend_usd: 12 }],
    articles: [{ user_id: USER, business_id: SITE_A, scheduled_date: "2026-11-14" }],
    tool_calls: [],
    draft_feedback: [],
  });
  m.db = db;
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function listed(caller: ReturnType<typeof apiCaller>) {
  const server = createMcpServer(caller);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools.map((tool) => tool.name);
}

describe("get_platform_costs, for an owner only", () => {
  it("is not in the registry everyone sees, nor in the public catalogue", async () => {
    expect(TOOLS.get("get_platform_costs")).toBeUndefined();
    const body = (await listCatalogue().json()) as { tools: Array<{ name: string }> };
    expect(body.tools.map((t) => t.name)).not.toContain("get_platform_costs");
  });

  it("is not in a customer's tools/list, and a customer's call is the 404 a made-up name gets", async () => {
    const customer = apiCaller(db, { scopes: ["read"] });
    expect(await listed(customer)).not.toContain("get_platform_costs");

    const refused = await runTool(customer, "get_platform_costs", {});
    const madeUp = await runTool(customer, "get_platform_bill", {});
    expect(refused).toEqual({
      ok: false,
      status: 404,
      error: {
        code: "unknown_tool",
        message: "There is no tool named get_platform_costs.",
        hint: "GET /api/v1/tools, or MCP tools/list, lists them.",
      },
    });
    expect(madeUp).toMatchObject({ ok: false, status: 404, error: { code: "unknown_tool" } });
  });

  it("fails closed: with no owner listed, the owner's own key does not get it", async () => {
    for (const value of [undefined, "", " , "]) {
      vi.stubEnv("PLATFORM_OWNER_USER_IDS", value);
      const owner = apiCaller(db, { userId: OWNER, businessId: null, scopes: ["read"] });
      expect(registryFor(OWNER)).toBe(TOOLS);
      expect(await listed(owner)).not.toContain("get_platform_costs");
      expect(await runTool(owner, "get_platform_costs", {})).toMatchObject({ ok: false, status: 404 });
    }
  });

  it("is listed for an owner's key and reads the platform's costs", async () => {
    const owner = apiCaller(db, { userId: OWNER, businessId: null, scopes: ["read"] });
    expect(await listed(owner)).toContain("get_platform_costs");
    const run = await runTool(owner, "get_platform_costs", {});
    expect(run.ok).toBe(true);
    const output = (run as { output: Record<string, unknown> }).output;
    expect(output.month).toBe("2026-11");
    expect(output.providers).toEqual([expect.objectContaining({ provider: "x-api", costUsd: 3.4 })]);
    expect(output.accounts).toEqual(
      expect.arrayContaining([expect.objectContaining({ userId: USER, spentUsd: 1.5, ceilingUsd: 12, ceilingSource: "account" })])
    );
  });

  it("refuses in its own handler too, if a registry ever handed it to a customer", async () => {
    const tool = OWNER_TOOLS[0];
    const ctx = { userId: USER, admin: () => db } as never;
    await expect(tool.handler(ctx, {})).rejects.toMatchObject({ code: "unknown_tool", status: 404 });
  });

  it("is read only: no tool, in either registry, sets a ceiling", () => {
    for (const tool of registryFor(OWNER).list()) {
      expect(tool.name).not.toMatch(/ceiling|spend_limit|spend_cap/);
    }
    expect(OWNER_TOOLS.every((tool) => tool.scope === "read" && !tool.paid)).toBe(true);
  });
});

describe("the customer's read tools carry no dollars", () => {
  const dollars = /usd|\$\d|ceiling|provider_spend|costUsd|spentUsd|x-api/i;

  it("get_plan_usage answers the quotas in units, with this site's calendar", async () => {
    const run = await runTool(apiCaller(db, { scopes: ["read"] }), "get_plan_usage", {});
    expect(run.ok).toBe(true);
    const output = (run as unknown as { output: { quotas: Array<Record<string, unknown>>; aiWork: Record<string, unknown> } }).output;
    expect(output.quotas.find((q) => q.id === "calendar_articles")).toMatchObject({ used: 1, limit: 30, period: "month" });
    expect(output.quotas.find((q) => q.id === "draft_reply")).toMatchObject({ used: 0, limit: DAILY_DRAFT_CAP, period: "day" });
    expect(output.aiWork).toEqual({ state: "available", message: null, resetsAt: null });
    expect(JSON.stringify(output)).not.toMatch(dollars);
  });

  it("get_plan_usage says the limit for AI work is reached in units, never the amount", async () => {
    db.tables.agent_runs.push({ user_id: USER, agent: "writing", model: "claude-sonnet-5-5", cost_usd: 11, created_at: ago(7_200_000) });
    const run = await runTool(apiCaller(db, { scopes: ["read"] }), "get_plan_usage", {});
    const output = (run as unknown as { output: { aiWork: Record<string, unknown> } }).output;
    expect(output.aiWork).toMatchObject({ state: "reached", message: expect.stringMatching(/^You've reached today's limit for AI work\./) });
    expect(JSON.stringify(output)).not.toMatch(dollars);
    expect(JSON.stringify(output)).not.toMatch(/\b12\b|\b12\.5\b/);
  });

  it("get_subscription and get_plan_usage describe no dollar field", () => {
    for (const name of ["get_subscription", "get_plan_usage"]) {
      expect(JSON.stringify(describeTool(TOOLS.get(name)!).outputSchema)).not.toMatch(/usd|ceiling|cost/i);
    }
  });
});
