import { afterEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import { setLlmProvider } from "@/lib/providers/llm/registry";
import type { LLMProvider, LlmStructuredResult, LlmTextResult } from "@/lib/providers/llm/types";
import { createBudget } from "@/lib/agents/contract";
import { runAgent } from "@/lib/agents/runner";
import { pushPageAgent } from "@/lib/agents/push-page";

/**
 * The push-page agent's boundary: one call, the main query in the prompt,
 * only the offered pages, one link per page, and a "sentence" without its
 * sentence dropped. Titles and links are checked later by code.
 */

const usage = { model: "stub", inputTokens: 100, outputTokens: 200, costUsd: 0.001 };

afterEach(() => setLlmProvider(null));

describe("push-page agent", () => {
  it("keeps only offered pages, one link each, and asks once on the fast tier", async () => {
    const prompts: string[] = [];
    const tiers: Array<string | undefined> = [];
    const provider: LLMProvider = {
      name: "stub",
      async generateText(): Promise<LlmTextResult> {
        return { text: "", usage };
      },
      async generateStructured<T>(prompt: string, schema: z.ZodType<T>, options?: { tier?: string }): Promise<LlmStructuredResult<T>> {
        prompts.push(prompt);
        tiers.push(options?.tier);
        return {
          value: schema.parse({
            metaTitle: "  X growth tools compared  ",
            metaDescription: "",
            links: [
              { sourceArticleId: "a", mode: "existing", anchor: "x growth tools" },
              { sourceArticleId: "a", mode: "existing", anchor: "again" },
              { sourceArticleId: "ghost", mode: "existing", anchor: "x growth tools" },
              { sourceArticleId: "b", mode: "sentence", anchor: "x growth tools", paragraph: 2 },
            ],
          }),
          usage,
          raw: "",
        };
      },
    };
    setLlmProvider(provider);
    const output = await runAgent(
      pushPageAgent,
      {
        language: "en",
        mainQuery: "x growth tools",
        target: { title: "Growing on X", metaTitle: null, metaDescription: null, bodyText: "We compared tools." },
        sources: [
          { articleId: "a", title: "A", paragraphs: [{ index: 1, text: "Some x growth tools work." }] },
          { articleId: "b", title: "B", paragraphs: [{ index: 1, text: "One." }, { index: 2, text: "Two." }] },
        ],
      },
      { userId: "u", language: "en", runId: "r", budget: createBudget(1) }
    );
    expect(prompts).toHaveLength(1);
    expect(tiers).toEqual(["fast"]);
    expect(prompts[0]).toContain('"x growth tools"');
    expect(prompts[0]).toContain("[2] Two.");
    expect(output).toEqual({
      metaTitle: "X growth tools compared",
      metaDescription: null,
      links: [{ sourceArticleId: "a", mode: "existing", anchor: "x growth tools", paragraph: null, sentence: null }],
    });
  });
});
