import { afterEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import { setLlmProvider } from "@/lib/providers/llm/registry";
import type { LLMProvider, LlmStructuredResult, LlmTextResult } from "@/lib/providers/llm/types";
import { createBudget, AgentContext } from "@/lib/agents/contract";
import { runAgent } from "@/lib/agents/runner";
import { serpAnalysisAgent } from "@/lib/agents/serp-analysis";
import { outlineAgent } from "@/lib/agents/outline";

/**
 * Intelligence agents against a stub provider: real schemas, real prompts,
 * real runner. Asserted: the boundary degrades noise deterministically, and
 * SERP evidence actually reaches the outline's prompt.
 */

const usage = { model: "stub", inputTokens: 100, outputTokens: 200, costUsd: 0.001 };

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

const ctx = (): AgentContext => ({
  userId: "user-1",
  articleId: "article-1",
  jobId: "job-1",
  language: "Italian",
  runId: "run-1",
  budget: createBudget(1),
});

afterEach(() => setLlmProvider(null));

describe("serp-analysis agent", () => {
  const INPUT = {
    keyword: "codici sconto automatici",
    language: "Italian",
    businessName: "Postwren",
    results: [
      {
        position: 1,
        title: "Come creare codici sconto",
        domain: "shopify.com",
        snippet: "Guida completa.",
      },
    ],
    peopleAlsoAsk: ["Come si genera un codice sconto?"],
    relatedSearches: ["codici sconto shopify"],
  };

  it("normalises the model's judgement at the boundary", async () => {
    setLlmProvider(
      stubProvider({
        structured: {
          intent: "how-to-guide", // off-list
          difficulty: 140,
          angle: "Punta sull'automazione end-to-end.",
          questions: Array.from({ length: 12 }, (_, i) => ` Domanda ${i}? `),
          gaps: Array.from({ length: 9 }, (_, i) => `gap ${i}`),
        },
      })
    );

    const result = await runAgent(serpAnalysisAgent, INPUT, ctx());
    expect(result.intent).toBe("mixed");
    expect(result.difficulty).toBe(100);
    expect(result.questions).toHaveLength(8);
    expect(result.questions[0]).toBe("Domanda 0?");
    expect(result.gaps).toHaveLength(6);
  });

  it("keeps a valid intent and shows the evidence to the model", async () => {
    let prompt = "";
    setLlmProvider(
      stubProvider({
        structured: {
          intent: "commercial",
          difficulty: 55,
          angle: "a",
          questions: [],
          gaps: [],
        },
        capture: (p) => (prompt = p),
      })
    );

    const result = await runAgent(serpAnalysisAgent, INPUT, ctx());
    expect(result.intent).toBe("commercial");
    expect(prompt).toContain("shopify.com");
    expect(prompt).toContain("Come si genera un codice sconto?");
    expect(prompt).toContain("codici sconto shopify");
  });
});

describe("outline agent with SERP context", () => {
  const OUTLINE = {
    title: "Titolo",
    angle: "Angolo",
    intro: "Intro.",
    sections: Array.from({ length: 3 }, (_, i) => ({
      heading: `Sezione ${i}`,
      question: `Domanda ${i}?`,
      answer: `Risposta ${i}.`,
      points: ["p"],
      subsections: [],
    })),
    faq: [],
    entities: [],
  };

  const SERP = {
    intent: "informational",
    angle: "Rispondi con esempi pratici, non teoria.",
    questions: ["Quanto costa?"],
    competitorTitles: ["La guida definitiva ai codici sconto"],
    gaps: ["Nessuno spiega l'integrazione con l'email marketing"],
  };

  it("puts the real SERP evidence into the planning prompt", async () => {
    let prompt = "";
    setLlmProvider(stubProvider({ structured: OUTLINE, capture: (p) => (prompt = p) }));

    await runAgent(
      outlineAgent,
      { keyword: "k", language: "Italian", serp: SERP },
      ctx()
    );

    expect(prompt).toContain("real data, not assumptions");
    expect(prompt).toContain("informational");
    expect(prompt).toContain("La guida definitiva ai codici sconto");
    expect(prompt).toContain("Quanto costa?");
    expect(prompt).toContain("Nessuno spiega l'integrazione con l'email marketing");
    expect(prompt).toContain("Rispondi con esempi pratici, non teoria.");
  });

  it("still plans without SERP context, with no trace of it in the prompt", async () => {
    let prompt = "";
    setLlmProvider(stubProvider({ structured: OUTLINE, capture: (p) => (prompt = p) }));

    const result = await runAgent(
      outlineAgent,
      { keyword: "k", language: "Italian" },
      ctx()
    );

    expect(result.sections).toHaveLength(3);
    expect(prompt).not.toContain("real data, not assumptions");
  });
});
