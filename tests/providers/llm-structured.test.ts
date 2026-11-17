import { describe, expect, it } from "vitest";
import { z } from "zod";
import { completeStructured, unfence } from "@/lib/providers/llm/structured";
import { LlmError, type LlmUsage } from "@/lib/providers/llm/types";

const Shape = z.object({ title: z.string().min(1), count: z.number() });
const VENDOR = { provider: "fake", label: "Fake" };

function usage(costUsd: number): LlmUsage {
  return { model: "fake-model", inputTokens: 100, outputTokens: 50, costUsd };
}

function scripted(answers: string[]) {
  const prompts: string[] = [];
  const complete = async (prompt: string) => {
    prompts.push(prompt);
    return { text: answers[prompts.length - 1] ?? "", usage: usage(0.01) };
  };
  return { prompts, complete };
}

describe("completeStructured", () => {
  it("asks for the schema and returns the validated value", async () => {
    const { prompts, complete } = scripted(['{"title":"A","count":2}']);
    const result = await completeStructured(complete, "Plan it.", Shape, VENDOR);

    expect(result.value).toEqual({ title: "A", count: 2 });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Plan it.");
    expect(prompts[0]).toContain("matching this JSON Schema exactly");
    expect(prompts[0]).toContain('"title"');
  });

  it("reads JSON the model wrapped in a code fence", async () => {
    const { complete } = scripted(['```json\n{"title":"A","count":2}\n```']);
    const result = await completeStructured(complete, "Plan it.", Shape, VENDOR);
    expect(result.value.count).toBe(2);
    expect(unfence("```\n[1]\n```")).toBe("[1]");
  });

  it("retries once with the specific issue, and charges both attempts", async () => {
    const { prompts, complete } = scripted(['{"title":"","count":2}', '{"title":"A","count":2}']);
    const result = await completeStructured(complete, "Plan it.", Shape, VENDOR);

    expect(result.value.title).toBe("A");
    expect(prompts[1]).toContain("did not match the schema (title:");
    expect(result.usage.inputTokens).toBe(200);
    expect(result.usage.outputTokens).toBe(100);
    expect(result.usage.costUsd).toBeCloseTo(0.02);
  });

  it("fails as the vendor's LlmError after two misses, and stays retryable", async () => {
    const { prompts, complete } = scripted(["not json", '{"count":"two"}']);
    const error = await completeStructured(complete, "Plan it.", Shape, VENDOR).catch((e) => e);

    expect(prompts).toHaveLength(2);
    expect(error).toBeInstanceOf(LlmError);
    expect(error.provider).toBe("fake");
    expect(error.message).toMatch(/^Fake returned a response that does not match the expected schema/);
    expect(error.retryable).toBe(true);
  });
});
