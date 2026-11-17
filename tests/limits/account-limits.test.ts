import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { FakeSupabase } from "../support/fake-supabase";
import { SITE_A, USER, apiCaller, businesses } from "../tools/support";

/**
 * The account's limits on paid actions, through both doors: the tool runner
 * (every API key and an API session) and the screens' routes. What is
 * pinned: the per-account caps mirror the per-key ones and count every key
 * and the screens together, from the cleanest record (manual jobs by type
 * for generation, discovery and visibility; successful calls in `tool_calls`
 * for analyses and suggestions, the screens' included); the crons' own jobs,
 * another account and anything older than 24 hours do not count; the daily
 * AI spend ceiling refuses every paid tool and paid route at and above it,
 * with `spend_cap_reached` and where to raise it; a count or a spend that
 * cannot be read refuses (503); a missing `tool_calls` lets the call through
 * with a warning.
 */

const mocks = vi.hoisted(() => ({ db: null as unknown, suggest: vi.fn() }));
vi.mock("@/lib/subscription", () => ({ hasActiveSubscription: async () => true }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mocks.db }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "11111111-1111-4111-8111-111111111111" } } }) },
    from: (table: string) => (mocks.db as FakeSupabase).from(table),
  }),
}));
vi.mock("@/lib/tenancy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenancy")>()),
  selectedBusinessId: async () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
}));
vi.mock("@/lib/keywords/manage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/keywords/manage")>()),
  suggestKeywords: (...args: unknown[]) => mocks.suggest(...args),
}));

import { POST as suggestRoute } from "@/app/api/keywords/suggest/route";
import { POST as generateNowRoute } from "@/app/api/generate-now/route";
import { createRegistry } from "@/lib/tools/registry";
import { runTool } from "@/lib/tools/runner";
import { defineTool } from "@/lib/tools/tool";
import { resetUsageWarnings } from "@/lib/tools/usage";
import { ACTION_COUNT_UNREADABLE_MESSAGE as ACCOUNT_COUNT_UNREADABLE, accountDailyCapOf, resetActionWarnings } from "@/lib/limits/actions";
import { resetSpendWarnings } from "@/lib/limits/spend";
import { MANUAL_JOB_PRIORITY } from "@/lib/jobs/types";
import { PRODUCE_ARTICLE } from "@/lib/jobs/workflows/produce-article";
import type { Caller } from "@/lib/api-auth";

const NOW = new Date();
const HOUR = 60 * 60 * 1000;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
/** The customer's terms at the ceiling: when it resets, never an amount. */
const CAP_MESSAGE = /^You've reached today's limit for AI work\. It resets at about \d\d:\d\d UTC on [A-Z][a-z]{2} \d{1,2}\.$/;

const paidTool = (name: string) =>
  defineTool({
    name,
    title: name,
    description: `Pretends to be ${name}, for tests of the account's limits.`,
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    scope: "write",
    paid: true,
    handler: async () => ({ ok: true }),
  });

const look = defineTool({
  name: "look",
  title: "Look",
  description: "Free, for tests of the limits.",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  scope: "read",
  paid: false,
  handler: async () => ({ ok: true }),
});

const registry = createRegistry([look, paidTool("suggest_keywords"), paidTool("generate_article"), paidTool("draft_reply")]);

function seed(tables: Record<string, Array<Record<string, unknown>>> = {}) {
  const db = new FakeSupabase({ businesses: businesses(), tool_calls: [], account_limits: [], ...tables });
  mocks.db = db;
  return db;
}

const deps = (db: FakeSupabase | SupabaseClient) => ({ registry, admin: () => db as unknown as SupabaseClient, now: () => NOW });

const keyCaller = (db: FakeSupabase, keyId: string): Caller => ({ ...apiCaller(db), keyId });
const sessionCaller = (db: FakeSupabase): Caller => ({ ...apiCaller(db), via: "session", keyId: null });

function calls(n: number, over: Record<string, unknown>) {
  return Array.from({ length: n }, () => ({
    user_id: USER,
    business_id: SITE_A,
    api_key_id: "key-1",
    tool: "suggest_keywords",
    status: "ok",
    created_at: ago(2 * HOUR),
    ...over,
  }));
}

function jobs(n: number, over: Record<string, unknown> = {}) {
  return Array.from({ length: n }, () => ({
    user_id: USER,
    business_id: SITE_A,
    type: PRODUCE_ARTICLE,
    status: "completed",
    priority: MANUAL_JOB_PRIORITY,
    created_at: ago(3 * HOUR),
    ...over,
  }));
}

const post = (url: string, body: unknown) =>
  new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) as never;

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resetUsageWarnings();
  resetSpendWarnings();
  resetActionWarnings();
  mocks.suggest.mockReset();
  mocks.suggest.mockResolvedValue({ ok: true, suggestions: [{ keyword: "ai seo" }], duplicates: [], refused: [] });
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  for (const level of ["info", "error", "log"] as const) vi.spyOn(console, level).mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("the per-account caps", () => {
  it("mirror the per-key numbers", () => {
    expect(accountDailyCapOf("run_reply_discovery")).toBe(10);
    expect(accountDailyCapOf("generate_article")).toBe(10);
    expect(accountDailyCapOf("analyze_website")).toBe(10);
    expect(accountDailyCapOf("run_visibility_check")).toBe(4);
    expect(accountDailyCapOf("suggest_keywords")).toBe(30);
    expect(accountDailyCapOf("suggest_prompts")).toBe(30);
    // Drafts and corrections keep the account caps they had.
    expect(accountDailyCapOf("draft_reply")).toBeNull();
    expect(accountDailyCapOf("correct_reply_draft")).toBeNull();
  });

  it("count two keys and the screens together: a third key under its own cap is refused", async () => {
    const db = seed({
      tool_calls: [
        ...calls(15, { api_key_id: "key-1" }),
        ...calls(10, { api_key_id: "key-2" }),
        ...calls(5, { api_key_id: null }),
        // Not counted: refused calls, another tool, another account, older than a day.
        ...calls(20, { status: "cap_reached" }),
        ...calls(20, { tool: "suggest_prompts" }),
        ...calls(20, { user_id: "someone-else" }),
        ...calls(20, { created_at: ago(25 * HOUR) }),
      ],
    });
    const run = await runTool(keyCaller(db, "key-3"), "suggest_keywords", {}, deps(db));
    expect(run).toEqual({
      ok: false,
      status: 429,
      error: {
        code: "cap_reached",
        message:
          "This account has started 30 keyword suggestions in the last 24 hours, its daily limit of 30 across the screens and every API key. It opens up again within a day.",
        hint: "Account daily caps count every key and the screens over a rolling 24 hours, and open up again within a day; the docs list them: https://gettrafficfa.st/docs#limits.",
      },
    });
    // A session over the API is held the same way.
    expect(await runTool(sessionCaller(db), "suggest_keywords", {}, deps(db))).toMatchObject({ ok: false, error: { code: "cap_reached" } });
    // And the screen's own route.
    const response = await suggestRoute(post("https://gettrafficfa.st/api/keywords/suggest", { keywords: ["seo"] }));
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ code: "cap_reached", error: expect.stringContaining("keyword suggestions") });
    expect(mocks.suggest).not.toHaveBeenCalled();
  });

  it("count what the screen does: its successful call is recorded without a key, and the API's next call is the one over", async () => {
    const db = seed({ tool_calls: [...calls(20, { api_key_id: "key-1" }), ...calls(9, { api_key_id: "key-2" })] });
    const response = await suggestRoute(post("https://gettrafficfa.st/api/keywords/suggest", { keywords: ["seo"] }));
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(db.tables.tool_calls.filter((row) => row.api_key_id === null)).toHaveLength(1));
    expect(db.tables.tool_calls.find((row) => row.api_key_id === null)).toMatchObject({
      user_id: USER,
      business_id: SITE_A,
      tool: "suggest_keywords",
      status: "ok",
      cost_usd: null,
    });
    expect(await runTool(keyCaller(db, "key-2"), "suggest_keywords", {}, deps(db))).toMatchObject({ ok: false, error: { code: "cap_reached" } });
  });

  it("count the account's manual jobs for generation, whoever asked, and not the crons' own", async () => {
    const under = seed({
      jobs: [
        ...jobs(9),
        ...jobs(20, { priority: 0 }),
        ...jobs(10, { user_id: "someone-else" }),
        ...jobs(10, { created_at: ago(30 * HOUR) }),
        ...jobs(10, { type: "placement-draft" }),
      ],
    });
    expect(await runTool(keyCaller(under, "key-1"), "generate_article", {}, deps(under))).toMatchObject({ ok: true });

    const at = seed({ jobs: jobs(10) });
    expect(await runTool(keyCaller(at, "key-1"), "generate_article", {}, deps(at))).toMatchObject({
      ok: false,
      status: 429,
      error: { code: "cap_reached", message: expect.stringContaining("10 article generations") },
    });
    const response = await generateNowRoute(post("https://gettrafficfa.st/api/generate-now", { articleId: "a-1" }));
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ code: "cap_reached" });
  });

  it("refuse when a count cannot be read, and let the call through when tool_calls is missing", async () => {
    const db = seed();
    const withTable = (failure: Record<string, unknown>) =>
      new Proxy(db, {
        get(target, property, receiver) {
          if (property !== "from") return Reflect.get(target, property, receiver);
          return (table: string) => {
            if (table !== "tool_calls") return target.from(table);
            const answer = Promise.resolve({ data: null, count: null, error: failure });
            const query: Record<string, unknown> = { insert: () => answer };
            for (const method of ["select", "eq", "gte"]) query[method] = () => query;
            query.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => answer.then(resolve, reject);
            return query;
          };
        },
      }) as unknown as SupabaseClient;

    const timeout = withTable({ code: "57014", message: "statement timeout" });
    expect(await runTool(keyCaller(db, "key-1"), "suggest_keywords", {}, deps(timeout))).toEqual({
      ok: false,
      status: 503,
      error: { code: "unavailable", message: ACCOUNT_COUNT_UNREADABLE },
    });

    const missing = withTable({ code: "42P01", message: 'relation "public.tool_calls" does not exist' });
    expect(await runTool(keyCaller(db, "key-1"), "suggest_keywords", {}, deps(missing))).toMatchObject({ ok: true });
    const events = warn.mock.calls.map((args: unknown[]) => JSON.parse(String(args[0])).event);
    expect(events).toContain("account_caps.unavailable");
  });
});

describe("the daily AI spend ceiling", () => {
  const spent = (usd: number) => [
    { user_id: USER, agent: "writing", model: "claude-sonnet-5-5", cost_usd: usd, created_at: ago(2 * HOUR) },
  ];

  it("refuses every paid tool at and above it, whatever the caller, in the customer's terms (no amount); free tools still run", async () => {
    for (const usd of [5, 6]) {
      const db = seed({ agent_runs: spent(usd) });
      for (const tool of ["suggest_keywords", "generate_article", "draft_reply"]) {
        expect(await runTool(keyCaller(db, "key-1"), tool, {}, deps(db))).toEqual({
          ok: false,
          status: 429,
          error: {
            code: "spend_cap_reached",
            message: expect.stringMatching(CAP_MESSAGE),
            hint: "The daily limit for AI work counts a rolling 24 hours and opens up again on its own. Settings → Plan shows what your plan includes and what is used: https://gettrafficfa.st/settings/billing.",
          },
        });
      }
      expect(await runTool(sessionCaller(db), "draft_reply", {}, deps(db))).toMatchObject({ ok: false, error: { code: "spend_cap_reached" } });
      expect(await runTool(keyCaller(db, "key-1"), "look", {}, deps(db))).toMatchObject({ ok: true });
    }
    const under = seed({ agent_runs: spent(4.99) });
    expect(await runTool(keyCaller(under, "key-1"), "draft_reply", {}, deps(under))).toMatchObject({ ok: true });
  });

  it("refuses the screens' paid routes the same way, with the link to Billing and a Retry-After", async () => {
    seed({ agent_runs: spent(5) });
    const response = await suggestRoute(post("https://gettrafficfa.st/api/keywords/suggest", { keywords: ["seo"] }));
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: expect.stringMatching(CAP_MESSAGE),
      code: "spend_cap_reached",
      href: "/settings/billing",
    });
    expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(mocks.suggest).not.toHaveBeenCalled();
  });

  it("fails closed when the spend cannot be read: 503, nothing started", async () => {
    const db = seed();
    const broken = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== "from") return Reflect.get(target, property, receiver);
        return (table: string) => {
          if (table !== "agent_runs") return target.from(table);
          const answer = Promise.resolve({ data: null, error: { code: "57014", message: "statement timeout" } });
          const query: Record<string, unknown> = {};
          for (const method of ["select", "eq", "gte", "order"]) query[method] = () => query;
          query.range = () => answer;
          return query;
        };
      },
    }) as unknown as SupabaseClient;
    expect(await runTool(keyCaller(db, "key-1"), "draft_reply", {}, deps(broken))).toEqual({
      ok: false,
      status: 503,
      error: { code: "unavailable", message: "Today's AI work could not be checked, so nothing was started. Try again in a minute." },
    });
    const unbuildable = {
      registry,
      admin: () => {
        throw new Error("Supabase admin client requires NEXT_PUBLIC_SUPABASE_URL");
      },
      now: () => NOW,
    };
    expect(await runTool(sessionCaller(db), "draft_reply", {}, unbuildable)).toMatchObject({ ok: false, status: 503 });
  });
});
