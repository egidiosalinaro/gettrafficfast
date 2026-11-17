import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { FakeSupabase } from "../support/fake-supabase";

/**
 * The owner's costs (/settings/costs, lib/limits/platform-costs.ts). What is
 * pinned: the page is a 404 for anyone who is not a platform owner, before
 * anything is read, and fails closed with PLATFORM_OWNER_USER_IDS unset; for
 * an owner it shows the month's ledger per provider (X against its cap, and
 * whatever else the ledger holds) and each account's model cost over 24
 * hours against its ceiling, counted the way the ceiling counts (a null cost
 * estimated, never $0); what could not be read says so; and the ceiling
 * control keeps its bounds and its two-step raise.
 */

const OWNER = "22222222-2222-4222-8222-222222222222";
const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const QUIET = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-11-14T12:00:00.000Z");
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

const state = vi.hoisted(() => ({
  userId: "",
  db: null as unknown,
  read: 0,
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  useRouter: () => ({ refresh: () => {} }),
}));
vi.mock("@/lib/app-access", () => ({
  requireAppAccess: async () => ({ userId: state.userId, user: null, businesses: [], selected: null }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    state.read += 1;
    return state.db;
  },
}));

import PlatformCostsPage from "@/app/(app)/settings/costs/page";
import { readPlatformCosts, type PlatformCosts } from "@/lib/limits/platform-costs";
import { PlatformCostsView, monthLabel } from "@/components/owner/platform-costs-view";
import { decideCeiling } from "@/components/owner/ceiling-form";
import { UNMEASURED_RUN_ESTIMATES } from "@/lib/limits/estimates";

function seed() {
  const db = new FakeSupabase({
    provider_spend: [
      { provider: "x-api", month: "2026-11-01", cost_usd: 3.4, calls: 120, posts: 680 },
      { provider: "serp", month: "2026-11-01", cost_usd: 1.25, calls: 400, posts: 0 },
      { provider: "x-api", month: "2026-10-01", cost_usd: 19.9, calls: 900, posts: 4000 },
    ],
    provider_pauses: [],
    agent_runs: [
      { user_id: CUSTOMER, agent: "writing", model: "claude-sonnet-5-5", cost_usd: 0.5, created_at: ago(HOUR) },
      { user_id: CUSTOMER, agent: "writing", model: "claude-sonnet-5-5", cost_usd: null, created_at: ago(2 * HOUR) },
      { user_id: OWNER, agent: "outline", model: "gemini-2.5-flash", cost_usd: 6, created_at: ago(3 * HOUR) },
      { user_id: CUSTOMER, agent: "writing", model: "claude-sonnet-5-5", cost_usd: 40, created_at: ago(30 * HOUR) },
    ],
    account_limits: [{ user_id: OWNER, daily_spend_usd: 5 }],
    subscriptions: [
      { user_id: CUSTOMER, status: "active" },
      { user_id: QUIET, status: "trialing" },
    ],
    businesses: [{ user_id: CUSTOMER, name: "Acme", website_url: "https://acme.test", created_at: "2026-01-01T00:00:00Z" }],
  });
  (db.auth.admin as unknown as { listUsers: unknown }).listUsers = async () => ({
    data: { users: [{ id: CUSTOMER, email: "ann@acme.test" }, { id: OWNER, email: "owner@gtf.test" }] },
    error: null,
  });
  return db;
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("PLATFORM_OWNER_USER_IDS", OWNER);
  vi.stubEnv("X_API_ENABLED", "1");
  vi.stubEnv("X_API_BEARER_TOKEN", "t");
  vi.stubEnv("X_API_MONTHLY_CAP_USD", "26");
  state.db = seed();
  state.read = 0;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/settings/costs", () => {
  it("is a 404 for a customer, before anything is read", async () => {
    state.userId = CUSTOMER;
    await expect(PlatformCostsPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(state.read).toBe(0);
  });

  it("fails closed: with no owner listed, it is a 404 for everyone", async () => {
    for (const value of [undefined, "", " , "]) {
      vi.stubEnv("PLATFORM_OWNER_USER_IDS", value);
      state.userId = OWNER;
      await expect(PlatformCostsPage()).rejects.toThrow("NEXT_NOT_FOUND");
    }
    expect(state.read).toBe(0);
  });

  it("renders the costs for an owner", async () => {
    state.userId = OWNER;
    const html = renderToStaticMarkup(await PlatformCostsPage());
    expect(state.read).toBe(1);
    expect(html).toContain("Platform costs");
    expect(html).toContain("X API");
  });
});

describe("readPlatformCosts", () => {
  it("reads this month's ledger per provider, X against its cap", async () => {
    const costs = await readPlatformCosts(state.db as SupabaseClient, NOW);
    expect(costs.month).toBe("2026-11");
    expect(costs.resetsAt).toBe("2026-12-01T00:00:00.000Z");
    expect(costs.providers).toEqual([
      expect.objectContaining({ provider: "serp", label: "serp", costUsd: 1.25, calls: 400, capUsd: null, capReached: false }),
      expect.objectContaining({ provider: "x-api", label: "X API", costUsd: 3.4, calls: 120, posts: 680, capUsd: 26, capReached: false, enabled: true }),
    ]);
  });

  it("shows X before its first call of the month, and a ledger it cannot read as unread, never $0", async () => {
    const db = state.db as FakeSupabase;
    db.tables.provider_spend = [];
    const empty = await readPlatformCosts(db as unknown as SupabaseClient, NOW);
    expect(empty.providers).toEqual([expect.objectContaining({ provider: "x-api", costUsd: 0, calls: 0, capUsd: 26 })]);

    const broken = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== "from") return Reflect.get(target, property, receiver);
        return (table: string) => {
          if (table !== "provider_spend") return target.from(table);
          const answer = Promise.resolve({ data: null, error: { message: "permission denied" } });
          const query: Record<string, unknown> = {};
          for (const method of ["select", "eq", "order"]) query[method] = () => query;
          query.maybeSingle = () => answer;
          query.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => answer.then(resolve, reject);
          return query;
        };
      },
    }) as unknown as SupabaseClient;
    const unread = await readPlatformCosts(broken, NOW);
    expect(unread.providers).toBeNull();
    expect(unread.providersError).toBe("permission denied");
    const html = renderToStaticMarkup(<PlatformCostsView costs={unread} />);
    expect(html).toContain("The ledger could not be read right now: permission denied");
  });

  it("counts each account's last 24 hours the way the ceiling does: a null cost estimated, apart", async () => {
    const costs = await readPlatformCosts(state.db as SupabaseClient, NOW);
    const estimate = UNMEASURED_RUN_ESTIMATES.writing.quality;
    const customer = costs.accounts!.find((a) => a.userId === CUSTOMER)!;
    expect(customer).toMatchObject({
      email: "ann@acme.test",
      site: "Acme",
      subscription: "active",
      measuredUsd: 0.5,
      estimatedUsd: estimate,
      spentUsd: 0.5 + estimate,
      runs: 2,
      unmeasuredRuns: 1,
      ceilingUsd: 5,
      ceilingSource: "default",
      reached: false,
      freesAt: null,
    });
    const owner = costs.accounts!.find((a) => a.userId === OWNER)!;
    expect(owner).toMatchObject({ spentUsd: 6, ceilingUsd: 5, ceilingSource: "account", reached: true, freesAt: "2026-11-15T09:00:00.000Z" });
    // An account with a live subscription and no run is listed at $0 measured: it can still be given a ceiling.
    expect(costs.accounts!.find((a) => a.userId === QUIET)).toMatchObject({ spentUsd: 0, runs: 0, reached: false });
    // Highest spend first.
    expect(costs.accounts!.map((a) => a.userId)).toEqual([OWNER, CUSTOMER, QUIET]);
    expect(costs.accountsComplete).toBe(true);
    expect(costs.aiTotalUsd).toBe(Math.round((6.5 + estimate) * 100) / 100);
  });

  it("follows ACCOUNT_DAILY_SPEND_USD for the default ceiling", async () => {
    vi.stubEnv("ACCOUNT_DAILY_SPEND_USD", "8");
    const costs = await readPlatformCosts(state.db as SupabaseClient, NOW);
    expect(costs.defaultCeiling).toEqual({ usd: 8, source: "env" });
    expect(costs.accounts!.find((a) => a.userId === CUSTOMER)).toMatchObject({ ceilingUsd: 8, ceilingSource: "env" });
  });
});

describe("the page", () => {
  it("shows the providers and the accounts in dollars, each account with its ceiling control", async () => {
    const costs = await readPlatformCosts(state.db as SupabaseClient, NOW);
    const html = renderToStaticMarkup(<PlatformCostsView costs={costs} />);
    expect(html).toContain("November 2026, per provider");
    expect(html).toContain("$3.40 of $26");
    expect(html).toContain("$1.25");
    expect(html).toContain("no monthly cap");
    expect(html).toContain("ann@acme.test");
    expect(html).toContain("$6.00 of $5");
    expect(html).toContain("reached, frees at about 09:00 UTC on Nov 15");
    expect(html).toContain("estimated for 1 that recorded no cost");
    expect(html).toContain(`id="ceiling-${CUSTOMER}"`);
    expect(html).toContain("Only platform owners see this page.");
    expect(monthLabel("2026-01")).toBe("January 2026");
  });

  it("says the accounts could not be read rather than show an empty list", () => {
    const costs: PlatformCosts = {
      month: "2026-11",
      resetsAt: "2026-12-01T00:00:00.000Z",
      providers: [],
      providersError: null,
      since: ago(24 * HOUR),
      accounts: null,
      accountsError: "agent_runs: statement timeout",
      accountsComplete: false,
      aiTotalUsd: null,
      defaultCeiling: { usd: 5, source: "default" },
      bounds: { minUsd: 1, maxUsd: 100 },
    };
    const html = renderToStaticMarkup(<PlatformCostsView costs={costs} />);
    expect(html).toContain("could not be read right now: agent_runs: statement timeout");
    expect(html).not.toContain("$0.00 of model cost");
  });
});

describe("the ceiling control, tap by tap", () => {
  it("saves a lower ceiling on the first tap, and asks on the first tap to raise it", () => {
    expect(decideCeiling(5, "3", "idle")).toEqual({ kind: "save", value: 3, confirm: false });
    expect(decideCeiling(5, "20", "idle")).toEqual({ kind: "ask", value: 20 });
    expect(decideCeiling(5, "20", "confirming")).toEqual({ kind: "save", value: 20, confirm: true });
    expect(decideCeiling(5, "5", "idle")).toEqual({ kind: "same" });
    expect(decideCeiling(5, "250", "idle")).toEqual({ kind: "error", message: "The daily limit is at most $100." });
  });
});
