import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runJob, tick } from "@/lib/jobs/worker";
import type { JobRow, Workflow } from "@/lib/jobs/types";
import { LlmError } from "@/lib/providers/llm/types";
import { LLM_PAUSED_MESSAGE } from "@/lib/llm-billing";
import { FakeSupabase } from "../support/fake-supabase";

/**
 * The LLM billing pause in the worker: a job that needs a model waits in the
 * queue while the accounts cannot pay. It spends no attempt, is not failed,
 * and runs no step; other job types keep running.
 */

const registry = vi.hoisted(() => ({ workflows: new Map<string, Workflow>() }));
vi.mock("@/lib/jobs/registry", () => ({
  getWorkflow: (type: string) => {
    const workflow = registry.workflows.get(type);
    if (!workflow) throw new Error(`Unknown job type: ${type}`);
    return workflow;
  },
  isLlmBoundJob: (type: string) => type === "llm-flow",
  isPaidJob: (type: string) => type === "llm-flow",
}));

const sentry = vi.hoisted(() => ({ exceptions: [] as unknown[], messages: [] as string[] }));
vi.mock("@sentry/nextjs", () => ({
  captureException: (err: unknown) => sentry.exceptions.push(err),
  captureMessage: (message: string) => sentry.messages.push(message),
}));

vi.mock("@/lib/notifications/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notifications/email")>()),
  sendNotificationEmail: async () => true,
}));

function job(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: "job-1",
    user_id: "user-1",
    article_id: "article-1",
    type: "llm-flow",
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
const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();

describe("worker under the LLM billing pause", () => {
  let db: FakeSupabase;
  let ran: string[];
  type Hook = (ctx: unknown) => Promise<void>;
  let onFailure: Mock<Hook>;
  let onPause: Mock<Hook>;

  beforeEach(() => {
    sentry.exceptions.length = 0;
    sentry.messages.length = 0;
    ran = [];
    onFailure = vi.fn<Hook>(async () => {});
    onPause = vi.fn<Hook>(async () => {});
    registry.workflows.clear();
    registry.workflows.set("llm-flow", {
      type: "llm-flow",
      steps: [{ name: "write", run: async () => (ran.push("llm-flow"), { ok: true }) }],
      onFailure,
      onPause,
    });
    registry.workflows.set("plain-flow", {
      type: "plain-flow",
      steps: [{ name: "ingest", run: async () => (ran.push("plain-flow"), { ok: true }) }],
    });
    db = new FakeSupabase({
      jobs: [
        job({ id: "llm-job", attempts: 2 }) as unknown as Record<string, unknown>,
        job({ id: "plain-job", type: "plain-flow", attempts: 1 }) as unknown as Record<string, unknown>,
      ],
      provider_pauses: [],
      operator_alerts: [],
      // A paying owner: the worker runs paid jobs only for those (worker-subscription.test.ts).
      subscriptions: [{ user_id: "user-1", status: "active", current_period_end: null }],
    });
  });

  it("leaves LLM-bound jobs queued while paused, without spending an attempt, and runs the others", async () => {
    const until = inAnHour();
    db.tables.provider_pauses.push({ kind: "llm", paused_until: until });
    const claimed = [db.job("llm-job"), db.job("plain-job")];
    (db as unknown as { rpc: () => Promise<unknown> }).rpc = async () => ({ data: claimed, error: null });

    const result = await tick(db as unknown as SupabaseClient, { maxJobs: 2 });

    expect(ran).toEqual(["plain-flow"]);
    expect(result.paused).toBe(1);
    expect(result.pausedUntil).toBe(new Date(until).toISOString());
    const held = db.job("llm-job");
    expect(held?.status).toBe("pending");
    // The claim counted attempt 2; holding gives it back.
    expect(held?.attempts).toBe(1);
    expect(held?.run_after).toBe(new Date(until).toISOString());
    expect(held?.last_error).toBe(LLM_PAUSED_MESSAGE);
    expect(onFailure).not.toHaveBeenCalled();
    expect(onPause).toHaveBeenCalledTimes(1);
    expect(db.job("plain-job")?.status).toBe("completed");
    expect(sentry.exceptions).toHaveLength(0);
  });

  it("runs LLM-bound jobs again once the pause has expired", async () => {
    db.tables.provider_pauses.push({ kind: "llm", paused_until: new Date(Date.now() - 1000).toISOString() });
    const outcome = await runJob(db as unknown as SupabaseClient, job({ id: "llm-job", attempts: 2 }), FAR_FUTURE());
    expect(outcome).toBe("completed");
    expect(ran).toEqual(["llm-flow"]);
  });

  it("pauses on a billing refusal instead of failing the job, and holds the rest of the tick", async () => {
    registry.workflows.set("llm-flow", {
      type: "llm-flow",
      steps: [
        {
          name: "write",
          run: async () => {
            ran.push("llm-flow");
            throw new LlmError("Gemini credits are depleted.", "gemini", undefined, {
              retryable: false,
              report: false,
              billingRefused: ["gemini"],
            });
          },
        },
      ],
      onFailure,
      onPause,
    });
    db.tables.jobs.push(job({ id: "llm-job-2", attempts: 1 }) as unknown as Record<string, unknown>);
    const claimed = [db.job("llm-job"), db.job("llm-job-2")];
    (db as unknown as { rpc: () => Promise<unknown> }).rpc = async () => ({ data: claimed, error: null });

    const result = await tick(db as unknown as SupabaseClient, { maxJobs: 2 });

    // The first job asked and was refused; the second was held without asking.
    expect(ran).toEqual(["llm-flow"]);
    expect(result.paused).toBe(2);
    expect(result.outcomes.failed).toBe(0);
    for (const id of ["llm-job", "llm-job-2"]) {
      expect(db.job(id)?.status).toBe("pending");
    }
    expect(db.job("llm-job")?.attempts).toBe(1);
    expect(db.job("llm-job-2")?.attempts).toBe(0);
    expect(db.step("llm-job", "write")?.status).toBe("running");
    expect(onFailure).not.toHaveBeenCalled();
    // One operator alert, not an exception per job.
    expect(sentry.exceptions).toHaveLength(0);
    expect(sentry.messages).toHaveLength(1);
    expect(db.tables.provider_pauses).toHaveLength(1);
  });

  it("still fails a job on an ordinary terminal model error", async () => {
    registry.workflows.set("llm-flow", {
      type: "llm-flow",
      steps: [
        {
          name: "write",
          run: async () => {
            throw new LlmError("GEMINI_API_KEY is not set", "gemini", undefined, { retryable: false });
          },
        },
      ],
      onFailure,
    });
    const outcome = await runJob(db as unknown as SupabaseClient, job({ id: "llm-job" }), FAR_FUTURE());
    expect(outcome).toBe("failed");
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(db.tables.provider_pauses).toHaveLength(0);
  });
});
