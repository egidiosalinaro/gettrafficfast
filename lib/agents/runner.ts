import type { SupabaseClient } from "@supabase/supabase-js";
import type { LlmUsage } from "@/lib/providers/llm/types";
import { Agent, AgentBudgetExceeded, AgentContext } from "./contract";

/**
 * Runs an agent: validates the boundary, enforces the budget, times it, and
 * records the run. Every agent invocation in the platform goes through here, so
 * the audit trail cannot be forgotten at a call site.
 */

export class AgentValidationError extends Error {
  constructor(
    readonly agent: string,
    readonly side: "input" | "output",
    readonly issues: string
  ) {
    super(`Agent "${agent}" produced an invalid ${side}: ${issues}`);
    this.name = "AgentValidationError";
  }
}

export interface AgentRunRecord {
  agent: string;
  version: number;
  status: "completed" | "failed";
  input: unknown;
  output: unknown | null;
  /**
   * What the run's calls cost. Null when it is not known: the agent threw
   * before it could say (a provider error, a call cut off), so the call may
   * or may not have been billed. Recorded as a null cost, never as $0; the
   * daily spend ceiling counts it at an estimate (lib/limits/estimates.ts).
   */
  usage: LlmUsage[] | null;
  latencyMs: number;
  error?: string;
  ctx: AgentContext;
}

export interface AgentRecorder {
  record(run: AgentRunRecord): Promise<void>;
}

/** Used by tests and by any path where persistence is not wanted. */
export const nullRecorder: AgentRecorder = { async record() {} };

/**
 * What `agent_runs.llm_calls` holds: one entry per model call of the run,
 * with who answered. `agent_runs.model` keeps only the first call's model;
 * the provider and whether it was the fallback are only here. Null when the
 * run failed before it could say.
 */
export function llmCallsOf(usage: LlmUsage[] | null): Record<string, unknown>[] | null {
  if (usage === null) return null;
  return usage.map((u) => ({
    provider: u.provider ?? null,
    model: u.model,
    fallback: u.fallback ?? false,
    tierDowngraded: u.tierDowngraded ?? false,
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    costUsd: Number(u.costUsd.toFixed(6)),
  }));
}

/** The column does not exist yet: the code reached production before its migration. */
function isMissingLlmCalls(error: { code?: string; message?: string }): boolean {
  return (error.code === "PGRST204" || error.code === "42703") && /llm_calls/.test(error.message ?? "");
}

export function supabaseRecorder(supabase: SupabaseClient): AgentRecorder {
  return {
    async record(run) {
      const measured = run.usage !== null;
      const totals = (run.usage ?? []).reduce(
        (acc, u) => ({
          inputTokens: acc.inputTokens + u.inputTokens,
          outputTokens: acc.outputTokens + u.outputTokens,
          costUsd: acc.costUsd + u.costUsd,
        }),
        { inputTokens: 0, outputTokens: 0, costUsd: 0 }
      );

      const row = {
        user_id: run.ctx.userId,
        business_id: run.ctx.businessId ?? null,
        article_id: run.ctx.articleId ?? null,
        job_id: run.ctx.jobId ?? null,
        agent: run.agent,
        agent_version: run.version,
        status: run.status,
        input: run.input ?? null,
        output: run.output ?? null,
        model: run.usage?.[0]?.model ?? null,
        input_tokens: measured ? totals.inputTokens : null,
        output_tokens: measured ? totals.outputTokens : null,
        cost_usd: measured ? Number(totals.costUsd.toFixed(6)) : null,
        latency_ms: run.latencyMs,
        error: run.error ?? null,
      };

      // Never let bookkeeping break a production run. A cost that is not
      // recorded is a cost the spend ceiling cannot see, so a missing
      // `llm_calls` column loses the calls and keeps the row.
      let { error } = await supabase.from("agent_runs").insert({ ...row, llm_calls: llmCallsOf(run.usage) });
      if (error && isMissingLlmCalls(error)) {
        ({ error } = await supabase.from("agent_runs").insert(row));
      }
      if (error) {
        console.warn(
          JSON.stringify({ level: "warn", event: "agent_run.record_failed", error: error.message })
        );
      }
    },
  };
}

export async function runAgent<I, O>(
  agent: Agent<I, O>,
  input: I,
  ctx: AgentContext,
  recorder: AgentRecorder = nullRecorder
): Promise<O> {
  const parsedInput = agent.inputSchema.safeParse(input);
  if (!parsedInput.success) {
    throw new AgentValidationError(
      agent.name,
      "input",
      parsedInput.error.issues.map((i) => `${i.path.join(".") || "root"}: ${i.message}`).join("; ")
    );
  }

  if (ctx.budget.remainingUsd() <= 0) {
    // No amount in the message: it can reach a customer's card (lib/agents/contract.ts).
    throw new AgentBudgetExceeded(`Budget for AI work exhausted before running "${agent.name}".`);
  }

  const startedAt = Date.now();
  // What the failed row says it cost: unknown (null) until the agent has
  // answered with its usage; once the completed row carries the cost, a
  // failure after it (the budget charge) adds nothing of its own.
  let failedUsage: LlmUsage[] | null = null;
  try {
    const result = await agent.run(parsedInput.data, ctx);
    failedUsage = Array.isArray(result.usage) ? result.usage : null;

    const parsedOutput = agent.outputSchema.safeParse(result.output);
    if (!parsedOutput.success) {
      throw new AgentValidationError(
        agent.name,
        "output",
        parsedOutput.error.issues
          .map((i) => `${i.path.join(".") || "root"}: ${i.message}`)
          .join("; ")
      );
    }

    const latencyMs = Date.now() - startedAt;
    await recorder.record({
      agent: agent.name,
      version: agent.version,
      status: "completed",
      input: parsedInput.data,
      output: parsedOutput.data,
      usage: result.usage,
      latencyMs,
      ctx,
    });
    failedUsage = [];

    // Charged after the fact: agents own their calls, the runner owns the
    // ceiling, and the next agent is refused once the budget is gone.
    for (const usage of result.usage) ctx.budget.charge(usage.costUsd);

    return parsedOutput.data;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recorder.record({
      agent: agent.name,
      version: agent.version,
      status: "failed",
      input: parsedInput.data,
      output: null,
      usage: failedUsage,
      latencyMs: Date.now() - startedAt,
      error: message.slice(0, 2000),
      ctx,
    });
    throw err;
  }
}
