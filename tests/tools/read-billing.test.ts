import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeSupabase } from "../support/fake-supabase";
import { OTHER, apiCaller } from "./support";
import { readSeed } from "./read-support";

/**
 * `get_subscription`, as an API-key caller with the read scope only: the
 * account's own row as the Billing page reads it, never another account's;
 * a date the row does not carry stays null.
 */

const m = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => m.db }));

import { runTool } from "@/lib/tools/runner";

let db: FakeSupabase;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-09T12:00:00.000Z"));
  db = readSeed();
  m.db = db;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("get_subscription", () => {
  it("answers the account's subscription as Billing shows it", async () => {
    const run = await runTool(apiCaller(db, { scopes: ["read"] }), "get_subscription", {});
    expect(run).toEqual({
      ok: true,
      output: {
        subscription: {
          status: "trialing",
          statusLabel: "Free trial",
          active: true,
          currentPeriodStart: "2026-11-01T00:00:00.000Z",
          currentPeriodEnd: "2099-11-15T00:00:00.000Z",
          cancelAtPeriodEnd: false,
          dateLabel: "Trial ends",
          date: "2099-11-15T00:00:00.000Z",
          needsAttention: false,
          updatedAt: "2026-11-01T00:00:00.000Z",
        },
      },
    });
    expect(JSON.stringify(run)).not.toContain("cus_");
  });

  it("is refused, like every tool, to an account whose plan is past due or missing", async () => {
    const other = await runTool(apiCaller(db, { scopes: ["read"], userId: OTHER, businessId: null }), "get_subscription", {});
    expect(other).toMatchObject({ ok: false, status: 402, error: { code: "subscription_required" } });
    db.tables.subscriptions = [];
    expect(await runTool(apiCaller(db, { scopes: ["read"] }), "get_subscription", {})).toMatchObject({
      ok: false,
      status: 402,
      error: { code: "subscription_required" },
    });
  });
});
