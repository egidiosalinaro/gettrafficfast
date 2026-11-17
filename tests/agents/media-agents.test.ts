import { afterEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import { setLlmProvider } from "@/lib/providers/llm/registry";
import type { LLMProvider, LlmStructuredResult, LlmTextResult } from "@/lib/providers/llm/types";
import { createBudget, AgentContext } from "@/lib/agents/contract";
import { runAgent } from "@/lib/agents/runner";
import { videoSelectAgent } from "@/lib/agents/video-select";

const usage = { model: "stub", inputTokens: 50, outputTokens: 100, costUsd: 0.001 };

function stubProvider(structured: unknown, capture?: (prompt: string) => void): LLMProvider {
  return {
    name: "stub",
    async generateText(): Promise<LlmTextResult> {
      return { text: "", usage };
    },
    async generateStructured<T>(prompt: string, schema: z.ZodType<T>): Promise<LlmStructuredResult<T>> {
      capture?.(prompt);
      return { value: schema.parse(structured), usage, raw: "" };
    },
  };
}

const ctx = (): AgentContext => ({
  userId: "user-1",
  articleId: "article-1",
  jobId: "job-1",
  language: "English",
  runId: "run-1",
  budget: createBudget(1),
});

const HEADINGS = [
  { id: "one", level: 2, text: "Section one" },
  { id: "two", level: 2, text: "Section two" },
];

afterEach(() => setLlmProvider(null));

describe("video-select agent", () => {
  const CANDIDATES = [
    {
      videoId: "real1",
      title: "Parcel sorting machine walkthrough",
      channel: "Logistics TV",
      description: "A tour of a sorting facility",
      publishedAt: "2025-01-01T00:00:00Z",
    },
  ];

  it("returns selections tied to real candidates and sections", async () => {
    setLlmProvider(
      stubProvider({
        selections: [
          { videoId: "real1", headingId: "two", reason: "Shows the machine in motion", confidence: 0.9 },
        ],
      })
    );

    const result = await runAgent(
      videoSelectAgent,
      {
        keyword: "parcel sorting",
        language: "English",
        title: "How parcel sorting works",
        headings: HEADINGS,
        candidates: CANDIDATES,
        maxSelections: 1,
      },
      ctx()
    );

    expect(result.selections).toHaveLength(1);
    expect(result.selections[0].videoId).toBe("real1");
  });

  it("discards hallucinated video ids and unknown sections at the boundary", async () => {
    setLlmProvider(
      stubProvider({
        selections: [
          { videoId: "made-up", headingId: "two", reason: "Looks plausible but is invented", confidence: 0.95 },
          { videoId: "real1", headingId: "nowhere", reason: "Real video, invented section", confidence: 0.95 },
        ],
      })
    );

    const result = await runAgent(
      videoSelectAgent,
      {
        keyword: "parcel sorting",
        language: "English",
        title: "T",
        headings: HEADINGS,
        candidates: CANDIDATES,
        maxSelections: 1,
      },
      ctx()
    );

    expect(result.selections).toEqual([]);
  });

  it("accepts an empty selection as a first-class outcome", async () => {
    setLlmProvider(stubProvider({ selections: [] }));
    const result = await runAgent(
      videoSelectAgent,
      {
        keyword: "k",
        language: "English",
        title: "T",
        headings: HEADINGS,
        candidates: CANDIDATES,
        maxSelections: 1,
      },
      ctx()
    );
    expect(result.selections).toEqual([]);
  });
});
