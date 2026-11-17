import { afterEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import { setLlmProvider } from "@/lib/providers/llm/registry";
import type { LLMProvider, LlmStructuredResult, LlmTextResult } from "@/lib/providers/llm/types";
import { createBudget, AgentContext } from "@/lib/agents/contract";
import { runAgent } from "@/lib/agents/runner";
import { refreshPlanAgent } from "@/lib/agents/refresh-plan";
import { refreshWriteAgent } from "@/lib/agents/refresh-write";

/**
 * The refresh agents decide whether to rewrite a page that currently works.
 * The boundary's job is to make "leave it alone" the outcome of every unclear
 * answer — a garbled verdict must never read as permission to rewrite.
 */

const usage = { model: "stub", inputTokens: 100, outputTokens: 200, costUsd: 0.001 };

function stubProvider(responses: {
  text?: string;
  structured?: unknown;
  capture?: (prompt: string) => void;
}): LLMProvider {
  return {
    name: "stub",
    async generateText(prompt): Promise<LlmTextResult> {
      responses.capture?.(prompt);
      return { text: responses.text ?? "", usage };
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

const INPUT = {
  keyword: "codici sconto automatici",
  language: "Italian",
  title: "Come automatizzare i codici sconto",
  headings: [
    { id: "uno", level: 2, text: "Perché i codici generici non funzionano" },
    { id: "due", level: 2, text: "Come funzionano i codici unici" },
  ],
  bodyText: "Testo dell'articolo pubblicato.",
  decayDetail: "slipped from #4 to #16 between 2026-06-01 and 2026-08-20",
  competitors: [
    { position: 1, title: "La guida definitiva", domain: "rival.com", snippet: "Tutto sui codici." },
  ],
  questions: ["Quanto costa generare codici unici?"],
};

afterEach(() => setLlmProvider(null));

describe("refresh-plan agent", () => {
  it("carries the decay evidence and the rivals into the prompt", async () => {
    let prompt = "";
    setLlmProvider(
      stubProvider({
        structured: { verdict: "leave", reason: "è già la risposta migliore", revisions: [], additions: [], metaDescription: null },
        capture: (p) => (prompt = p),
      })
    );

    const result = await runAgent(refreshPlanAgent, INPUT, ctx());
    expect(result.verdict).toBe("leave");
    expect(prompt).toContain("slipped from #4 to #16");
    expect(prompt).toContain("rival.com");
    expect(prompt).toContain("Quanto costa generare codici unici?");
  });

  it("keeps a refresh verdict with concrete work attached", async () => {
    setLlmProvider(
      stubProvider({
        structured: {
          verdict: "refresh",
          reason: "mancano i prezzi aggiornati",
          revisions: [{ headingId: "due", instruction: "Aggiorna i prezzi 2026." }],
          additions: [],
          metaDescription: null,
        },
      })
    );
    const result = await runAgent(refreshPlanAgent, INPUT, ctx());
    expect(result.verdict).toBe("refresh");
    expect(result.revisions).toHaveLength(1);
  });

  it("treats an unrecognised verdict as leave", async () => {
    setLlmProvider(
      stubProvider({
        structured: {
          verdict: "maybe rewrite it?",
          reason: "r",
          revisions: [{ headingId: "uno", instruction: "i" }],
          additions: [],
          metaDescription: null,
        },
      })
    );
    const result = await runAgent(refreshPlanAgent, INPUT, ctx());
    expect(result.verdict).toBe("leave");
  });

  it("downgrades a refresh with nothing concrete to do", async () => {
    // Every instruction pointed at a section that does not exist, so there is
    // no work left — rewriting on that basis would be rewriting blind.
    setLlmProvider(
      stubProvider({
        structured: {
          verdict: "refresh",
          reason: "r",
          revisions: [{ headingId: "inventata", instruction: "i" }],
          additions: [],
          metaDescription: null,
        },
      })
    );
    const result = await runAgent(refreshPlanAgent, INPUT, ctx());
    expect(result.verdict).toBe("leave");
    expect(result.revisions).toEqual([]);
  });

  it("clamps a meta description instead of failing the run", async () => {
    setLlmProvider(
      stubProvider({
        structured: {
          verdict: "refresh",
          reason: "r",
          revisions: [{ headingId: "uno", instruction: "i" }],
          additions: [],
          metaDescription: "frase lunga ".repeat(40).trim(),
        },
      })
    );
    const result = await runAgent(refreshPlanAgent, INPUT, ctx());
    expect(result.metaDescription!.length).toBeLessThanOrEqual(160);
  });

  it("places an addition against a real heading, or at the end", async () => {
    setLlmProvider(
      stubProvider({
        structured: {
          verdict: "refresh",
          reason: "r",
          revisions: [],
          additions: [
            { afterHeadingId: "inventata", heading: "Prezzi", angle: "a" },
            { afterHeadingId: "uno", heading: "FAQ", angle: "a" },
          ],
          metaDescription: null,
        },
      })
    );
    const result = await runAgent(refreshPlanAgent, INPUT, ctx());
    expect(result.additions[0].afterHeadingId).toBeNull();
    expect(result.additions[1].afterHeadingId).toBe("uno");
  });
});

describe("refresh-write agent", () => {
  it("shows the writer the current article and the instructions", async () => {
    let prompt = "";
    setLlmProvider(
      stubProvider({
        text: "<h1>Titolo</h1><p>Corpo aggiornato.</p>",
        capture: (p) => (prompt = p),
      })
    );

    const result = await runAgent(
      refreshWriteAgent,
      {
        keyword: "codici sconto automatici",
        language: "Italian",
        title: "Come automatizzare i codici sconto",
        currentHtml: "<h1>Come automatizzare i codici sconto</h1><p>Vecchio corpo.</p>",
        revisions: [{ heading: "Come funzionano i codici unici", instruction: "Aggiorna i prezzi." }],
        additions: [{ afterHeading: null, heading: "Prezzi 2026", angle: "Confronto costi" }],
      },
      ctx()
    );

    expect(result.html).toContain("<h1>Titolo</h1>");
    expect(prompt).toContain("Vecchio corpo.");
    expect(prompt).toContain("Aggiorna i prezzi.");
    expect(prompt).toContain("Prezzi 2026");
    // The instruction that protects untouched prose must survive into the brief.
    expect(prompt).toContain("WORD FOR WORD");
  });
});
