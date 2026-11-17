import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runJob } from "@/lib/jobs/worker";
import type { JobRow, Workflow } from "@/lib/jobs/types";
import { resetSpendWarnings, spendHeldMessage } from "@/lib/limits/spend";
import { FakeSupabase } from "../support/fake-supabase";

/**
 * The worker and the account's daily AI spend ceiling (lib/limits/spend.ts).
 * A paid job of an account at its limit is held, not failed: back to
 * `pending` with `run_after` at the moment the rolling window frees, its
 * attempt given back, the reason on the job and handed to `onPause` (so an
 * article goes back to queued with that cause), no step run, nothing
 * reported. A spend that cannot be read holds it for 5 minutes; a missing
 * table lets it run; a free job runs whatever the spend.
 */

const registry = vi.hoisted(() => ({ workflows: new Map<string, Workflow>() }));
vi.mock("@/lib/jobs/registry", () => ({
  getWorkflow: (type: string) => {
    const workflow = registry.workflows.get(type);
    if (!workflow) throw new Error(`Unknown job type: ${type}`);
    return workflow;
  },
  isLlmBoundJob: (type: string) => type === "paid-flow",
  isPaidJob: (type: string) => type === "paid-flow",
}));

const sentry = vi.hoisted(() => ({ exceptions: [] as unknown[] }));
vi.mock("@sentry/nextjs", () => ({
  captureException: (err: unknown) => sentry.exceptions.push(err),
  captureMessage: () => {},
}));

const HOUR = 60 * 60 * 1000;
const FAR_FUTURE = () => Date.now() + 60_000;
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

function job(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: "job-1",
    user_id: "owner",
    article_id: null,
    type: "paid-flow",
    input: {},
    status: "running",
    current_step: null,
    attempts: 2,
    max_attempts: 3,
    last_error: null,
    ...overrides,
  };
}

describe("the worker and the account's daily spend limit", () => {
  let db: FakeSupabase;
  let ran: string[];
  type PauseHook = NonNullable<Workflow["onPause"]>;
  let onPause: Mock<PauseHook>;
  let onFailure: Mock<NonNullable<Workflow["onFailure"]>>;
  const crossedAt = () => new Date(Date.now() - 3 * HOUR);

  beforeEach(() => {
    resetSpendWarnings();
    sentry.exceptions.length = 0;
    ran = [];
    onPause = vi.fn<PauseHook>(async () => {});
    onFailure = vi.fn(async () => {});
    registry.workflows.clear();
    registry.workflows.set("paid-flow", {
      type: "paid-flow",
      steps: [{ name: "write", run: async () => (ran.push("paid-flow"), { ok: true }) }],
      onPause,
      onFailure,
    });
    registry.workflows.set("free-flow", {
      type: "free-flow",
      steps: [{ name: "ingest", run: async () => (ran.push("free-flow"), { ok: true }) }],
    });
    db = new FakeSupabase({
      jobs: [job() as unknown as Record<string, unknown>, job({ id: "job-free", type: "free-flow" }) as unknown as Record<string, unknown>],
      subscriptions: [{ user_id: "owner", status: "active", current_period_end: inDays(20) }],
      provider_pauses: [],
      account_limits: [],
      agent_runs: [
        { user_id: "owner", agent: "writing", model: "gemini-2.5-flash", cost_usd: 3, created_at: new Date(Date.now() - HOUR).toISOString() },
        { user_id: "owner", agent: "writing", model: "gemini-2.5-flash", cost_usd: 2.5, created_at: crossedAt().toISOString() },
      ],
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("holds a paid job at the limit until the window frees, its attempt given back, without failing it", async () => {
    const before = Date.now();
    const outcome = await runJob(db as unknown as SupabaseClient, job(), FAR_FUTURE());

    expect(outcome).toBe("yielded");
    expect(ran).toEqual([]);
    const held = db.job("job-1");
    expect(held).toMatchObject({
      status: "pending",
      attempts: 1,
      locked_by: null,
      locked_at: null,
      last_error: expect.stringMatching(/^Waiting: today's limit for AI work is reached\. This resumes on its own at about \d\d:\d\d UTC on [A-Z][a-z]{2} \d{1,2}\.$/),
    });
    expect(held?.finished_at).toBeUndefined();
    // The run that took the total over ($3 + $2.50) leaves the 24 hours.
    const runAfter = new Date(String(held?.run_after)).getTime();
    expect(runAfter).toBeGreaterThanOrEqual(crossedAt().getTime() + 24 * HOUR - 1000);
    expect(runAfter).toBeGreaterThan(before);
    expect(onPause).toHaveBeenCalledTimes(1);
    expect(held?.last_error).toBe(spendHeldMessage(new Date(String(held?.run_after))));
    expect(String(held?.last_error)).not.toContain("$");
    expect(onPause.mock.calls[0][0].reason).toBe(held?.last_error);
    expect(onFailure).not.toHaveBeenCalled();
    expect(db.tables.job_steps).toEqual([]);
    expect(sentry.exceptions).toHaveLength(0);
  });

  it("runs the job once the account's own limit is above the spend", async () => {
    db.tables.account_limits.push({ user_id: "owner", daily_spend_usd: 10 });
    expect(await runJob(db as unknown as SupabaseClient, job(), FAR_FUTURE())).toBe("completed");
    expect(ran).toEqual(["paid-flow"]);
  });

  it("runs a free job whatever the spend", async () => {
    expect(await runJob(db as unknown as SupabaseClient, job({ id: "job-free", type: "free-flow" }), FAR_FUTURE())).toBe("completed");
    expect(ran).toEqual(["free-flow"]);
  });

  it("holds the job for 5 minutes when the spend cannot be read, and runs it when the table is missing", async () => {
    const answering = (error: Record<string, unknown>) =>
      new Proxy(db, {
        get(target, property, receiver) {
          if (property !== "from") return Reflect.get(target, property, receiver);
          return (table: string) => {
            if (table !== "agent_runs") return target.from(table);
            const answer = Promise.resolve({ data: null, error });
            const query: Record<string, unknown> = {};
            for (const method of ["select", "eq", "gte", "order"]) query[method] = () => query;
            query.range = () => answer;
            return query;
          };
        },
      }) as unknown as SupabaseClient;

    const before = Date.now();
    expect(await runJob(answering({ code: "57014", message: "statement timeout" }), job(), FAR_FUTURE())).toBe("yielded");
    expect(ran).toEqual([]);
    const held = db.job("job-1");
    expect(held).toMatchObject({ status: "pending", attempts: 1 });
    const runAfter = new Date(String(held?.run_after)).getTime();
    expect(runAfter).toBeGreaterThanOrEqual(before + 5 * 60_000 - 1000);
    expect(runAfter).toBeLessThan(before + 6 * 60_000);
    expect(onFailure).not.toHaveBeenCalled();

    expect(await runJob(answering({ code: "42P01", message: 'relation "public.agent_runs" does not exist' }), job(), FAR_FUTURE())).toBe(
      "completed"
    );
    expect(ran).toEqual(["paid-flow"]);
  });
});
