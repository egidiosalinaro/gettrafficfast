import { afterEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import { setLlmProvider } from "@/lib/providers/llm/registry";
import type { LLMProvider, LlmStructuredResult, LlmTextResult } from "@/lib/providers/llm/types";
import { createBudget } from "@/lib/agents/contract";
import { runAgent } from "@/lib/agents/runner";
import { proposePromptsAgent } from "@/lib/agents/propose-prompts";

const usage = { model: "stub", inputTokens: 80, outputTokens: 120, costUsd: 0.002 };

function stubProvider(responses: {
  structured?: unknown;
  capture?: (prompt: string) => void;
}): LLMProvider {
  return {
    name: "stub",
    async generateText(): Promise<LlmTextResult> {
      return { text: "", usage };
    },
    async generateStructured<T>(prompt: string, schema: z.ZodType<T>): Promise<LlmStructuredResult<T>> {
      responses.capture?.(prompt);
      return { value: schema.parse(responses.structured), usage, raw: "" };
    },
  };
}

afterEach(() => setLlmProvider(null));

describe("propose-prompts agent", () => {
  it("returns schema-valid prompts and drops an intent it does not know", async () => {
    setLlmProvider(
      stubProvider({
        structured: {
          prompts: [
            {
              query: "how do I get my SaaS cited in AI answers",
              cluster: "citations",
              intent: "informational",
              why: "This is how a founder would ask.",
            },
            {
              query: "best tool that writes and publishes SEO articles",
              cluster: "publishing",
              intent: "commercial",
              why: "A buying question.",
            },
            {
              query: "should I hire a writer or use software",
              cluster: null,
              intent: "transactional",
              why: "Unknown intent must not leak through.",
            },
          ],
        },
      }),
    );

    const output = await runAgent(
      proposePromptsAgent,
      {
        business: {
          name: "GetTrafficFast",
          niche: "AI SEO",
          description: "Publishes articles and measures citations.",
          domain: "gettrafficfa.st",
        },
        language: "English",
        existing: ["AEO vs SEO"],
        keywords: ["SEO articles on autopilot"],
        competitors: [],
      },
      {
        userId: "user-1",
        businessId: "biz-1",
        language: "English",
        runId: "run-1",
        budget: createBudget(0.05),
      },
    );

    expect(output.prompts).toHaveLength(2);
    expect(output.prompts.map((p) => p.intent)).toEqual(["informational", "commercial"]);
    expect(output.prompts.some((p) => p.query.includes("transactional"))).toBe(false);
  });

  it("tells the model not to invent competitor brands when none are listed", async () => {
    let seen = "";
    setLlmProvider(
      stubProvider({
        capture: (prompt) => {
          seen = prompt;
        },
        structured: {
          prompts: [
            {
              query: "how do I see if an answer engine recommends my product",
              cluster: "visibility",
              intent: "informational",
              why: "The measurement question.",
            },
          ],
        },
      }),
    );

    await runAgent(
      proposePromptsAgent,
      {
        business: {
          name: "GetTrafficFast",
          niche: null,
          description: null,
          domain: "gettrafficfa.st",
        },
        language: "English",
        existing: [],
        keywords: [],
        competitors: [],
      },
      {
        userId: "user-1",
        language: "English",
        runId: "run-2",
        budget: createBudget(0.05),
      },
    );

    expect(seen).toContain("do not invent brand names");
    expect(seen).toContain("Never invent a competitor brand");
    expect(seen).toContain("gettrafficfa.st");
  });
});
