import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { FakeSupabase } from "../support/fake-supabase";

/**
 * An account's daily AI spend ceiling, set by a platform owner
 * (lib/limits/settings.ts and POST /api/owner/spend-limit). What is pinned:
 * $1 to $100, to the cent, refused otherwise in words; lowering saves at
 * once; raising without `confirm: true` changes nothing and answers 409
 * `confirmation_required` with the question the second tap answers; with
 * it, the row is stored for the named account only; anyone who is not an
 * owner (a customer, the signed out, everyone when PLATFORM_OWNER_USER_IDS
 * is unset) gets the 404 a path that does not exist gets, and nothing is
 * written; the route reads the session only, so no API key reaches it; a
 * missing table is a 503, not a silent success.
 */

const OWNER = "22222222-2222-4222-8222-222222222222";
const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const OTHER = "33333333-3333-4333-8333-333333333333";

const state = vi.hoisted(() => ({ db: null as unknown, user: null as { id: string } | null, authHeaderSeen: false }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
    from: (table: string) => (state.db as FakeSupabase).from(table),
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => state.db,
}));

import { POST } from "@/app/api/owner/spend-limit/route";
import { parseSpendLimit, raiseQuestion, saveDailySpendLimit } from "@/lib/limits/settings";

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://gettrafficfa.st/api/owner/spend-limit", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  }) as never;

let db: FakeSupabase;
beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("PLATFORM_OWNER_USER_IDS", OWNER);
  db = new FakeSupabase({ account_limits: [] });
  state.db = db;
  state.user = { id: OWNER };
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

describe("what the owner types", () => {
  it("takes $1 to $100, to the cent, with or without the dollar sign", () => {
    expect(parseSpendLimit("20")).toEqual({ ok: true, value: 20 });
    expect(parseSpendLimit(" $7.50 ")).toEqual({ ok: true, value: 7.5 });
    expect(parseSpendLimit("1")).toEqual({ ok: true, value: 1 });
    expect(parseSpendLimit("100")).toEqual({ ok: true, value: 100 });
  });

  it("refuses anything else, saying why", () => {
    expect(parseSpendLimit("0.99")).toEqual({ ok: false, error: "The daily limit is at least $1." });
    expect(parseSpendLimit("100.01")).toEqual({ ok: false, error: "The daily limit is at most $100." });
    expect(parseSpendLimit("5.555")).toEqual({ ok: false, error: "Use dollars and cents, at most two decimals." });
    for (const bad of ["", "abc", "-5", "1e3", "5,50"]) {
      expect(parseSpendLimit(bad)).toEqual({ ok: false, error: "Enter an amount between $1 and $100." });
    }
  });
});

describe("saving it", () => {
  const save = (input: unknown) => saveDailySpendLimit({ supabase: db as unknown as SupabaseClient, userId: CUSTOMER, input });

  it("lowers at once, without asking", async () => {
    expect(await save({ dailySpendUsd: 3 })).toMatchObject({ ok: true, ceiling: { usd: 3, source: "account" }, previousUsd: 5 });
    expect(db.tables.account_limits).toEqual([expect.objectContaining({ user_id: CUSTOMER, daily_spend_usd: 3 })]);
  });

  it("refuses a raise that was not confirmed, and changes nothing", async () => {
    const refused = await save({ dailySpendUsd: 20 });
    expect(refused).toEqual({ ok: false, status: 409, code: "confirmation_required", error: raiseQuestion(5, 20) });
    expect(raiseQuestion(5, 20)).toBe(
      "Raise this account's daily AI spend ceiling from $5 to $20? Up to $20 of model cost can then be spent on it in any 24 hours."
    );
    expect(db.tables.account_limits).toEqual([]);
  });

  it("raises once confirmed, over the account's own earlier ceiling, for that account only", async () => {
    db.tables.account_limits.push({ user_id: CUSTOMER, daily_spend_usd: 10 }, { user_id: OTHER, daily_spend_usd: 50 });
    expect(await save({ dailySpendUsd: 25 })).toMatchObject({ ok: false, code: "confirmation_required" });
    expect(await save({ dailySpendUsd: 25, confirm: true })).toMatchObject({ ok: true, previousUsd: 10 });
    expect(db.tables.account_limits.map((row) => [row.user_id, row.daily_spend_usd])).toEqual([
      [CUSTOMER, 25],
      [OTHER, 50],
    ]);
  });

  it("compares a raise with the ceiling in force, the environment's included", async () => {
    vi.stubEnv("ACCOUNT_DAILY_SPEND_USD", "30");
    expect(await save({ dailySpendUsd: 20 })).toMatchObject({ ok: true, previousUsd: 30 });
  });

  it("refuses an amount out of bounds or not a number, in words", async () => {
    expect(await save({ dailySpendUsd: 0.5, confirm: true })).toMatchObject({ ok: false, status: 400, error: "The daily limit is at least $1." });
    expect(await save({ dailySpendUsd: 101, confirm: true })).toMatchObject({ ok: false, status: 400, error: "The daily limit is at most $100." });
    expect(await save({ dailySpendUsd: "20" })).toMatchObject({ ok: false, status: 400 });
    expect(await save(null)).toMatchObject({ ok: false, status: 400 });
    expect(db.tables.account_limits).toEqual([]);
  });

  it("says so when the table is not there yet, rather than pretending it saved", async () => {
    const missing = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== "from") return Reflect.get(target, property, receiver);
        return (table: string) => {
          const failure = { code: "PGRST205", message: "Could not find the table 'public.account_limits' in the schema cache" };
          const query: Record<string, unknown> = {};
          for (const method of ["select", "eq"]) query[method] = () => query;
          query.maybeSingle = async () => ({ data: null, error: failure });
          query.upsert = async () => ({ data: null, error: failure });
          return table === "account_limits" ? query : target.from(table);
        };
      },
    }) as unknown as SupabaseClient;
    expect(await saveDailySpendLimit({ supabase: missing, userId: CUSTOMER, input: { dailySpendUsd: 3 } })).toMatchObject({
      ok: false,
      status: 503,
      code: "unavailable",
    });
  });
});

describe("POST /api/owner/spend-limit", () => {
  it("answers 404 to anyone who is not an owner, signed out included, and writes nothing", async () => {
    state.user = null;
    const signedOut = await POST(post({ userId: CUSTOMER, dailySpendUsd: 3 }));
    expect(signedOut.status).toBe(404);
    expect(await signedOut.json()).toEqual({ error: "Not found" });

    // A customer, even naming his own account, and even lowering it.
    state.user = { id: CUSTOMER };
    for (const body of [
      { userId: CUSTOMER, dailySpendUsd: 3 },
      { userId: CUSTOMER, dailySpendUsd: 80, confirm: true },
      { userId: OTHER, dailySpendUsd: 80, confirm: true },
    ]) {
      const refused = await POST(post(body));
      expect(refused.status).toBe(404);
      expect(await refused.json()).toEqual({ error: "Not found" });
    }
    expect(db.tables.account_limits).toEqual([]);
  });

  it("fails closed: with PLATFORM_OWNER_USER_IDS unset or blank, nobody is an owner", async () => {
    for (const value of [undefined, "", " , "]) {
      vi.stubEnv("PLATFORM_OWNER_USER_IDS", value);
      expect((await POST(post({ userId: CUSTOMER, dailySpendUsd: 3 }))).status).toBe(404);
    }
    expect(db.tables.account_limits).toEqual([]);
  });

  it("reads the session only: a Bearer key does not make its holder an owner", async () => {
    state.user = null;
    const keyed = await POST(post({ userId: CUSTOMER, dailySpendUsd: 50, confirm: true }, { Authorization: "Bearer gtf_owner_key" }));
    expect(keyed.status).toBe(404);
    expect(db.tables.account_limits).toEqual([]);
  });

  it("asks before a raise, saves it once confirmed, and lowers at once, for the named account", async () => {
    const ask = await POST(post({ userId: CUSTOMER, dailySpendUsd: 40 }));
    expect(ask.status).toBe(409);
    expect(await ask.json()).toEqual({ code: "confirmation_required", error: raiseQuestion(5, 40) });
    expect(db.tables.account_limits).toEqual([]);

    const raised = await POST(post({ userId: CUSTOMER, dailySpendUsd: 40, confirm: true }));
    expect(raised.status).toBe(200);
    expect(await raised.json()).toEqual({ userId: CUSTOMER, dailySpendUsd: 40, previousUsd: 5 });

    const lowered = await POST(post({ userId: CUSTOMER, dailySpendUsd: 2 }));
    expect(await lowered.json()).toEqual({ userId: CUSTOMER, dailySpendUsd: 2, previousUsd: 40 });
    expect(db.tables.account_limits).toEqual([expect.objectContaining({ user_id: CUSTOMER, daily_spend_usd: 2 })]);

    const bad = await POST(post({ userId: CUSTOMER, dailySpendUsd: 500, confirm: true }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ code: "invalid_input", error: "The daily limit is at most $100." });

    const nobody = await POST(post({ dailySpendUsd: 5 }));
    expect(nobody.status).toBe(400);
  });
});
