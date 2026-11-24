import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ captureMessage: vi.fn(), sendNotificationEmail: vi.fn(async () => true) }));
vi.mock("@sentry/nextjs", () => ({ captureMessage: mocks.captureMessage, captureException: vi.fn() }));
vi.mock("@/lib/notifications/email", () => ({
  operatorEmailAddress: () => "ops@example.test",
  sendNotificationEmail: mocks.sendNotificationEmail,
}));

import { XApiError, type XApiClient } from "@/lib/providers/x/api";
import { monthOf, nextMonthStart, readProviderSpend } from "@/lib/limits/provider-spend";
import {
  X_ACCOUNT_CALL_WORST_USD,
  X_ACCOUNT_RUN_WORST_USD,
  X_METRICS_RUN_WORST_USD,
  X_SEARCH_CALL_WORST_USD,
  X_SEARCH_RUN_WORST_USD,
  meteredXCall,
  monthlyEstimateUsd,
  readXApiStatus,
  xCapReachedLine,
  xSearchNotice,
} from "@/lib/placements/x-budget";
import { LedgerFake, fakeXClient, xPost } from "./x-fake";

/**
 * The cap is the promise to the owner: $20 a month whatever happens. What
 * is pinned: a call that would cross it is refused BEFORE it is made, with
 * one operator alert a month; the ledger accumulates what was spent and a
 * new month starts from zero; a billing refusal pauses every call for an
 * hour; a ledger that cannot be written refuses the call; no client, no call.
 */

const NOW = new Date("2026-11-20T13:20:00.000Z");
let quiet: Array<ReturnType<typeof vi.spyOn>>;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  env = { ...process.env };
  mocks.captureMessage.mockReset();
  mocks.sendNotificationEmail.mockClear();
  quiet = (["log", "warn", "error"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
});
afterEach(() => {
  process.env = env;
  quiet.forEach((spy) => spy.mockRestore());
});

const search = (client: XApiClient) => client.searchRecent({ query: "aeo", maxResults: 20, startTime: NOW });

describe("the plan", () => {
  it("costs at most $0.15 a site a day to search (three searches of ten), $0.50 a day to read 100 replies' numbers, $0.01 a site a day for the followers", () => {
    // A search reserves its posts and, at worst, two posts each quotes or answers (2026-11-14).
    expect(X_SEARCH_CALL_WORST_USD).toBe(0.15);
    expect(X_SEARCH_RUN_WORST_USD).toBe(0.15);
    expect(X_METRICS_RUN_WORST_USD).toBe(0.5);
    expect(X_ACCOUNT_CALL_WORST_USD).toBe(0.01);
    expect(X_ACCOUNT_RUN_WORST_USD).toBe(0.1);
    expect(monthlyEstimateUsd({ repliesPerDay: 3 })).toEqual({ searchUsd: 4.5, referencedUsd: 0, metricsUsd: 6.3, accountUsd: 0.3, totalUsd: 11.1 });
    // Every found post quoting one post: +$4.50; the worst (quoting and answering): +$9.
    expect(monthlyEstimateUsd({ repliesPerDay: 3, referencedPerPost: 1 })).toMatchObject({ referencedUsd: 4.5, totalUsd: 15.6 });
    expect(monthlyEstimateUsd({ repliesPerDay: 3, referencedPerPost: 5 }).referencedUsd).toBe(9);
    expect(monthlyEstimateUsd({ repliesPerDay: 0 })).toMatchObject({ metricsUsd: 0 });
    // The followers are read for 10 sites a run at most: $3 a month whatever the number of sites.
    expect(monthlyEstimateUsd({ repliesPerDay: 0, businesses: 25 }).accountUsd).toBe(3);
  });

  it("says the cap is reached in the customer's words: when it comes back, never the amount", () => {
    expect(xCapReachedLine(new Date("2026-12-01T00:00:00.000Z"))).toBe("Searching X is paused until Dec 1: this month's allowance for X is used up.");
    expect(xCapReachedLine(new Date("2026-12-01T00:00:00.000Z"))).not.toContain("$");
  });
});

describe("the ledger", () => {
  it("accumulates every call's estimate, counts calls and posts, and starts each month from zero", async () => {
    const db = new LedgerFake();
    const { client } = fakeXClient({ searches: [[xPost("1"), xPost("2")], [xPost("3")]] });
    const supabase = db as never;

    const first = await meteredXCall({ supabase, client, worstCaseUsd: 0.1, capUsd: 20, run: search, now: NOW });
    const second = await meteredXCall({ supabase, client, worstCaseUsd: 0.1, capUsd: 20, run: search, now: NOW });
    expect(first.ok && second.ok).toBe(true);
    // The worst case reserved ($0.10 each) was settled to what came back.
    expect(db.spend("2026-11-01")).toMatchObject({ cost_usd: 0.015, calls: 2, posts: 3 });
    expect(second.ok && second.monthSpentUsd).toBe(0.015);

    const december = new Date("2026-12-01T00:05:00.000Z");
    expect(monthOf(december)).toBe("2026-12-01");
    expect(nextMonthStart(NOW).toISOString()).toBe("2026-12-01T00:00:00.000Z");
    const reading = await readProviderSpend(supabase, "x-api", december);
    expect(reading).toEqual({ ok: true, spend: { month: "2026-12-01", costUsd: 0, calls: 0, posts: 0 } });
  });

  it("gives the reservation back when the call failed", async () => {
    const db = new LedgerFake();
    const client = { searchRecent: vi.fn(async () => Promise.reject(new XApiError("boom", "http", { status: 500 }))) } as unknown as XApiClient;
    const out = await meteredXCall({ supabase: db as never, client, worstCaseUsd: 0.1, capUsd: 20, run: search, now: NOW });
    expect(out).toMatchObject({ ok: false, reason: "error" });
    expect(db.spend("2026-11-01")).toMatchObject({ cost_usd: 0, calls: 1, posts: 0 });
  });
});

describe("the cap", () => {
  it("refuses a call whose worst case would cross the cap, before calling, and alerts the operator once a month", async () => {
    const db = new LedgerFake({ provider_spend: [{ provider: "x-api", month: "2026-11-01", cost_usd: 19.95, calls: 300, posts: 3990 }] });
    const { client, searchRecent } = fakeXClient({ searches: [[xPost("1")]] });

    const refused = await meteredXCall({ supabase: db as never, client, worstCaseUsd: 0.1, capUsd: 20, run: search, now: NOW });
    expect(refused).toEqual({ ok: false, reason: "cap", message: "Searching X is paused until Dec 1: this month's allowance for X is used up." });
    expect(searchRecent).not.toHaveBeenCalled();
    expect(db.spend("2026-11-01")).toMatchObject({ cost_usd: 19.95 });
    expect(db.tables.operator_alerts).toEqual([expect.objectContaining({ alert_key: "x-api:cap:2026-11", day: "2026-11-01" })]);
    expect(mocks.captureMessage).toHaveBeenCalledTimes(1);
    expect(mocks.sendNotificationEmail).toHaveBeenCalledTimes(1);

    // Later the same month: refused again, no second alert.
    await meteredXCall({ supabase: db as never, client, worstCaseUsd: 0.1, capUsd: 20, run: search, now: new Date("2026-11-27T13:20:00Z") });
    expect(mocks.captureMessage).toHaveBeenCalledTimes(1);
    expect(searchRecent).not.toHaveBeenCalled();

    // A call that still fits goes through.
    const fits = await meteredXCall({ supabase: db as never, client, worstCaseUsd: 0.05, capUsd: 20, run: search, now: NOW });
    expect(fits.ok).toBe(true);
    expect(searchRecent).toHaveBeenCalledTimes(1);
  });

  it("refuses when the ledger cannot be written: a missing table is never a licence to spend", async () => {
    const db = new LedgerFake();
    db.rpcError = "function reserve_provider_spend does not exist";
    const { client, searchRecent } = fakeXClient({ searches: [[xPost("1")]] });
    const out = await meteredXCall({ supabase: db as never, client, worstCaseUsd: 0.1, capUsd: 20, run: search, now: NOW });
    expect(out).toMatchObject({ ok: false, reason: "ledger" });
    expect(searchRecent).not.toHaveBeenCalled();
  });

  it("makes no call at all without a client (the platform has not opted in)", async () => {
    const db = new LedgerFake();
    const out = await meteredXCall({ supabase: db as never, client: null, worstCaseUsd: 0.1, capUsd: 20, run: search, now: NOW });
    expect(out).toMatchObject({ ok: false, reason: "disabled" });
    expect(db.tables.provider_spend).toEqual([]);
  });
});

describe("the billing pause", () => {
  it("pauses every X call for an hour on a billing refusal, alerts, and refuses without calling while it holds", async () => {
    const db = new LedgerFake();
    const searchRecent = vi.fn(async () => Promise.reject(new XApiError("X API billing refused (402): CreditsDepleted", "billing", { status: 402 })));
    const client = { searchRecent } as unknown as XApiClient;

    const refused = await meteredXCall({ supabase: db as never, client, worstCaseUsd: 0.1, capUsd: 20, run: search, now: NOW });
    expect(refused).toMatchObject({ ok: false, reason: "billing", pausedUntil: "2026-11-20T14:20:00.000Z" });
    expect(db.tables.provider_pauses).toEqual([expect.objectContaining({ kind: "x-api", paused_until: "2026-11-20T14:20:00.000Z" })]);
    expect(db.tables.operator_alerts).toEqual([expect.objectContaining({ alert_key: "x-api:billing", day: "2026-11-20" })]);

    const held = await meteredXCall({ supabase: db as never, client, worstCaseUsd: 0.1, capUsd: 20, run: search, now: new Date("2026-11-20T13:50:00Z") });
    expect(held).toMatchObject({ ok: false, reason: "paused" });
    expect(searchRecent).toHaveBeenCalledTimes(1);

    // After the hour the next call simply tries.
    await meteredXCall({ supabase: db as never, client, worstCaseUsd: 0.1, capUsd: 20, run: search, now: new Date("2026-11-20T14:21:00Z") });
    expect(searchRecent).toHaveBeenCalledTimes(2);
  });
});

describe("what the screens read", () => {
  it("is nothing while the platform has not opted in, and the cap line once the next search would cross it", async () => {
    delete process.env.X_API_ENABLED;
    process.env.X_API_BEARER_TOKEN = "t";
    const db = new LedgerFake({ provider_spend: [{ provider: "x-api", month: "2026-11-01", cost_usd: 19.97, calls: 1, posts: 1 }] });
    const off = await readXApiStatus(db as never, NOW);
    expect(off.enabled).toBe(false);
    expect(xSearchNotice(off)).toBeNull();

    process.env.X_API_ENABLED = "1";
    delete process.env.X_API_MONTHLY_CAP_USD;
    const on = await readXApiStatus(db as never, NOW);
    expect(on).toMatchObject({ enabled: true, capUsd: 20, spentUsd: 19.97, capReached: true, resetsAt: "2026-12-01T00:00:00.000Z" });
    expect(xSearchNotice(on)).toEqual({ capReached: true, line: "Searching X is paused until Dec 1: this month's allowance for X is used up." });

    db.tables.provider_spend[0].cost_usd = 3.4;
    expect(xSearchNotice(await readXApiStatus(db as never, NOW))).toEqual({ capReached: false, line: null });
  });
});
