import { afterEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import { setLlmProvider } from "@/lib/providers/llm/registry";
import type { LLMProvider, LlmStructuredResult, LlmTextResult } from "@/lib/providers/llm/types";
import { createBudget, AgentContext } from "@/lib/agents/contract";
import { runAgent } from "@/lib/agents/runner";
import { knowledgeExtractAgent } from "@/lib/agents/knowledge-extract";
import { internalLinksAgent } from "@/lib/agents/internal-links";

/**
 * Knowledge agents against a stub provider: real schemas, real prompts, real
 * runner. What is asserted is the boundary — taxonomy noise, hallucinated ids
 * and over-counts degrade deterministically instead of failing the run.
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

describe("knowledge-extract agent", () => {
  const INPUT = {
    keyword: "codici sconto automatici",
    language: "Italian",
    title: "Come automatizzare i codici sconto",
    headings: [{ level: 2, text: "Perché i codici generici non funzionano" }],
    bodyText: "I codici sconto monouso proteggono il margine.",
  };

  it("normalises taxonomy noise at the boundary instead of failing", async () => {
    setLlmProvider(
      stubProvider({
        structured: {
          entities: [
            { name: "codici sconto", type: "marketing-concept", role: "core", salience: 1.7 },
            { name: "  Shopify ", type: "product", role: "mentioned", salience: -0.2 },
            { name: "Codici Sconto", type: "marketing-concept", role: "primary", salience: 0.9 },
          ],
          topics: [
            { name: "email marketing", isPrimary: false },
            { name: "promozioni", isPrimary: false },
          ],
        },
      })
    );

    const result = await runAgent(knowledgeExtractAgent, INPUT, ctx());

    // Unknown type → other, unknown role → mentioned, salience clamped.
    expect(result.entities[0]).toEqual({
      name: "codici sconto",
      type: "other",
      role: "mentioned",
      salience: 1,
    });
    // Name is trimmed; negative salience clamps to 0.
    expect(result.entities[1]).toEqual({
      name: "Shopify",
      type: "product",
      role: "mentioned",
      salience: 0,
    });
    // Case-insensitive duplicate of the first entity collapses.
    expect(result.entities).toHaveLength(2);
    // No topic marked primary → the first becomes primary, exactly one.
    expect(result.topics.filter((t) => t.isPrimary)).toEqual([
      { name: "email marketing", isPrimary: true },
    ]);
  });

  it("truncates over-count entities and topics in code", async () => {
    setLlmProvider(
      stubProvider({
        structured: {
          entities: Array.from({ length: 30 }, (_, i) => ({
            name: `entità ${i}`,
            type: "concept",
            role: "mentioned",
            salience: 0.5,
          })),
          topics: Array.from({ length: 6 }, (_, i) => ({
            name: `topic ${i}`,
            isPrimary: i === 0,
          })),
        },
      })
    );
    const result = await runAgent(knowledgeExtractAgent, INPUT, ctx());
    expect(result.entities).toHaveLength(20);
    expect(result.topics).toHaveLength(3);
  });

  it("passes the article and language to the model", async () => {
    let prompt = "";
    setLlmProvider(
      stubProvider({
        structured: {
          entities: [],
          topics: [{ name: "promozioni", isPrimary: true }],
        },
        capture: (p) => (prompt = p),
      })
    );
    await runAgent(knowledgeExtractAgent, INPUT, ctx());
    expect(prompt).toContain("codici sconto automatici");
    expect(prompt).toContain(INPUT.bodyText);
    expect(prompt).toContain("Italian");
  });
});

describe("internal-links agent", () => {
  const INPUT = {
    language: "Italian",
    sourceTitle: "Come automatizzare i codici sconto",
    sourceBodyText: "I codici sconto monouso proteggono il margine del negozio.",
    targets: [
      {
        articleId: "target-1",
        title: "Codici sconto unici: la guida",
        keyword: "codici sconto unici",
        excerpt: "Come generare codici monouso.",
      },
      {
        articleId: "target-2",
        title: "Proteggere il margine",
        keyword: "margine e-commerce",
        excerpt: "Strategie di pricing.",
      },
    ],
    maxLinks: 1,
  };

  it("discards hallucinated targets, duplicates, and enforces maxLinks in code", async () => {
    setLlmProvider(
      stubProvider({
        structured: {
          links: [
            { targetArticleId: "invented", anchor: "codici sconto monouso", reason: "r" },
            { targetArticleId: "target-1", anchor: "codici sconto monouso", reason: "r" },
            { targetArticleId: "target-1", anchor: "il margine", reason: "duplicato" },
            { targetArticleId: "target-2", anchor: "margine del negozio", reason: "r" },
          ],
        },
      })
    );

    const result = await runAgent(internalLinksAgent, INPUT, ctx());
    // Hallucinated id dropped, one per target, then capped at maxLinks = 1.
    expect(result.links).toEqual([
      { targetArticleId: "target-1", anchor: "codici sconto monouso", reason: "r" },
    ]);
  });

  it("an empty selection is a valid outcome", async () => {
    setLlmProvider(stubProvider({ structured: { links: [] } }));
    const result = await runAgent(internalLinksAgent, INPUT, ctx());
    expect(result.links).toEqual([]);
  });

  it("shows every allowed target to the model", async () => {
    let prompt = "";
    setLlmProvider(stubProvider({ structured: { links: [] }, capture: (p) => (prompt = p) }));
    await runAgent(internalLinksAgent, INPUT, ctx());
    expect(prompt).toContain("target-1");
    expect(prompt).toContain("target-2");
    expect(prompt).toContain("character-for-character");
  });
});
