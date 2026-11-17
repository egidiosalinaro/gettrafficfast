import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { FakeSupabase } from "../support/fake-supabase";
import { OTHER, SITE_A, SITE_B, SITE_C, USER, apiCaller, businesses, uuid } from "./support";

/**
 * The runner: one path for every tool and every surface. What is pinned:
 * the error shape and codes (unknown_tool, forbidden_scope, no_business,
 * invalid_input, not_found, subscription_required, internal); that an id an
 * input names is checked against the caller's user AND site before the
 * handler runs, so a key for site A cannot touch site B; that the paywall
 * applies to API callers, read through their own client; and that a
 * handler's output is validated.
 */

const subscription = vi.hoisted(() => ({ active: true, clients: [] as unknown[] }));
vi.mock("@/lib/subscription", () => ({
  hasActiveSubscription: async (_userId: string, client?: unknown) => {
    subscription.clients.push(client);
    return subscription.active;
  },
}));

import { PLAN_REQUIRED_HINT, PLAN_REQUIRED_MESSAGE } from "@/lib/paid-access";
import { createRegistry } from "@/lib/tools/registry";
import { runTool } from "@/lib/tools/runner";
import { defineTool, ToolError } from "@/lib/tools/tool";

const T_A = uuid("a", 1);
const T_B = uuid("b", 1);
const T_C = uuid("c", 1);

const seen: Array<{ targetId?: string; businessId: string; userId: string }> = [];

const touch = defineTool({
  name: "touch_target",
  title: "Touch a target",
  description: "Writes to one target, for tests of the runner's checks.",
  input: z.object({ targetId: z.string().uuid(), note: z.string().max(5).optional() }),
  output: z.object({ touched: z.string() }),
  scope: "write",
  paid: false,
  owns: { targetId: "placement_targets" },
  async handler(ctx, input) {
    seen.push({ targetId: input.targetId, businessId: ctx.businessId, userId: ctx.userId });
    if (input.note === "refus") throw new ToolError("invalid_state", "Not now.", 409, "Try later.");
    if (input.note === "boom") throw new Error("database exploded");
    if (input.note === "bad") return { touched: 42 as unknown as string };
    return { touched: input.targetId };
  },
});

const spend = defineTool({
  name: "spend_money",
  title: "Spend money",
  description: "Pretends to call a model, for tests of the paywall.",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  scope: "write",
  paid: true,
  handler: async () => ({ ok: true }),
});

const look = defineTool({
  name: "look",
  title: "Look",
  description: "Reads nothing, for tests of scopes.",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  scope: "read",
  paid: false,
  handler: async () => ({ ok: true }),
});

const registry = createRegistry([touch, spend, look]);

function seed() {
  return new FakeSupabase({
    businesses: businesses(),
    placement_targets: [
      { id: T_A, user_id: USER, business_id: SITE_A },
      { id: T_B, user_id: USER, business_id: SITE_B },
      { id: T_C, user_id: OTHER, business_id: SITE_C },
    ],
  });
}

let info: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  seen.length = 0;
  subscription.active = true;
  subscription.clients = [];
  info = vi.spyOn(console, "info").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  info.mockRestore();
  error.mockRestore();
});

describe("runTool", () => {
  it("runs a tool with the caller's user and site, and returns its validated output", async () => {
    const db = seed();
    const run = await runTool(apiCaller(db), "touch_target", { targetId: T_A }, { registry });
    expect(run).toEqual({ ok: true, output: { touched: T_A } });
    expect(seen).toEqual([{ targetId: T_A, businessId: SITE_A, userId: USER }]);
  });

  it("answers unknown_tool for a name it does not have", async () => {
    const run = await runTool(apiCaller(seed()), "drop_tables", {}, { registry });
    expect(run).toMatchObject({ ok: false, status: 404, error: { code: "unknown_tool" } });
  });

  it("answers forbidden_scope when the key lacks write, or spend for a paid tool", async () => {
    const db = seed();
    expect(await runTool(apiCaller(db, { scopes: ["read"] }), "touch_target", { targetId: T_A }, { registry })).toMatchObject({
      ok: false,
      status: 403,
      error: { code: "forbidden_scope", message: "touch_target needs a key with the write scope." },
    });
    expect(await runTool(apiCaller(db, { scopes: ["read", "write"] }), "spend_money", {}, { registry })).toMatchObject({
      ok: false,
      status: 403,
      error: { code: "forbidden_scope", message: "spend_money needs a key with the spend scope." },
    });
    expect(await runTool(apiCaller(db, { scopes: ["read"] }), "look", {}, { registry })).toMatchObject({ ok: true });
    expect(seen).toEqual([]);
  });

  it("answers no_business when the account has no site", async () => {
    const run = await runTool(apiCaller(seed(), { businessId: null }), "look", {}, { registry });
    expect(run).toMatchObject({ ok: false, status: 409, error: { code: "no_business" } });
  });

  it("answers invalid_input with the field and the reason", async () => {
    const run = await runTool(apiCaller(seed()), "touch_target", { targetId: "nope" }, { registry });
    expect(run).toMatchObject({ ok: false, status: 400, error: { code: "invalid_input" } });
    expect(!run.ok && run.error.message).toMatch(/^targetId: /);
  });

  it("never lets a key for site A touch site B, or another account's site", async () => {
    const db = seed();
    for (const foreign of [T_B, T_C]) {
      const run = await runTool(apiCaller(db), "touch_target", { targetId: foreign }, { registry });
      expect(run).toMatchObject({
        ok: false,
        status: 404,
        error: { code: "not_found", message: "No reply target with that targetId on this site." },
      });
    }
    expect(seen).toEqual([]);
    // The same key, scoped to B, reaches B.
    expect(await runTool(apiCaller(db, { businessId: SITE_B }), "touch_target", { targetId: T_B }, { registry })).toMatchObject({
      ok: true,
    });
  });

  it("applies the paywall to API callers, read through their own client", async () => {
    const db = seed();
    subscription.active = false;
    const caller = apiCaller(db);
    const run = await runTool(caller, "spend_money", {}, { registry });
    expect(run).toEqual({
      ok: false,
      status: 402,
      error: {
        code: "subscription_required",
        message: PLAN_REQUIRED_MESSAGE,
        hint: PLAN_REQUIRED_HINT,
      },
    });
    expect(subscription.clients).toEqual([caller.client]);
  });

  it("passes a handler's refusal through with its code and hint", async () => {
    const run = await runTool(apiCaller(seed()), "touch_target", { targetId: T_A, note: "refus" }, { registry });
    expect(run).toEqual({ ok: false, status: 409, error: { code: "invalid_state", message: "Not now.", hint: "Try later." } });
  });

  it("answers internal, without the raw error, when a handler throws or returns the wrong shape", async () => {
    const thrown = await runTool(apiCaller(seed()), "touch_target", { targetId: T_A, note: "boom" }, { registry });
    expect(thrown).toMatchObject({ ok: false, status: 500, error: { code: "internal" } });
    expect(!thrown.ok && thrown.error.message).not.toContain("exploded");

    const shaped = await runTool(apiCaller(seed()), "touch_target", { targetId: T_A, note: "bad" }, { registry });
    expect(shaped).toMatchObject({ ok: false, status: 500, error: { code: "internal" } });
    expect(error).toHaveBeenCalled();
  });
});
