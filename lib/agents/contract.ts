import type { z } from "zod";
import type { LlmUsage } from "@/lib/providers/llm/types";

/**
 * The agent contract.
 *
 * An agent has one responsibility, declares its input and output as schemas,
 * and returns data. It never writes to the database, never decides what runs
 * next, and never sees another agent — composition is the orchestrator's job.
 *
 * Inference is model-driven; the boundary is not. Anything crossing it is
 * validated, which is what makes an agent a component rather than a liability.
 */

export interface AgentBudget {
  readonly maxCostUsd: number;
  spentUsd(): number;
  /** Throws once the ceiling is reached, so a run cannot silently overspend. */
  charge(usd: number): void;
  remainingUsd(): number;
}

/** Ceiling per article when AGENT_BUDGET_USD is unset or unusable. */
export const DEFAULT_AGENT_BUDGET_USD = 0.5;

let warnedBudgetValue: string | null = null;

/**
 * AGENT_BUDGET_USD, parsed once for every caller. A value that is not a
 * finite number above zero ("", "abc", "0", "-1", "Infinity") falls back to
 * the default with a log line: `Number("abc")` is NaN, every comparison with
 * NaN is false, and a NaN ceiling never stopped a run.
 */
export function agentBudgetUsd(raw: string | undefined = process.env.AGENT_BUDGET_USD): number {
  const text = (raw ?? "").trim();
  if (!text) return DEFAULT_AGENT_BUDGET_USD;
  const value = Number(text);
  if (Number.isFinite(value) && value > 0) return value;
  if (warnedBudgetValue !== text) {
    warnedBudgetValue = text;
    console.error(
      JSON.stringify({
        level: "error",
        event: "agent_budget.invalid_env",
        value: text.slice(0, 40),
        fallback_usd: DEFAULT_AGENT_BUDGET_USD,
      })
    );
  }
  return DEFAULT_AGENT_BUDGET_USD;
}

/**
 * A ceiling that is not a finite number is treated as zero: the first charge
 * throws. Spending nothing is the safe reading of a ceiling nobody can read;
 * spending without limit is not.
 */
export function createBudget(requestedMaxUsd: number): AgentBudget {
  const maxCostUsd = Number.isFinite(requestedMaxUsd) ? Math.max(0, requestedMaxUsd) : 0;
  if (maxCostUsd !== requestedMaxUsd) {
    console.error(
      JSON.stringify({ level: "error", event: "agent_budget.invalid_max", requested: String(requestedMaxUsd) })
    );
  }
  let spent = 0;
  return {
    maxCostUsd,
    spentUsd: () => spent,
    remainingUsd: () => Math.max(0, maxCostUsd - spent),
    charge(usd: number) {
      spent += usd;
      if (spent > maxCostUsd) {
        // The amounts go to the log, not the message: the message can reach
        // a job's failure, an article card or a draft card, and what a run
        // costs the platform is never the customer's (owner's decision,
        // 2026-11-14). agent_runs keeps each call's cost.
        console.warn(
          JSON.stringify({
            level: "warn",
            event: "agent_budget.exceeded",
            spent_usd: Number(spent.toFixed(4)),
            max_usd: Number(maxCostUsd.toFixed(4)),
          })
        );
        throw new AgentBudgetExceeded("Run exceeded its budget for AI work.");
      }
    },
  };
}

export class AgentBudgetExceeded extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentBudgetExceeded";
  }
}

export interface AgentContext {
  userId: string;
  /** The site this run is for, recorded on the audit row. */
  businessId?: string | null;
  articleId?: string;
  jobId?: string;
  /** Output language for anything the agent writes. */
  language: string;
  /** Correlation id shared by every agent in one production run. */
  runId: string;
  budget: AgentBudget;
  signal?: AbortSignal;
  /**
   * The provider arm the job was given (the article rotation,
   * lib/providers/llm/registry.ts). Set by article production only; an agent
   * hands it to `getLlmProvider` and never reads it.
   */
  llmArm?: string | null;
}

export interface AgentResult<O> {
  output: O;
  usage: LlmUsage[];
  /** Non-fatal observations for the orchestrator to aggregate. */
  notes?: string[];
}

export interface Agent<I, O> {
  /** Stable identifier, used as the key in agent_runs. */
  readonly name: string;
  /** Bumped whenever the prompt or the schemas change behaviour. */
  readonly version: number;
  readonly inputSchema: z.ZodType<I>;
  readonly outputSchema: z.ZodType<O>;
  run(input: I, ctx: AgentContext): Promise<AgentResult<O>>;
}
