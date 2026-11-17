import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { FakeSupabase } from "../support/fake-supabase";
import {
  DEFAULT_DAILY_SPEND_USD,
  SPEND_UNREADABLE_MESSAGE,
  checkAccountSpend,
  globalCeiling,
  globalDailySpendUsd,
  readAccountSpend,
  resetSpendWarnings,
  spendCapMessage,
  spendHeldMessage,
} from "@/lib/limits/spend";
import { UNKNOWN_AGENT_ESTIMATE_USD, estimateUnmeasuredRunUsd } from "@/lib/limits/estimates";
import { llmFailureKind } from "@/lib/providers/llm/types";
import { isMissingRelation } from "@/lib/supabase/errors";

/**
 * The daily AI spend ceiling per account (lib/limits/spend.ts). What is
 * pinned: the ceiling is the account's own, else ACCOUNT_DAILY_SPEND_USD,
 * else $5; the spend is the model cost the account's runs recorded over the
 * last 24 hours, every site together; a run with no recorded cost counts at
 * a conservative estimate by agent and model, never $0, and is kept apart as
 * an estimate; at the ceiling and above, `spend_cap_reached`, with when the
 * window frees; a read that fails refuses (fail closed); a missing table
 * lets the action through with one warning (fail open).
 */

const USER = "user-1";
const NOW = new Date("2026-11-10T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

function run(over: Record<string, unknown> = {}) {
  return { user_id: USER, agent: "writing", model: "claude-sonnet-5-5", cost_usd: 1, created_at: ago(HOUR), ...over };
}

function db(runs: Array<Record<string, unknown>>, limits: Array<Record<string, unknown>> = []) {
  return new FakeSupabase({ agent_runs: runs, account_limits: limits }) as unknown as SupabaseClient;
}

/** A client whose `table` answers with `error` and every other table as the fake does. */
function failing(base: SupabaseClient, table: string, error: Record<string, unknown>): SupabaseClient {
  return new Proxy(base, {
    get(target, property, receiver) {
      if (property !== "from") return Reflect.get(target, property, receiver);
      return (name: string) => {
        if (name !== table) return (target as unknown as FakeSupabase).from(name);
        const answer = Promise.resolve({ data: null, error });
        const query: Record<string, unknown> = {};
        for (const method of ["select", "eq", "gte", "order", "limit"]) query[method] = () => query;
        query.range = () => answer;
        query.maybeSingle = () => answer;
        query.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => answer.then(resolve, reject);
        return query;
      };
    },
  }) as unknown as SupabaseClient;
}

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resetSpendWarnings();
  vi.unstubAllEnvs();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the ceiling", () => {
  it("is $5 by default, the environment's when set, and $5 again for a value that is not a positive number", () => {
    expect(DEFAULT_DAILY_SPEND_USD).toBe(5);
    expect(globalDailySpendUsd(undefined)).toBe(5);
    expect(globalDailySpendUsd("12.5")).toBe(12.5);
    for (const bad of ["abc", "0", "-3", "Infinity", "NaN"]) expect(globalDailySpendUsd(bad)).toBe(5);
    expect(globalCeiling("8")).toEqual({ usd: 8, source: "env" });
    expect(globalCeiling("")).toEqual({ usd: 5, source: "default" });
  });

  it("is the account's own when it set one, over the environment's", async () => {
    vi.stubEnv("ACCOUNT_DAILY_SPEND_USD", "8");
    const own = await readAccountSpend(db([], [{ user_id: USER, daily_spend_usd: 20 }]), USER, NOW);
    expect(own).toMatchObject({ ok: true, spend: { ceiling: { usd: 20, source: "account" } } });
    const other = await readAccountSpend(db([], [{ user_id: "someone-else", daily_spend_usd: 20 }]), USER, NOW);
    expect(other).toMatchObject({ ok: true, spend: { ceiling: { usd: 8, source: "env" } } });
  });
});

describe("the spend", () => {
  it("sums the model cost the account recorded in the last 24 hours, every site together", async () => {
    const reading = await readAccountSpend(
      db([
        run({ cost_usd: 0.4, business_id: "site-a" }),
        run({ cost_usd: "0.35", business_id: "site-b" }),
        run({ cost_usd: 3, created_at: ago(25 * HOUR) }),
        run({ cost_usd: 3, user_id: "someone-else" }),
      ]),
      USER,
      NOW
    );
    expect(reading).toMatchObject({
      ok: true,
      spend: { measuredUsd: 0.75, measuredRuns: 2, estimatedUsd: 0, unmeasuredRuns: 0, totalUsd: 0.75, reached: false, freesAt: null },
    });
  });

  it("counts a run with no recorded cost at an estimate for its agent and model, never as 0, and keeps the estimate apart", async () => {
    const reading = await readAccountSpend(
      db([
        run({ cost_usd: 0.1 }),
        run({ cost_usd: null, agent: "writing", model: null }),
        run({ cost_usd: null, agent: "writing", model: "gemini-2.5-flash" }),
        run({ cost_usd: null, agent: "a-new-agent", model: null }),
      ]),
      USER,
      NOW
    );
    expect(reading.ok).toBe(true);
    if (!reading.ok) return;
    const expected = estimateUnmeasuredRunUsd("writing", null) + estimateUnmeasuredRunUsd("writing", "gemini-2.5-flash") + UNKNOWN_AGENT_ESTIMATE_USD;
    expect(reading.spend.unmeasuredRuns).toBe(3);
    expect(reading.spend.estimatedUsd).toBeCloseTo(expected, 6);
    expect(reading.spend.estimatedUsd).toBeGreaterThan(0);
    expect(reading.spend.measuredUsd).toBeCloseTo(0.1, 6);
    expect(reading.spend.totalUsd).toBeCloseTo(0.1 + expected, 6);
  });

  it("estimates by agent, cheaper when a Flash or Haiku model answered, dearest for an agent it does not know", () => {
    expect(estimateUnmeasuredRunUsd("writing", null)).toBe(0.15);
    expect(estimateUnmeasuredRunUsd("writing", "claude-sonnet-5-5")).toBe(0.15);
    expect(estimateUnmeasuredRunUsd("writing", "gemini-2.5-flash")).toBe(0.03);
    expect(estimateUnmeasuredRunUsd("placement-qualify", "claude-haiku-4-5-20251001")).toBe(0.01);
    expect(estimateUnmeasuredRunUsd("never-heard-of-it", "gemini-2.5-flash")).toBe(UNKNOWN_AGENT_ESTIMATE_USD);
    expect(UNKNOWN_AGENT_ESTIMATE_USD).toBe(0.15);
  });

  it("reads past one page of runs", async () => {
    const runs = Array.from({ length: 1500 }, (_, i) => run({ cost_usd: 0.001, created_at: ago(HOUR + i * 1000) }));
    const reading = await readAccountSpend(db(runs), USER, NOW);
    expect(reading).toMatchObject({ ok: true, spend: { measuredRuns: 1500 } });
    if (reading.ok) expect(reading.spend.totalUsd).toBeCloseTo(1.5, 6);
  });
});

describe("the check", () => {
  it("lets the account spend under its ceiling", async () => {
    expect(await checkAccountSpend(db([run({ cost_usd: 4.99 })]), USER, NOW)).toMatchObject({ ok: true });
  });

  it("refuses at the ceiling and above, in the sentence the screens and the API show", async () => {
    for (const total of [5, 5.01, 40]) {
      const verdict = await checkAccountSpend(db([run({ cost_usd: total })]), USER, NOW);
      expect(verdict).toMatchObject({
        ok: false,
        code: "spend_cap_reached",
        ceilingUsd: 5,
        // The customer's terms: when it resets, never the amount.
        message: "You've reached today's limit for AI work. It resets at about 11:00 UTC on Nov 11.",
      });
    }
    expect(spendCapMessage(null)).toBe("You've reached today's limit for AI work. It resets within 24 hours.");
    expect(spendCapMessage(new Date("2026-11-11T11:00:00.000Z"))).not.toMatch(/\$|spend|Billing/);
  });

  it("refuses when the estimates alone reach it: an unmeasured run is not free", async () => {
    const unmeasured = Array.from({ length: 34 }, () => run({ cost_usd: null, agent: "writing", model: null }));
    expect(await checkAccountSpend(db(unmeasured), USER, NOW)).toMatchObject({ ok: false, code: "spend_cap_reached" });
  });

  it("says when the window frees: when the run that crossed the ceiling leaves the 24 hours", async () => {
    const verdict = await checkAccountSpend(
      db([
        run({ cost_usd: 2, created_at: ago(1 * HOUR) }),
        run({ cost_usd: 2, created_at: ago(3 * HOUR) }),
        run({ cost_usd: 2, created_at: ago(5 * HOUR) }),
        run({ cost_usd: 2, created_at: ago(7 * HOUR) }),
      ]),
      USER,
      NOW
    );
    // Newest first: 2, 4, 6 ≥ 5 at the run 5 hours old. Once it is 24 hours
    // old, the two newer runs ($4) are all that is left.
    expect(verdict).toMatchObject({ ok: false, code: "spend_cap_reached" });
    if (!verdict.ok && verdict.code === "spend_cap_reached") {
      expect(verdict.freesAt.toISOString()).toBe(new Date(NOW.getTime() - 5 * HOUR + 24 * HOUR).toISOString());
    }
  });

  it("holds the account to its own higher ceiling", async () => {
    const runs = [run({ cost_usd: 7 })];
    expect(await checkAccountSpend(db(runs, [{ user_id: USER, daily_spend_usd: 10 }]), USER, NOW)).toMatchObject({ ok: true });
    expect(await checkAccountSpend(db(runs, [{ user_id: USER, daily_spend_usd: 6 }]), USER, NOW)).toMatchObject({
      ok: false,
      ceilingUsd: 6,
    });
  });

  it("fails closed when the spend cannot be read", async () => {
    const broken = failing(db([]), "agent_runs", { code: "57014", message: "canceling statement due to statement timeout" });
    expect(await checkAccountSpend(broken, USER, NOW)).toEqual({
      ok: false,
      code: "spend_unreadable",
      message: SPEND_UNREADABLE_MESSAGE,
      detail: "agent_runs: canceling statement due to statement timeout",
    });
    const brokenLimits = failing(db([]), "account_limits", { code: "08006", message: "connection failure" });
    expect(await checkAccountSpend(brokenLimits, USER, NOW)).toMatchObject({ ok: false, code: "spend_unreadable" });
    expect(error).toHaveBeenCalled();
  });

  it("fails open, with one warning, when a table is not there yet", async () => {
    const noLimits = failing(db([run({ cost_usd: 1 })]), "account_limits", {
      code: "PGRST205",
      message: "Could not find the table 'public.account_limits' in the schema cache",
    });
    expect(await checkAccountSpend(noLimits, USER, NOW)).toMatchObject({ ok: true, spend: { ceiling: { usd: 5, source: "default" } } });

    const noRuns = failing(db([]), "agent_runs", { code: "42P01", message: 'relation "public.agent_runs" does not exist' });
    expect(await checkAccountSpend(noRuns, USER, NOW)).toEqual({ ok: true, spend: null });
    expect(await checkAccountSpend(noRuns, USER, NOW)).toEqual({ ok: true, spend: null });
    const events = warn.mock.calls.map((args: unknown[]) => JSON.parse(String(args[0])).event);
    expect(events.filter((e: string) => e === "spend.ceiling_unavailable")).toHaveLength(1);
    expect(events).toContain("spend.limits_table_missing");
  });

  it("tells a missing table from any other error", () => {
    expect(isMissingRelation({ code: "42P01" })).toBe(true);
    expect(isMissingRelation({ code: "PGRST205" })).toBe(true);
    expect(isMissingRelation({ message: 'relation "public.tool_calls" does not exist' })).toBe(true);
    expect(isMissingRelation({ code: "57014", message: "statement timeout" })).toBe(false);
    expect(isMissingRelation(null)).toBe(false);
  });

  it("holds a job with a sentence no surface reads as a provider failure", () => {
    const held = spendHeldMessage(new Date("2026-11-11T11:00:00.000Z"));
    expect(held).toBe("Waiting: today's limit for AI work is reached. This resumes on its own at about 11:00 UTC on Nov 11.");
    expect(held).not.toContain("$");
    expect(llmFailureKind(held)).toBeNull();
    expect(llmFailureKind(spendHeldMessage(null))).toBeNull();
  });
});
