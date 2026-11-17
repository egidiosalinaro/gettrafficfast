import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runJob, tick } from "@/lib/jobs/worker";
import { JOB_SUBSCRIPTION_INACTIVE_MESSAGE, type JobRow, type Workflow } from "@/lib/jobs/types";
import { FakeSupabase } from "../support/fake-supabase";

/**
 * The worker runs a paid job only for an owner who pays, checked when the
 * job runs: a job queued before the account lapsed (or retried after) is
 * failed with a sentence of ours, on that attempt, without a retry and
 * without a Sentry event; no step runs. A subscription that cannot be read
 * neither runs nor fails the job: it goes back to the queue, its attempt
 * given back. Free job types run whoever the owner is.
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

const sentry = vi.hoisted(() => ({ exceptions: [] as unknown[], messages: [] as string[] }));
vi.mock("@sentry/nextjs", () => ({
  captureException: (err: unknown) => sentry.exceptions.push(err),
  captureMessage: (message: string) => sentry.messages.push(message),
}));

function job(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: "job-1",
    user_id: "lapsed",
    article_id: null,
    type: "paid-flow",
    input: {},
    status: "running",
    current_step: null,
    attempts: 1,
    max_attempts: 3,
    last_error: null,
    ...overrides,
  };
}

const FAR_FUTURE = () => Date.now() + 60_000;
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

describe("the worker and the owner's subscription", () => {
  let db: FakeSupabase;
  let ran: string[];
  type Hook = (ctx: { error: string }) => Promise<void>;
  let onFailure: Mock<Hook>;

  beforeEach(() => {
    sentry.exceptions.length = 0;
    sentry.messages.length = 0;
    ran = [];
    onFailure = vi.fn<Hook>(async () => {});
    registry.workflows.clear();
    registry.workflows.set("paid-flow", {
      type: "paid-flow",
      steps: [{ name: "write", run: async () => (ran.push("paid-flow"), { ok: true }) }],
      onFailure: onFailure as unknown as Workflow["onFailure"],
    });
    registry.workflows.set("free-flow", {
      type: "free-flow",
      steps: [{ name: "ingest", run: async () => (ran.push("free-flow"), { ok: true }) }],
    });
    db = new FakeSupabase({
      jobs: [
        job() as unknown as Record<string, unknown>,
        job({ id: "job-paid", user_id: "paid" }) as unknown as Record<string, unknown>,
        job({ id: "job-free", type: "free-flow" }) as unknown as Record<string, unknown>,
      ],
      subscriptions: [
        { user_id: "paid", status: "active", current_period_end: inDays(20) },
        { user_id: "lapsed", status: "canceled", current_period_end: inDays(-2) },
      ],
      provider_pauses: [],
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("fails a paid job of a lapsed owner on this attempt, runs no step, retries nothing and reports nothing", async () => {
    const outcome = await runJob(db as unknown as SupabaseClient, job(), FAR_FUTURE());

    expect(outcome).toBe("failed");
    expect(ran).toEqual([]);
    expect(db.job("job-1")).toMatchObject({ status: "failed", last_error: JOB_SUBSCRIPTION_INACTIVE_MESSAGE });
    expect(db.job("job-1")?.finished_at).toBeTruthy();
    expect(JOB_SUBSCRIPTION_INACTIVE_MESSAGE).toMatch(/^Subscription inactive: /);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure.mock.calls[0][0].error).toBe(JOB_SUBSCRIPTION_INACTIVE_MESSAGE);
    expect(db.tables.job_steps).toEqual([]);
    expect(sentry.exceptions).toHaveLength(0);
    expect(sentry.messages).toHaveLength(0);
  });

  it("runs a paid job for an owner who pays", async () => {
    const outcome = await runJob(db as unknown as SupabaseClient, job({ id: "job-paid", user_id: "paid" }), FAR_FUTURE());
    expect(outcome).toBe("completed");
    expect(ran).toEqual(["paid-flow"]);
  });

  it("runs a free job whoever the owner is", async () => {
    const outcome = await runJob(db as unknown as SupabaseClient, job({ id: "job-free", type: "free-flow" }), FAR_FUTURE());
    expect(outcome).toBe("completed");
    expect(ran).toEqual(["free-flow"]);
  });

  it("refuses the lapsed owner's job in a tick and still runs the others", async () => {
    const claimed = [db.job("job-1"), db.job("job-paid"), db.job("job-free")];
    (db as unknown as { rpc: () => Promise<unknown> }).rpc = async () => ({ data: claimed, error: null });

    const result = await tick(db as unknown as SupabaseClient, { maxJobs: 3 });

    expect(result.outcomes).toMatchObject({ completed: 2, failed: 1 });
    expect(ran.sort()).toEqual(["free-flow", "paid-flow"]);
    expect(db.job("job-1")?.status).toBe("failed");
    expect(sentry.exceptions).toHaveLength(0);
  });

  it("puts the job back in the queue, its attempt given back, when the subscription cannot be read", async () => {
    const broken = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== "from") return Reflect.get(target, property, receiver);
        return (table: string) => {
          if (table !== "subscriptions") return target.from(table);
          const failing = {
            select: () => failing,
            eq: () => failing,
            in: () => Promise.resolve({ data: null, error: { message: "relation does not exist" } }),
          };
          return failing;
        };
      },
    });

    const before = Date.now();
    const outcome = await runJob(broken as unknown as SupabaseClient, job({ attempts: 2 }), FAR_FUTURE());

    expect(outcome).toBe("yielded");
    expect(ran).toEqual([]);
    const held = db.job("job-1");
    expect(held).toMatchObject({ status: "pending", attempts: 1, locked_by: null });
    expect(new Date(held?.run_after as string).getTime()).toBeGreaterThanOrEqual(before + 4 * 60_000);
    expect(held?.last_error).toBeNull();
    expect(onFailure).not.toHaveBeenCalled();
    expect(sentry.exceptions).toHaveLength(0);
  });
});

describe("which job types are paid", () => {
  it("is every LLM-bound type and AI Visibility runs, not Search Console ingests", async () => {
    const actual = await vi.importActual<typeof import("@/lib/jobs/registry")>("@/lib/jobs/registry");
    for (const type of ["produce-article", "refresh-article", "placement-discovery", "placement-draft", "aeo-run"]) {
      expect(actual.isPaidJob(type), type).toBe(true);
    }
    expect(actual.isPaidJob("search-console-ingest")).toBe(false);
    for (const type of actual.workflowTypes()) {
      if (actual.isLlmBoundJob(type)) expect(actual.isPaidJob(type), type).toBe(true);
    }
  });
});
