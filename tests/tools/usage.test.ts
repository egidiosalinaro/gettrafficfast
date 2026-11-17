import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { FakeSupabase } from "../support/fake-supabase";
import { SITE_A, USER, apiCaller, businesses } from "./support";

/**
 * The audit log and the per-key limits (lib/tools/usage.ts, run by
 * lib/tools/runner.ts). What is pinned: every call is recorded, refused ones
 * included, with the key (null for a session), the tool, the outcome, the
 * duration and a cost only when one was measured; a key over 60 calls in a
 * minute is `rate_limited` with a Retry-After; a key at a paid tool's daily
 * cap is `cap_reached`, counting only its own successful calls of that tool
 * in the last 24 hours; a session is never limited; and with the table
 * missing, the limits let the call through with a warning and nothing
 * breaks.
 */

const mocks = vi.hoisted(() => ({ db: null as unknown, resolved: null as unknown }));
vi.mock("@/lib/subscription", () => ({ hasActiveSubscription: async () => true }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mocks.db }));
vi.mock("@/lib/api-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api-auth")>()),
  resolveCaller: async () => mocks.resolved,
}));

import { POST as runRoute } from "@/app/api/v1/tools/[name]/route";
import { createRegistry, TOOLS } from "@/lib/tools/registry";
import { runTool } from "@/lib/tools/runner";
import { defineTool } from "@/lib/tools/tool";
import { TOOL_LIMITS, dailyCapOf, resetUsageWarnings } from "@/lib/tools/usage";
import type { Caller } from "@/lib/api-auth";

const NOW = new Date("2026-11-09T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const look = defineTool({
  name: "look",
  title: "Look",
  description: "Reads nothing, for tests of the limits.",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  scope: "read",
  paid: false,
  handler: async () => ({ ok: true }),
});

const check = defineTool({
  name: "run_visibility_check",
  title: "Run a visibility check",
  description: "Pretends to probe the answer engines, for tests of the daily cap.",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  scope: "write",
  paid: true,
  async handler(ctx) {
    ctx.reportCost?.(0.02);
    ctx.reportCost?.(0.005);
    return { ok: true };
  },
});

const suggest = defineTool({
  name: "suggest_prompts",
  title: "Suggest prompts",
  description: "Pretends to ask a model for prompts, for tests of the prefix cap.",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  scope: "write",
  paid: true,
  handler: async () => ({ ok: true }),
});

const registry = createRegistry([look, check, suggest]);

function seed(calls: Array<Record<string, unknown>> = []) {
  const db = new FakeSupabase({ businesses: businesses(), tool_calls: calls });
  mocks.db = db;
  return db;
}

function rows(n: number, over: Record<string, unknown>) {
  return Array.from({ length: n }, () => ({
    user_id: USER,
    business_id: SITE_A,
    api_key_id: "key-1",
    tool: "look",
    status: "ok",
    created_at: ago(10_000),
    ...over,
  }));
}

const deps = (db: FakeSupabase) => ({ registry, admin: () => db as unknown as SupabaseClient, now: () => NOW });

function sessionCaller(db: FakeSupabase): Caller {
  return { ...apiCaller(db), via: "session", keyId: null, scopes: ["read", "write", "spend", "publish"] };
}

let warn: ReturnType<typeof vi.spyOn>;
let quiet: Array<ReturnType<typeof vi.spyOn>>;
beforeEach(() => {
  resetUsageWarnings();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  quiet = (["info", "error"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
});
afterEach(() => {
  warn.mockRestore();
  quiet.forEach((spy) => spy.mockRestore());
});

describe("the audit log", () => {
  it("records a key's call with its outcome, duration and site, and a measured cost", async () => {
    const db = seed();
    expect(await runTool(apiCaller(db), "run_visibility_check", {}, deps(db))).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(db.tables.tool_calls).toHaveLength(1));
    const row = db.tables.tool_calls[0];
    expect(row).toMatchObject({
      user_id: USER,
      business_id: SITE_A,
      api_key_id: "key-1",
      tool: "run_visibility_check",
      status: "ok",
      cost_usd: 0.025,
      created_at: NOW.toISOString(),
    });
    expect(typeof row.duration_ms).toBe("number");
  });

  it("records refusals with their code, a cost of null (not measured), and a session's call without a key", async () => {
    const db = seed();
    await runTool(apiCaller(db, { scopes: ["read"] }), "run_visibility_check", {}, deps(db));
    await runTool(apiCaller(db), "no_such_tool", {}, deps(db));
    await runTool(sessionCaller(db), "look", {}, deps(db));
    await vi.waitFor(() => expect(db.tables.tool_calls).toHaveLength(3));
    expect(db.tables.tool_calls.map((r) => [r.tool, r.status, r.api_key_id, r.cost_usd])).toEqual([
      ["run_visibility_check", "forbidden_scope", "key-1", null],
      ["no_such_tool", "unknown_tool", "key-1", null],
      ["look", "ok", null, null],
    ]);
  });
});

describe("the burst limit", () => {
  it("refuses a key's 61st call in a minute with rate_limited and a Retry-After, whatever the tool", async () => {
    const db = seed(rows(TOOL_LIMITS.perMinute, { status: "ok" }));
    const run = await runTool(apiCaller(db), "look", {}, deps(db));
    expect(run).toEqual({
      ok: false,
      status: 429,
      retryAfterSeconds: 60,
      error: {
        code: "rate_limited",
        message: "This key made 60 calls in the last minute; the limit is 60 a minute.",
        hint: "Wait a minute and call again: a key may make 60 calls a minute, whatever the tool.",
      },
    });
    // Refusals count too: hammering keeps a key limited.
    await vi.waitFor(() => expect(db.tables.tool_calls.filter((r) => r.status === "rate_limited")).toHaveLength(1));
  });

  it("lets the call through under the limit, for calls older than a minute, another key, or a session", async () => {
    const db = seed([
      ...rows(TOOL_LIMITS.perMinute - 1, {}),
      ...rows(10, { created_at: ago(MINUTE + 1000) }),
      ...rows(100, { api_key_id: "key-2" }),
    ]);
    expect(await runTool(apiCaller(db), "look", {}, deps(db))).toMatchObject({ ok: true });

    const busy = seed(rows(500, {}));
    expect(await runTool(sessionCaller(busy), "look", {}, deps(busy))).toMatchObject({ ok: true });
  });

  it("sends Retry-After on the REST route", async () => {
    // The route runs on the real clock.
    const db = seed(rows(TOOL_LIMITS.perMinute, { created_at: new Date(Date.now() - 5000).toISOString() }));
    mocks.resolved = { ok: true, caller: apiCaller(db) };
    const request = new Request("https://gettrafficfa.st/api/v1/tools/whoami", { method: "POST", body: "{}" });
    const response = await runRoute(request as never, { params: Promise.resolve({ name: "whoami" }) });
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(await response.json()).toMatchObject({ error: { code: "rate_limited" } });
  });
});

describe("the daily caps", () => {
  it("refuses a paid tool at its per-key cap with cap_reached", async () => {
    const db = seed(rows(4, { tool: "run_visibility_check", created_at: ago(3 * HOUR) }));
    const run = await runTool(apiCaller(db), "run_visibility_check", {}, deps(db));
    expect(run).toEqual({
      ok: false,
      status: 429,
      error: {
        code: "cap_reached",
        message: "This key has called run_visibility_check 4 times in the last 24 hours, its daily cap of 4.",
        hint: "Per-key daily caps count a rolling 24 hours and open up again within a day; the docs list them: https://gettrafficfa.st/docs#limits.",
      },
    });
  });

  it("counts only the key's own successful calls of that tool in the last 24 hours", async () => {
    const db = seed([
      ...rows(3, { tool: "run_visibility_check", created_at: ago(3 * HOUR) }),
      ...rows(5, { tool: "run_visibility_check", status: "subscription_required", created_at: ago(2 * HOUR) }),
      ...rows(5, { tool: "run_visibility_check", created_at: ago(25 * HOUR) }),
      ...rows(5, { tool: "run_visibility_check", api_key_id: "key-2", created_at: ago(HOUR) }),
      ...rows(5, { tool: "suggest_prompts", created_at: ago(HOUR) }),
    ]);
    expect(await runTool(apiCaller(db), "run_visibility_check", {}, deps(db))).toMatchObject({ ok: true });
  });

  it("caps each suggest_ tool at 30 per key, and never holds a session to a key's cap", async () => {
    const db = seed(rows(30, { tool: "suggest_prompts", created_at: ago(5 * HOUR) }));
    expect(await runTool(apiCaller(db), "suggest_prompts", {}, deps(db))).toMatchObject({
      ok: false,
      error: { code: "cap_reached", message: expect.stringMatching(/^This key has called suggest_prompts 30 times/) },
    });
    // The session has no key cap; the account's own cap (lib/limits/actions.ts)
    // counts the key's 30 calls, and that is what refuses it.
    expect(await runTool(sessionCaller(db), "suggest_prompts", {}, deps(db))).toMatchObject({
      ok: false,
      error: { code: "cap_reached", message: expect.stringMatching(/^This account has started 30 prompt suggestions/) },
    });
    const fresh = seed(rows(29, { tool: "suggest_prompts", api_key_id: "key-2", created_at: ago(5 * HOUR) }));
    expect(await runTool(sessionCaller(fresh), "suggest_prompts", {}, deps(fresh))).toMatchObject({ ok: true });
  });

  it("holds the caps the API promises, in one config", () => {
    expect(TOOL_LIMITS.perMinute).toBe(60);
    expect(dailyCapOf("run_reply_discovery")).toBe(10);
    expect(dailyCapOf("generate_article")).toBe(10);
    expect(dailyCapOf("analyze_website")).toBe(10);
    expect(dailyCapOf("run_visibility_check")).toBe(4);
    expect(dailyCapOf("suggest_keywords")).toBe(30);
    expect(dailyCapOf("suggest_prompts")).toBe(30);
    expect(dailyCapOf("draft_reply")).toBeNull();
    expect(dailyCapOf("list_reply_inbox")).toBeNull();
  });

  it("gives every paid tool a per-key cap, or names the account cap that already bounds it", () => {
    for (const tool of TOOLS.list().filter((t) => t.paid)) {
      const covered = dailyCapOf(tool.name) !== null || TOOL_LIMITS.cappedPerAccount.includes(tool.name);
      expect(covered, `${tool.name} has neither a per-key cap nor an account cap`).toBe(true);
    }
  });
});

describe("without the tool_calls table", () => {
  function missingTable(db: FakeSupabase): SupabaseClient {
    return new Proxy(db, {
      get(target, property, receiver) {
        if (property !== "from") return Reflect.get(target, property, receiver);
        return (table: string) => {
          if (table !== "tool_calls") return target.from(table);
          const failed = Promise.resolve({ data: null, count: null, error: { message: 'relation "public.tool_calls" does not exist' } });
          const query: Record<string, unknown> = {
            select: () => query,
            insert: () => failed,
            eq: () => query,
            gte: () => query,
            then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => failed.then(resolve, reject),
          };
          return query;
        };
      },
    }) as unknown as SupabaseClient;
  }

  it("lets every call through, limits off, with one warning, and nothing breaks", async () => {
    const db = seed();
    const admin = missingTable(db);
    const options = { registry, admin: () => admin, now: () => NOW };

    expect(await runTool(apiCaller(db), "look", {}, options)).toMatchObject({ ok: true });
    expect(await runTool(apiCaller(db), "run_visibility_check", {}, options)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    const events = warn.mock.calls.map((args: unknown[]) => JSON.parse(String(args[0])).event);
    expect(events).toContain("tool.limits_unavailable");
    // Throttled: not one line per call.
    expect(events.filter((e: string) => e === "tool.limits_unavailable")).toHaveLength(1);
  });

  it("answers even when the service role cannot be built", async () => {
    const db = seed();
    const options = {
      registry,
      admin: () => {
        throw new Error("Supabase admin client requires NEXT_PUBLIC_SUPABASE_URL");
      },
      now: () => NOW,
    };
    expect(await runTool(apiCaller(db), "look", {}, options)).toEqual({ ok: true, output: { ok: true } });
  });
});
