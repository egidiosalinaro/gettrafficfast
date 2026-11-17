import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Agent, AgentBudgetExceeded, AgentContext, createBudget } from "@/lib/agents/contract";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AgentValidationError, runAgent, AgentRecorder, supabaseRecorder } from "@/lib/agents/runner";
import { FakeSupabase } from "../support/fake-supabase";

const Input = z.object({ topic: z.string().min(1) });
const Output = z.object({ headline: z.string().min(1) });

function context(maxCostUsd = 1): AgentContext {
  return {
    userId: "user-1",
    articleId: "article-1",
    jobId: "job-1",
    language: "en",
    runId: "run-1",
    budget: createBudget(maxCostUsd),
  };
}

function agent(
  impl: (input: z.infer<typeof Input>) => Promise<{ output: unknown; usage: never[] }>
): Agent<z.infer<typeof Input>, z.infer<typeof Output>> {
  return {
    name: "test-agent",
    version: 1,
    inputSchema: Input,
    outputSchema: Output,
    run: impl as never,
  };
}

const usage = (costUsd: number) => [
  { model: "test", inputTokens: 10, outputTokens: 20, costUsd },
];

describe("agent runner", () => {
  it("returns the validated output", async () => {
    const result = await runAgent(
      agent(async () => ({ output: { headline: "Hello" }, usage: usage(0.01) as never })),
      { topic: "seo" },
      context()
    );
    expect(result).toEqual({ headline: "Hello" });
  });

  it("rejects an invalid input before calling the agent", async () => {
    const run = vi.fn();
    await expect(
      runAgent(agent(run as never), { topic: "" }, context())
    ).rejects.toBeInstanceOf(AgentValidationError);
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects an output that does not match the schema", async () => {
    await expect(
      runAgent(
        agent(async () => ({ output: { wrong: true }, usage: [] as never })),
        { topic: "seo" },
        context()
      )
    ).rejects.toBeInstanceOf(AgentValidationError);
  });

  it("records a completed run with its usage", async () => {
    const recorder: AgentRecorder = { record: vi.fn(async () => {}) };
    await runAgent(
      agent(async () => ({ output: { headline: "Hi" }, usage: usage(0.02) as never })),
      { topic: "seo" },
      context(),
      recorder
    );

    expect(recorder.record).toHaveBeenCalledOnce();
    const run = (recorder.record as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(run.status).toBe("completed");
    expect(run.agent).toBe("test-agent");
    expect(run.usage[0].costUsd).toBe(0.02);
  });

  it("records a failed run and rethrows", async () => {
    const recorder: AgentRecorder = { record: vi.fn(async () => {}) };
    await expect(
      runAgent(
        agent(async () => {
          throw new Error("provider exploded");
        }),
        { topic: "seo" },
        context(),
        recorder
      )
    ).rejects.toThrow("provider exploded");

    const run = (recorder.record as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(run.status).toBe("failed");
    expect(run.error).toContain("provider exploded");
  });

  it("records a run that threw before reporting its usage as not measured: a null cost, never $0", async () => {
    const recorder: AgentRecorder = { record: vi.fn(async () => {}) };
    await expect(
      runAgent(
        agent(async () => {
          throw new Error("provider exploded");
        }),
        { topic: "seo" },
        context(),
        recorder
      )
    ).rejects.toThrow();
    expect((recorder.record as ReturnType<typeof vi.fn>).mock.calls[0][0].usage).toBeNull();

    const db = new FakeSupabase();
    await expect(
      runAgent(
        agent(async () => {
          throw new Error("provider exploded");
        }),
        { topic: "seo" },
        context(),
        supabaseRecorder(db as unknown as SupabaseClient)
      )
    ).rejects.toThrow();
    expect(db.tables.agent_runs[0]).toMatchObject({
      status: "failed",
      model: null,
      cost_usd: null,
      input_tokens: null,
      output_tokens: null,
    });
  });

  it("records what a run whose output was refused did cost: the model answered and was paid", async () => {
    const db = new FakeSupabase();
    await expect(
      runAgent(
        agent(async () => ({ output: { wrong: true }, usage: usage(0.03) as never })),
        { topic: "seo" },
        context(),
        supabaseRecorder(db as unknown as SupabaseClient)
      )
    ).rejects.toBeInstanceOf(AgentValidationError);
    expect(db.tables.agent_runs[0]).toMatchObject({ status: "failed", model: "test", cost_usd: 0.03, input_tokens: 10 });
  });

  it("records who answered each call: provider, model and whether it was the fallback", async () => {
    const db = new FakeSupabase();
    const calls = [
      { model: "claude-haiku-5-5", inputTokens: 10, outputTokens: 20, costUsd: 0.0000111, provider: "anthropic", fallback: false },
      { model: "gemini-2.5-flash", inputTokens: 5, outputTokens: 5, costUsd: 0.002, provider: "gemini", fallback: true, tierDowngraded: false },
    ];
    await runAgent(
      agent(async () => ({ output: { headline: "Hi" }, usage: calls as never })),
      { topic: "seo" },
      context(),
      supabaseRecorder(db as unknown as SupabaseClient)
    );
    expect(db.tables.agent_runs[0]).toMatchObject({
      status: "completed",
      // The column that existed before keeps the first call's model only.
      model: "claude-haiku-5-5",
      llm_calls: [
        { provider: "anthropic", model: "claude-haiku-5-5", fallback: false, tierDowngraded: false, inputTokens: 10, outputTokens: 20, costUsd: 0.000011 },
        { provider: "gemini", model: "gemini-2.5-flash", fallback: true, tierDowngraded: false, inputTokens: 5, outputTokens: 5, costUsd: 0.002 },
      ],
    });
  });

  it("records no calls, rather than an empty list, for a run that failed before it could say", async () => {
    const db = new FakeSupabase();
    await expect(
      runAgent(
        agent(async () => {
          throw new Error("provider exploded");
        }),
        { topic: "seo" },
        context(),
        supabaseRecorder(db as unknown as SupabaseClient)
      )
    ).rejects.toThrow();
    expect(db.tables.agent_runs[0].llm_calls).toBeNull();
  });

  it("keeps the row, and its cost, when the llm_calls column is not there yet", async () => {
    // The code reached production before its migration: the insert that names
    // the column is refused, and the run must still count against the budget.
    const rows: Record<string, unknown>[] = [];
    const attempts: Record<string, unknown>[] = [];
    const supabase = {
      from: () => ({
        insert: async (row: Record<string, unknown>) => {
          attempts.push(row);
          if ("llm_calls" in row) {
            return { error: { code: "PGRST204", message: "Could not find the 'llm_calls' column of 'agent_runs' in the schema cache" } };
          }
          rows.push(row);
          return { error: null };
        },
      }),
    };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await runAgent(
      agent(async () => ({ output: { headline: "Hi" }, usage: usage(0.03) as never })),
      { topic: "seo" },
      context(),
      supabaseRecorder(supabase as unknown as SupabaseClient)
    );
    expect(attempts).toHaveLength(2);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "completed", cost_usd: 0.03 });
    expect(rows[0]).not.toHaveProperty("llm_calls");
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("puts the cost on the completed row only when the budget refuses after it", async () => {
    const db = new FakeSupabase();
    await expect(
      runAgent(
        agent(async () => ({ output: { headline: "Hi" }, usage: usage(0.06) as never })),
        { topic: "seo" },
        context(0.05),
        supabaseRecorder(db as unknown as SupabaseClient)
      )
    ).rejects.toBeInstanceOf(AgentBudgetExceeded);
    expect(db.tables.agent_runs.map((row) => [row.status, row.cost_usd])).toEqual([
      ["completed", 0.06],
      ["failed", 0],
    ]);
  });

  it("charges the budget and refuses to start once it is exhausted", async () => {
    const ctx = context(0.05);
    const spender = agent(async () => ({
      output: { headline: "Hi" },
      usage: usage(0.04) as never,
    }));

    await runAgent(spender, { topic: "one" }, ctx);
    expect(ctx.budget.spentUsd()).toBeCloseTo(0.04);

    // The second run pushes past the ceiling and is charged...
    await expect(runAgent(spender, { topic: "two" }, ctx)).rejects.toBeInstanceOf(
      AgentBudgetExceeded
    );
    // ...so a third is refused before it can call the provider at all.
    const run = vi.fn();
    await expect(runAgent(agent(run as never), { topic: "three" }, ctx)).rejects.toBeInstanceOf(
      AgentBudgetExceeded
    );
    expect(run).not.toHaveBeenCalled();
  });
});
