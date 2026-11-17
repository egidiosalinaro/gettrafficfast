import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runJob, shouldReportStepError } from "@/lib/jobs/worker";
import type { JobRow, Workflow } from "@/lib/jobs/types";
import { RetryableStepError, StepIncomplete, TerminalStepError } from "@/lib/jobs/types";
import { LlmError } from "@/lib/providers/llm/types";
import { FakeSupabase } from "../support/fake-supabase";

vi.mock("@/lib/jobs/registry", () => ({
  getWorkflow: (type: string) => {
    const workflow = (globalThis as { __workflow?: Workflow }).__workflow;
    if (!workflow || workflow.type !== type) throw new Error(`Unknown job type: ${type}`);
    return workflow;
  },
  isLlmBoundJob: (type: string) => type === "llm-flow",
  isPaidJob: (type: string) => type === "llm-flow",
}));

const captured: unknown[] = [];
vi.mock("@sentry/nextjs", () => ({
  captureException: (err: unknown) => {
    captured.push(err);
  },
}));

function setWorkflow(workflow: Workflow) {
  (globalThis as { __workflow?: Workflow }).__workflow = workflow;
}

function job(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: "job-1",
    user_id: "user-1",
    article_id: "article-1",
    type: "test-flow",
    input: { articleId: "article-1" },
    status: "running",
    current_step: null,
    attempts: 1,
    max_attempts: 3,
    last_error: null,
    ...overrides,
  };
}

const FAR_FUTURE = () => Date.now() + 60_000;

describe("job worker", () => {
  let db: FakeSupabase;

  beforeEach(() => {
    db = new FakeSupabase({ jobs: [job() as unknown as Record<string, unknown>] });
    captured.length = 0;
  });

  it("runs every step in order and completes the job", async () => {
    const seen: string[] = [];
    setWorkflow({
      type: "test-flow",
      steps: [
        { name: "one", run: async () => (seen.push("one"), { a: 1 }) },
        { name: "two", run: async () => (seen.push("two"), { b: 2 }) },
      ],
    });

    const outcome = await runJob(db as unknown as SupabaseClient, job(), FAR_FUTURE());

    expect(outcome).toBe("completed");
    expect(seen).toEqual(["one", "two"]);
    expect(db.job("job-1")?.status).toBe("completed");
    expect(db.step("job-1", "one")?.status).toBe("completed");
    expect(db.step("job-1", "two")?.output).toEqual({ b: 2 });
  });

  it("never re-runs a step that already completed", async () => {
    db.tables.job_steps.push({
      job_id: "job-1",
      step: "one",
      status: "completed",
      output: { a: "from a previous run" },
    });

    const seen: string[] = [];
    setWorkflow({
      type: "test-flow",
      steps: [
        { name: "one", run: async () => (seen.push("one"), { a: "fresh" }) },
        {
          name: "two",
          // The resumed run must see the checkpointed output, not a new one.
          run: async (ctx) => (seen.push("two"), { got: ctx.outputs.one }),
        },
      ],
    });

    const outcome = await runJob(db as unknown as SupabaseClient, job(), FAR_FUTURE());

    expect(outcome).toBe("completed");
    expect(seen).toEqual(["two"]);
    expect(db.step("job-1", "two")?.output).toEqual({
      got: { a: "from a previous run" },
    });
  });

  it("schedules a retry when a step fails and attempts remain", async () => {
    setWorkflow({
      type: "test-flow",
      steps: [
        { name: "one", run: async () => ({ ok: true }) },
        {
          name: "two",
          run: async () => {
            throw new Error("provider unavailable");
          },
        },
      ],
    });

    const outcome = await runJob(db as unknown as SupabaseClient, job({ attempts: 1 }), FAR_FUTURE());

    expect(outcome).toBe("retrying");
    const stored = db.job("job-1");
    expect(stored?.status).toBe("pending");
    expect(stored?.last_error).toContain("provider unavailable");
    // The completed step survives, so the retry resumes instead of restarting.
    expect(db.step("job-1", "one")?.status).toBe("completed");
    expect(db.step("job-1", "two")?.status).toBe("failed");
  });

  it("fails immediately when the model account refuses the call", async () => {
    const onFailure = vi.fn(async () => {});
    setWorkflow({
      type: "test-flow",
      steps: [
        {
          name: "one",
          run: async () => {
            throw new LlmError("Gemini request failed: [402 Payment Required]", "gemini", undefined, {
              retryable: false,
            });
          },
        },
      ],
      onFailure,
    });

    const outcome = await runJob(
      db as unknown as SupabaseClient,
      job({ attempts: 1, max_attempts: 3 }),
      FAR_FUTURE()
    );

    expect(outcome).toBe("failed");
    expect(db.job("job-1")?.status).toBe("failed");
    expect(onFailure).toHaveBeenCalledOnce();
  });

  it("fails a billing error on the first attempt and does not report it", async () => {
    captured.length = 0;
    const billing = new LlmError(
      "Gemini credits are depleted. Generation stays paused until billing is topped up.",
      "gemini",
      undefined,
      { retryable: false, report: false }
    );
    expect(shouldReportStepError(billing)).toBe(false);
    expect(shouldReportStepError(new Error("permanently broken"))).toBe(true);
    expect(shouldReportStepError(new TerminalStepError("Say how you use the product in Settings first."))).toBe(false);

    setWorkflow({
      type: "test-flow",
      steps: [
        {
          name: "outline",
          run: async () => {
            throw billing;
          },
        },
      ],
    });

    const outcome = await runJob(db as unknown as SupabaseClient, job({ attempts: 1, max_attempts: 3 }), FAR_FUTURE());

    expect(outcome).toBe("failed");
    expect(db.job("job-1")?.status).toBe("failed");
    expect(db.job("job-1")?.last_error).toContain("credits are depleted");
    expect(captured).toHaveLength(0);
  });

  it("fails immediately on a precondition no retry can meet, keeping its message as the reason", async () => {
    setWorkflow({
      type: "test-flow",
      steps: [
        {
          name: "one",
          run: async () => {
            throw new TerminalStepError("Say how you use the product in Settings first.");
          },
        },
      ],
    });

    const outcome = await runJob(
      db as unknown as SupabaseClient,
      job({ attempts: 1, max_attempts: 3 }),
      FAR_FUTURE()
    );

    expect(outcome).toBe("failed");
    expect(db.job("job-1")?.status).toBe("failed");
    expect(db.job("job-1")?.last_error).toBe("Say how you use the product in Settings first.");
    // A sentence written for the person is an outcome, not a defect: the
    // record is the job row, and Sentry stays for what the code did not
    // expect.
    expect(captured).toHaveLength(0);
  });

  it("fails the job and calls onFailure once attempts are exhausted", async () => {
    const onFailure = vi.fn(async () => {});
    setWorkflow({
      type: "test-flow",
      steps: [
        {
          name: "one",
          run: async () => {
            throw new Error("permanently broken");
          },
        },
      ],
      onFailure,
    });

    const outcome = await runJob(
      db as unknown as SupabaseClient,
      job({ attempts: 3, max_attempts: 3 }),
      FAR_FUTURE()
    );

    expect(outcome).toBe("failed");
    expect(db.job("job-1")?.status).toBe("failed");
    expect(onFailure).toHaveBeenCalledOnce();
    expect(captured).toHaveLength(1);
  });

  it("honours a step's explicit retry request without consuming attempts", async () => {
    setWorkflow({
      type: "test-flow",
      steps: [
        {
          name: "one",
          run: async () => {
            throw new RetryableStepError("rate limited", 30);
          },
        },
      ],
    });

    const outcome = await runJob(
      db as unknown as SupabaseClient,
      job({ attempts: 3, max_attempts: 3 }),
      FAR_FUTURE()
    );

    expect(outcome).toBe("retrying");
    expect(db.job("job-1")?.status).toBe("pending");
  });

  it("releases the lock when a step is still in a call at the deadline", async () => {
    db.tables.jobs[0].attempts = 2;
    setWorkflow({
      type: "test-flow",
      steps: [
        {
          name: "one",
          run: (ctx) =>
            new Promise((_resolve, reject) => {
              const fail = () => reject(ctx.signal?.reason ?? new DOMException("aborted", "AbortError"));
              if (ctx.signal?.aborted) fail();
              else ctx.signal?.addEventListener("abort", fail, { once: true });
            }),
        },
      ],
    });

    const outcome = await runJob(
      db as unknown as SupabaseClient,
      job({ attempts: 2 }),
      Date.now() + 5_200
    );

    expect(outcome).toBe("yielded");
    const stored = db.job("job-1");
    expect(stored?.status).toBe("pending");
    expect(stored?.locked_by ?? null).toBeNull();
    expect(stored?.current_step).toBe("one");
    // The attempt was not spent: the clock ran out, the work did not fail.
    expect(stored?.attempts).toBe(1);
    expect(captured).toEqual([]);
  });

  it("yields instead of starting a step it has no time for", async () => {
    const seen: string[] = [];
    setWorkflow({
      type: "test-flow",
      steps: [{ name: "one", run: async () => (seen.push("one"), {}) }],
    });

    // Deadline already passed: the job must be handed back untouched.
    const outcome = await runJob(db as unknown as SupabaseClient, job(), Date.now());

    expect(outcome).toBe("yielded");
    expect(seen).toEqual([]);
    expect(db.job("job-1")?.status).toBe("pending");
    expect(db.job("job-1")?.current_step).toBe("one");
  });

  it("hands a step the tick's deadline so it can budget its own work", async () => {
    let seenDeadline: number | undefined;
    setWorkflow({
      type: "test-flow",
      steps: [{ name: "one", run: async (ctx) => ((seenDeadline = ctx.deadline), {}) }],
    });

    const deadline = FAR_FUTURE();
    await runJob(db as unknown as SupabaseClient, job(), deadline);

    expect(seenDeadline).toBeDefined();
    expect(seenDeadline as number).toBeLessThan(deadline);
  });

  it("releases the job at the same step when a step reports it is incomplete", async () => {
    setWorkflow({
      type: "test-flow",
      steps: [
        { name: "one", run: async () => ({ ok: true }) },
        {
          name: "two",
          run: async () => {
            throw new StepIncomplete("3 probes still pending", 30);
          },
        },
      ],
    });

    const outcome = await runJob(
      db as unknown as SupabaseClient,
      job({ attempts: 2, max_attempts: 3 }),
      FAR_FUTURE()
    );

    expect(outcome).toBe("yielded");
    const stored = db.job("job-1");
    expect(stored?.status).toBe("pending");
    expect(stored?.current_step).toBe("two");
    // Not a failed attempt: the counter goes back, nothing is recorded as an error.
    expect(stored?.attempts).toBe(1);
    expect(stored?.last_error ?? null).toBeNull();
    expect(new Date(stored?.run_after as string).getTime()).toBeGreaterThan(Date.now() + 20_000);
    // The finished step is kept; the incomplete one is still "running".
    expect(db.step("job-1", "one")?.status).toBe("completed");
    expect(db.step("job-1", "two")?.status).toBe("running");
  });
});
