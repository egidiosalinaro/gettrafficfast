import { describe, expect, it, vi } from "vitest";
import { AgentBudgetExceeded, DEFAULT_AGENT_BUDGET_USD, agentBudgetUsd, createBudget } from "@/lib/agents/contract";

/**
 * AGENT_BUDGET_USD is read once, through one parser. A value that is not a
 * positive finite number used to become NaN, and a NaN ceiling never stopped
 * a run: every comparison with NaN is false.
 */

describe("agentBudgetUsd", () => {
  it("reads a valid value", () => {
    expect(agentBudgetUsd("0.75")).toBe(0.75);
    expect(agentBudgetUsd(" 2 ")).toBe(2);
  });

  it("falls back to the default when unset", () => {
    expect(agentBudgetUsd(undefined)).toBe(DEFAULT_AGENT_BUDGET_USD);
    expect(agentBudgetUsd("")).toBe(DEFAULT_AGENT_BUDGET_USD);
  });

  it("falls back to the default, and says so, for anything that is not a positive finite number", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const raw of ["abc", "0", "-1", "Infinity", "NaN", "1e400"]) {
      expect(agentBudgetUsd(raw)).toBe(DEFAULT_AGENT_BUDGET_USD);
    }
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe("createBudget", () => {
  it("stops a run at its ceiling", () => {
    const budget = createBudget(0.01);
    budget.charge(0.005);
    expect(() => budget.charge(0.01)).toThrow(AgentBudgetExceeded);
  });

  it("treats a non-finite ceiling as nothing left, never as no limit", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const max of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const budget = createBudget(max);
      expect(budget.maxCostUsd).toBe(0);
      expect(budget.remainingUsd()).toBe(0);
      expect(() => budget.charge(0.001)).toThrow(AgentBudgetExceeded);
    }
    error.mockRestore();
  });
});
