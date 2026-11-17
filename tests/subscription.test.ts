import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "./support/fake-supabase";

/**
 * Subscription lookups with more than one row per user (a canceled
 * subscription and its replacement, or two checkouts). PostgREST's
 * `single()` and `maybeSingle()` both refuse a result of several rows, and
 * the lookups used to read that refusal as "not subscribed". The fake below
 * refuses the same way, so only a query that limits itself to one row passes.
 */

const mocks = vi.hoisted(() => ({ db: null as unknown as FakeSupabase }));

type Builder = Record<string, (...args: unknown[]) => unknown> & PromiseLike<{ data: unknown; error: unknown }>;

/** FakeSupabase, with single()/maybeSingle() erroring on more than one row like PostgREST. */
function strict(db: FakeSupabase) {
  return {
    from(table: string) {
      const inner = db.from(table) as unknown as Builder;
      const wrap = (builder: Builder): Builder =>
        new Proxy(builder, {
          get(target, prop) {
            if (prop === "single" || prop === "maybeSingle") {
              return async () => {
                const { data } = await target;
                const rows = Array.isArray(data) ? data : data ? [data] : [];
                if (rows.length > 1) return { data: null, error: { code: "PGRST116", message: "multiple rows" } };
                if (prop === "single" && rows.length === 0) {
                  return { data: null, error: { code: "PGRST116", message: "no rows" } };
                }
                return { data: rows[0] ?? null, error: null };
              };
            }
            const value = Reflect.get(target, prop);
            if (typeof value !== "function" || prop === "then") return typeof value === "function" ? value.bind(target) : value;
            return (...args: unknown[]) => {
              const result = (value as (...a: unknown[]) => unknown).apply(target, args);
              return result === target ? wrap(target) : result;
            };
          },
        });
      return wrap(inner);
    },
  };
}

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => strict(mocks.db) }));

const future = new Date(Date.now() + 30 * 86_400_000).toISOString();
const past = new Date(Date.now() - 30 * 86_400_000).toISOString();

function row(over: Record<string, unknown>) {
  return {
    user_id: "user-1",
    stripe_customer_id: "cus_1",
    cancel_at_period_end: false,
    current_period_start: null,
    current_period_end: future,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

beforeEach(() => {
  mocks.db = new FakeSupabase({ subscriptions: [] });
});

describe("hasActiveSubscription with two rows", () => {
  it("is true for a user with a canceled subscription and an active one", async () => {
    const { hasActiveSubscription } = await import("@/lib/subscription");
    mocks.db.tables.subscriptions.push(
      row({ id: "a", stripe_subscription_id: "sub_old", status: "canceled", current_period_end: past }),
      row({ id: "b", stripe_subscription_id: "sub_new", status: "active" })
    );
    expect(await hasActiveSubscription("user-1")).toBe(true);
  });

  it("is true for a user with two live subscriptions, preferring the one that runs latest", async () => {
    const { hasActiveSubscription } = await import("@/lib/subscription");
    mocks.db.tables.subscriptions.push(
      row({ id: "a", stripe_subscription_id: "sub_1", status: "active", current_period_end: past }),
      row({ id: "b", stripe_subscription_id: "sub_2", status: "trialing", current_period_end: future })
    );
    expect(await hasActiveSubscription("user-1")).toBe(true);
  });

  it("is false when no row is active or trialing", async () => {
    const { hasActiveSubscription } = await import("@/lib/subscription");
    mocks.db.tables.subscriptions.push(
      row({ id: "a", stripe_subscription_id: "sub_1", status: "canceled" }),
      row({ id: "b", stripe_subscription_id: "sub_2", status: "incomplete_expired" })
    );
    expect(await hasActiveSubscription("user-1")).toBe(false);
  });

  it("does not read another user's subscription", async () => {
    const { hasActiveSubscription } = await import("@/lib/subscription");
    mocks.db.tables.subscriptions.push(row({ id: "a", user_id: "user-2", stripe_subscription_id: "sub_1", status: "active" }));
    expect(await hasActiveSubscription("user-1")).toBe(false);
  });
});

describe("getUserSubscription with two rows", () => {
  it("returns the live subscription over a newer canceled one", async () => {
    const { getUserSubscription } = await import("@/lib/subscription");
    mocks.db.tables.subscriptions.push(
      row({ id: "a", stripe_subscription_id: "sub_live", status: "active", updated_at: "2026-01-01T00:00:00Z" }),
      row({ id: "b", stripe_subscription_id: "sub_dead", status: "canceled", updated_at: "2026-06-01T00:00:00Z" })
    );
    expect((await getUserSubscription("user-1"))?.stripe_subscription_id).toBe("sub_live");
  });

  it("falls back to the most recently updated row when none is live", async () => {
    const { getUserSubscription } = await import("@/lib/subscription");
    mocks.db.tables.subscriptions.push(
      row({ id: "a", stripe_subscription_id: "sub_old", status: "canceled", updated_at: "2026-01-01T00:00:00Z" }),
      row({ id: "b", stripe_subscription_id: "sub_newer", status: "canceled", updated_at: "2026-06-01T00:00:00Z" })
    );
    expect((await getUserSubscription("user-1"))?.stripe_subscription_id).toBe("sub_newer");
  });
});

/**
 * What the Billing page may say. Only what the row holds: the status, and the
 * trial end or next renewal when the row has a period end. With no date the
 * summary has none, rather than a plausible one.
 */
describe("summarizeSubscription", () => {
  const end = "2026-11-12T10:00:00.000Z";

  it("reads a trial's period end as the trial end", async () => {
    const { summarizeSubscription } = await import("@/lib/subscription");
    expect(
      summarizeSubscription({ status: "trialing", current_period_end: end, cancel_at_period_end: false })
    ).toEqual({ statusLabel: "Free trial", dateLabel: "Trial ends", date: end, needsAttention: false, complimentary: false });
  });

  it("reads an active period end as the next renewal, or the end when it will not renew", async () => {
    const { summarizeSubscription } = await import("@/lib/subscription");
    expect(
      summarizeSubscription({ status: "active", current_period_end: end, cancel_at_period_end: false })
    ).toMatchObject({ statusLabel: "Active", dateLabel: "Next renewal", date: end });
    expect(
      summarizeSubscription({ status: "active", current_period_end: end, cancel_at_period_end: true })
    ).toMatchObject({ dateLabel: "Ends", date: end });
  });

  it("invents no date when the row has none", async () => {
    const { summarizeSubscription } = await import("@/lib/subscription");
    expect(
      summarizeSubscription({ status: "active", current_period_end: null, cancel_at_period_end: false })
    ).toMatchObject({ dateLabel: null, date: null });
    expect(
      summarizeSubscription({ status: "trialing", current_period_end: "not a date", cancel_at_period_end: false })
    ).toMatchObject({ dateLabel: null, date: null });
  });

  it("reads a complimentary plan as complimentary, with no date and nothing to fix", async () => {
    const { summarizeSubscription } = await import("@/lib/subscription");
    expect(
      summarizeSubscription({ status: "active", current_period_end: null, cancel_at_period_end: false, source: "comp" })
    ).toEqual({ statusLabel: "Complimentary", dateLabel: null, date: null, needsAttention: false, complimentary: true });
    // A Stripe row, or one from before the column, is read as before.
    expect(
      summarizeSubscription({ status: "active", current_period_end: end, cancel_at_period_end: false, source: "stripe" })
    ).toMatchObject({ statusLabel: "Active", complimentary: false });
    // A comp row that is no longer live says what it is, not "Complimentary".
    expect(
      summarizeSubscription({ status: "canceled", current_period_end: null, cancel_at_period_end: false, source: "comp" })
    ).toMatchObject({ statusLabel: "Canceled", complimentary: false });
  });

  it("gives a lapsed status no renewal date, and flags the ones to fix", async () => {
    const { summarizeSubscription } = await import("@/lib/subscription");
    expect(
      summarizeSubscription({ status: "past_due", current_period_end: end, cancel_at_period_end: false })
    ).toEqual({ statusLabel: "Payment past due", dateLabel: null, date: null, needsAttention: true, complimentary: false });
    expect(
      summarizeSubscription({ status: "canceled", current_period_end: end, cancel_at_period_end: false })
    ).toMatchObject({ statusLabel: "Canceled", date: null, needsAttention: false });
  });
});

describe("reading through a given client (an API-key caller has no session)", () => {
  it("asks the client it is given, not the request's session", async () => {
    const { getUserSubscription, hasActiveSubscription } = await import("@/lib/subscription");
    // The session's database has nothing; the caller's client has the live row.
    const callers = new FakeSupabase({
      subscriptions: [row({ id: "a", stripe_subscription_id: "sub_api", status: "active" })],
    });
    const client = strict(callers) as never;
    expect(await hasActiveSubscription("user-1")).toBe(false);
    expect(await hasActiveSubscription("user-1", client)).toBe(true);
    expect((await getUserSubscription("user-1", client))?.stripe_subscription_id).toBe("sub_api");
  });
});
