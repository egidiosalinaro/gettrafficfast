import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { FakeSupabase } from "../support/fake-supabase";
import { CALENDAR_QUOTA_ID, loadPlanUsage } from "@/lib/limits/quotas";
import { ACCOUNT_CAPPED_ACTIONS, accountDailyCapOf } from "@/lib/limits/actions";
import { DAILY_CORRECTION_CAP, DAILY_DRAFT_CAP } from "@/lib/paid-access";
import { TOOL_LIMITS } from "@/lib/tools/usage";
import { MANUAL_JOB_PRIORITY } from "@/lib/jobs/types";
import { PLACEMENT_DRAFT } from "@/lib/jobs/workflows/placement-draft";
import { PRODUCE_ARTICLE } from "@/lib/jobs/workflows/produce-article";
import { resetSpendWarnings } from "@/lib/limits/spend";

/**
 * Settings → Billing's quotas (lib/limits/quotas.ts). What is pinned: every
 * quota is a limit the code enforces, with the number that enforces it
 * (TOOL_LIMITS through the account caps, DAILY_DRAFT_CAP,
 * DAILY_CORRECTION_CAP, one article a day for the month's days), and none
 * other; the counts are this account's only; a count that cannot be read is
 * null, never 0; the daily ceiling on AI work reads only as available,
 * reached (with when it resets) or unknown, and nothing in the answer is a
 * dollar amount.
 */

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const SITE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_SITE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NOW = new Date("2026-11-14T12:00:00.000Z");
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

function seed(over: Record<string, Array<Record<string, unknown>>> = {}) {
  return new FakeSupabase({
    jobs: [
      { user_id: USER, type: PLACEMENT_DRAFT, priority: MANUAL_JOB_PRIORITY, created_at: ago(HOUR) },
      { user_id: USER, type: PLACEMENT_DRAFT, priority: MANUAL_JOB_PRIORITY, created_at: ago(2 * HOUR) },
      { user_id: USER, type: PLACEMENT_DRAFT, priority: 0, created_at: ago(30 * HOUR) },
      { user_id: OTHER, type: PLACEMENT_DRAFT, priority: MANUAL_JOB_PRIORITY, created_at: ago(HOUR) },
      { user_id: USER, type: PRODUCE_ARTICLE, priority: MANUAL_JOB_PRIORITY, created_at: ago(HOUR) },
      { user_id: USER, type: PRODUCE_ARTICLE, priority: 0, created_at: ago(HOUR) },
    ],
    tool_calls: [
      { user_id: USER, tool: "suggest_keywords", status: "ok", created_at: ago(HOUR) },
      { user_id: USER, tool: "suggest_keywords", status: "cap_reached", created_at: ago(HOUR) },
    ],
    draft_feedback: [{ user_id: USER, created_at: ago(HOUR) }],
    articles: [
      { user_id: USER, business_id: SITE, scheduled_date: "2026-11-01" },
      { user_id: USER, business_id: SITE, scheduled_date: "2026-11-14" },
      { user_id: USER, business_id: SITE, scheduled_date: "2026-11-30" },
      { user_id: USER, business_id: SITE, scheduled_date: "2026-12-01" },
      { user_id: USER, business_id: SITE, scheduled_date: "2026-10-31" },
      { user_id: USER, business_id: OTHER_SITE, scheduled_date: "2026-11-02" },
      { user_id: OTHER, business_id: SITE, scheduled_date: "2026-11-03" },
    ],
    agent_runs: [{ user_id: USER, agent: "writing", model: "claude-sonnet-5-5", cost_usd: 0.4, created_at: ago(HOUR) }],
    account_limits: [],
    ...over,
  });
}

beforeEach(() => {
  resetSpendWarnings();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("the plan's quotas", () => {
  it("are the limits the code enforces, with the numbers that enforce them, and nothing else", async () => {
    const usage = await loadPlanUsage(seed() as unknown as SupabaseClient, USER, SITE, NOW);
    const limits = Object.fromEntries(usage.quotas.map((q) => [q.id, q.limit]));
    expect(limits).toEqual({
      [CALENDAR_QUOTA_ID]: 30,
      draft_reply: DAILY_DRAFT_CAP,
      correct_reply_draft: DAILY_CORRECTION_CAP,
      ...Object.fromEntries(ACCOUNT_CAPPED_ACTIONS.map((tool) => [tool, accountDailyCapOf(tool)])),
    });
    // The account caps are the per-key numbers, held across the account.
    expect(limits.generate_article).toBe(TOOL_LIMITS.dailyByTool.generate_article);
    expect(limits.run_visibility_check).toBe(TOOL_LIMITS.dailyByTool.run_visibility_check);
    expect(limits.suggest_prompts).toBe(TOOL_LIMITS.dailyByPrefix.suggest_);
    // Drafts first: the limit used every day.
    expect(usage.quotas.map((q) => q.id).slice(0, 3)).toEqual([CALENDAR_QUOTA_ID, "draft_reply", "correct_reply_draft"]);
    expect(usage.quotas.find((q) => q.id === CALENDAR_QUOTA_ID)).toMatchObject({ period: "month", window: "calendar_month_utc" });
    expect(usage.quotas.filter((q) => q.period === "day").every((q) => q.window === "rolling_24_hours")).toBe(true);
  });

  it("count this account's use only, the way each cap counts it", async () => {
    const usage = await loadPlanUsage(seed() as unknown as SupabaseClient, USER, SITE, NOW);
    const used = Object.fromEntries(usage.quotas.map((q) => [q.id, q.used]));
    // This site's November days only: not October, not December, not the other site, not the other account.
    expect(used[CALENDAR_QUOTA_ID]).toBe(3);
    // Drafts count every draft job of the last 24 hours (the draft cap's rule).
    expect(used.draft_reply).toBe(2);
    expect(used.correct_reply_draft).toBe(1);
    // A job-starting action counts the jobs a person or an agent asked for, not the crons'.
    expect(used.generate_article).toBe(1);
    // An answering action counts its successful calls only.
    expect(used.suggest_keywords).toBe(1);
    expect(used.run_reply_discovery).toBe(0);
  });

  it("leaves the calendar out without a site, and says when a count could not be read instead of 0", async () => {
    const db = seed();
    const broken = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== "from") return Reflect.get(target, property, receiver);
        return (table: string) => {
          if (table !== "draft_feedback") return target.from(table);
          const answer = Promise.resolve({ data: null, count: null, error: { code: "57014", message: "statement timeout" } });
          const query: Record<string, unknown> = {};
          for (const method of ["select", "eq", "gte"]) query[method] = () => query;
          query.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => answer.then(resolve, reject);
          return query;
        };
      },
    }) as unknown as SupabaseClient;
    const usage = await loadPlanUsage(broken, USER, null, NOW);
    expect(usage.quotas.find((q) => q.id === CALENDAR_QUOTA_ID)).toBeUndefined();
    expect(usage.quotas.find((q) => q.id === "correct_reply_draft")).toMatchObject({ used: null, limit: DAILY_CORRECTION_CAP });
  });
});

describe("today's limit for AI work", () => {
  it("is available under the hidden ceiling, and the answer carries no amount", async () => {
    const usage = await loadPlanUsage(seed() as unknown as SupabaseClient, USER, SITE, NOW);
    expect(usage.aiWork).toEqual({ state: "available", message: null, resetsAt: null });
    const text = JSON.stringify(usage);
    expect(text).not.toMatch(/\$|usd|ceiling|spend|cost/i);
  });

  it("is still enforced: at the ceiling it reads as reached, with when it resets, never the amount", async () => {
    const db = seed({
      agent_runs: [{ user_id: USER, agent: "writing", model: "claude-sonnet-5-5", cost_usd: 7, created_at: ago(2 * HOUR) }],
      account_limits: [{ user_id: USER, daily_spend_usd: 6 }],
    });
    const usage = await loadPlanUsage(db as unknown as SupabaseClient, USER, SITE, NOW);
    expect(usage.aiWork).toEqual({
      state: "reached",
      message: "You've reached today's limit for AI work. It resets at about 10:00 UTC on Nov 15.",
      resetsAt: "2026-11-15T10:00:00.000Z",
    });
    expect(JSON.stringify(usage)).not.toMatch(/\$|usd|\b6\b|\b7\b/i);
  });

  it("says it could not be checked, rather than claim it is open, when the spend cannot be read", async () => {
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
    const usage = await loadPlanUsage(broken, USER, SITE, NOW);
    expect(usage.aiWork).toMatchObject({ state: "unknown", resetsAt: null });
    expect(usage.aiWork.message).toMatch(/could not be checked/);
  });
});
