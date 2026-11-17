import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "./support/fake-supabase";

/**
 * The server-side paywall. The UI gate (lib/app-access.ts) keeps a lapsed
 * account out of the screens; these tests pin that the API routes which spend
 * money ask the same question, and that drafting has a daily ceiling.
 */

const subscription = vi.hoisted(() => ({ active: false, asked: [] as string[] }));

vi.mock("@/lib/subscription", () => ({
  hasActiveSubscription: async (userId: string) => {
    subscription.asked.push(userId);
    return subscription.active;
  },
}));

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DAILY_CORRECTION_CAP,
  DAILY_DRAFT_CAP,
  draftsStartedToday,
  hasPaidAccess,
  requireCorrectionCapacity,
  requireDraftCapacity,
  requirePaidAccess,
} from "@/lib/paid-access";

beforeEach(() => {
  subscription.active = false;
  subscription.asked = [];
});

describe("requirePaidAccess", () => {
  it("answers 401 without a user, without asking about a subscription", async () => {
    const res = await requirePaidAccess(null);
    expect(res?.status).toBe(401);
    expect(subscription.asked).toHaveLength(0);
  });

  it("answers 402 with a sentence and the pricing link when nothing is active", async () => {
    const res = await requirePaidAccess({ id: "u-1" });
    expect(res?.status).toBe(402);
    const body = (await res!.json()) as { error: string; code: string; href: string };
    expect(body.code).toBe("subscription_required");
    expect(body.href).toBe("/pricing");
    expect(body.error).toMatch(/subscription/);
  });

  it("lets an active, trialing or comped account through: the same check the UI gate makes", async () => {
    subscription.active = true;
    expect(await requirePaidAccess({ id: "owner" })).toBeNull();
    expect(subscription.asked).toEqual(["owner"]);
  });
});

describe("daily draft cap", () => {
  const now = new Date("2026-11-08T12:00:00Z");
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();

  function jobs(count: number, overrides: Record<string, unknown> = {}) {
    return Array.from({ length: count }, (_, i) => ({
      id: `j-${i}`,
      user_id: "u-1",
      type: "placement-draft",
      created_at: hoursAgo(1),
      ...overrides,
    }));
  }

  it("counts only this user's draft jobs from the last 24 hours", async () => {
    const db = new FakeSupabase({
      jobs: [
        ...jobs(3),
        ...jobs(2, { created_at: hoursAgo(30) }), // yesterday
        ...jobs(2, { user_id: "u-2" }), // someone else
        ...jobs(2, { type: "produce-article" }), // other work
      ],
    });
    expect(await draftsStartedToday(db as unknown as SupabaseClient, "u-1", now)).toBe(3);
  });

  it("allows a draft under the cap", async () => {
    const db = new FakeSupabase({ jobs: jobs(DAILY_DRAFT_CAP - 1) });
    expect(await requireDraftCapacity(db as unknown as SupabaseClient, "u-1", now)).toBeNull();
  });

  it("refuses at the cap with a 429 and a human sentence", async () => {
    const db = new FakeSupabase({ jobs: jobs(DAILY_DRAFT_CAP) });
    const res = await requireDraftCapacity(db as unknown as SupabaseClient, "u-1", now);
    expect(res?.status).toBe(429);
    const body = (await res!.json()) as { error: string; code: string };
    expect(body.code).toBe("draft_limit");
    expect(body.error).toMatch(new RegExp(`${DAILY_DRAFT_CAP} drafts in the last 24 hours`));
  });
});

describe("daily correction cap", () => {
  const now = new Date("2026-11-09T12:00:00Z");
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();

  // One note per correction asked for, written before the model is called.
  function notes(count: number, overrides: Record<string, unknown> = {}) {
    return Array.from({ length: count }, (_, i) => ({
      id: `fb-${i}`,
      user_id: "u-1",
      business_id: "biz-1",
      reason: "too generic",
      created_at: hoursAgo(1),
      ...overrides,
    }));
  }

  it("allows a correction under the cap, counting only this user's last 24 hours", async () => {
    const db = new FakeSupabase({
      draft_feedback: [
        ...notes(DAILY_CORRECTION_CAP - 1),
        ...notes(5, { created_at: hoursAgo(30) }),
        ...notes(5, { user_id: "u-2" }),
      ],
    });
    expect(await requireCorrectionCapacity(db as unknown as SupabaseClient, "u-1", now)).toBeNull();
  });

  it("refuses at 100 with a 429 and a sentence that leaves editing by hand open", async () => {
    expect(DAILY_CORRECTION_CAP).toBe(100);
    const db = new FakeSupabase({ draft_feedback: notes(DAILY_CORRECTION_CAP) });
    const res = await requireCorrectionCapacity(db as unknown as SupabaseClient, "u-1", now);
    expect(res?.status).toBe(429);
    const body = (await res!.json()) as { error: string; code: string };
    expect(body.code).toBe("correction_limit");
    expect(body.error).toContain("100 corrections in the last 24 hours");
    expect(body.error).toContain("edit a draft by hand");
  });

  it("fails closed when the count cannot be read", async () => {
    const failing = {
      from: () => {
        const chain: Record<string, unknown> = {};
        chain.select = () => chain;
        chain.eq = () => chain;
        chain.gte = async () => ({ count: null, error: { message: "relation does not exist" } });
        return chain;
      },
    } as unknown as SupabaseClient;
    await expect(requireCorrectionCapacity(failing, "u-1", now)).rejects.toThrow(/Could not count today's corrections/);
  });
});

describe("hasPaidAccess (service role, no session)", () => {
  const now = new Date("2026-11-09T12:00:00Z");
  const client = (rows: Record<string, unknown>[]) =>
    new FakeSupabase({ subscriptions: rows }) as unknown as SupabaseClient;

  it("is true for an active or trialing row whose period has not ended, or that has none", async () => {
    expect(await hasPaidAccess(client([{ user_id: "u-1", status: "active", current_period_end: "2026-12-01T00:00:00Z" }]), "u-1", now)).toBe(true);
    expect(await hasPaidAccess(client([{ user_id: "u-1", status: "trialing", current_period_end: null }]), "u-1", now)).toBe(true);
    expect(await hasPaidAccess(client([{ user_id: "u-1", status: "active", current_period_end: null }]), "u-1", now)).toBe(true);
  });

  it("is false for an ended period, a dead status, no row, or someone else's row", async () => {
    expect(await hasPaidAccess(client([{ user_id: "u-1", status: "active", current_period_end: "2026-11-01T00:00:00Z" }]), "u-1", now)).toBe(false);
    for (const status of ["canceled", "past_due", "unpaid", "incomplete", "incomplete_expired", "paused"]) {
      expect(await hasPaidAccess(client([{ user_id: "u-1", status, current_period_end: "2026-12-01T00:00:00Z" }]), "u-1", now)).toBe(false);
    }
    expect(await hasPaidAccess(client([]), "u-1", now)).toBe(false);
    expect(await hasPaidAccess(client([{ user_id: "u-2", status: "active", current_period_end: null }]), "u-1", now)).toBe(false);
  });

  it("is true when a live row sits next to a canceled one, whatever their order", async () => {
    const rows = [
      { user_id: "u-1", status: "canceled", current_period_end: "2026-10-01T00:00:00Z" },
      { user_id: "u-1", status: "active", current_period_end: "2026-12-01T00:00:00Z" },
    ];
    expect(await hasPaidAccess(client(rows), "u-1", now)).toBe(true);
    expect(await hasPaidAccess(client([...rows].reverse()), "u-1", now)).toBe(true);
  });

  it("throws when the subscription cannot be read, so the caller can fail closed with a reason", async () => {
    const failing = {
      from: () => {
        const query = {
          select: () => query,
          eq: () => query,
          in: async () => ({ data: null, error: { message: "boom" } }),
        };
        return query;
      },
    } as unknown as SupabaseClient;
    await expect(hasPaidAccess(failing, "u-1", now)).rejects.toThrow(/Could not read the subscription/);
  });

  it("does not use the session-bound check, which sees nothing on the service role", async () => {
    await hasPaidAccess(client([]), "u-1", now);
    expect(subscription.asked).toEqual([]);
  });
});
