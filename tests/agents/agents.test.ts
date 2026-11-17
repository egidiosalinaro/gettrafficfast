import { afterEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import { setLlmProvider } from "@/lib/providers/llm/registry";
import type { LLMProvider, LlmStructuredResult, LlmTextResult } from "@/lib/providers/llm/types";
import { createBudget, AgentContext } from "@/lib/agents/contract";
import { runAgent } from "@/lib/agents/runner";
import { outlineAgent } from "@/lib/agents/outline";
import { writingAgent } from "@/lib/agents/writing";
import { aeoAgent } from "@/lib/agents/aeo";

/**
 * Agents are exercised against a stub provider: no network, but the real
 * schemas, the real prompts and the real runner. What is asserted is the
 * contract — that an agent's boundary holds — not the model's taste.
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
      // The real provider validates before returning; so does the stub.
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

const OUTLINE = {
  title: "Come automatizzare i codici sconto",
  angle: "Guida operativa per e-commerce",
  intro: "Apri spiegando il problema dei codici generici.",
  sections: [
    {
      heading: "Perché i codici generici non funzionano",
      question: "Perché i codici generici non funzionano?",
      answer: "Perché finiscono sui siti di coupon e erodono il margine.",
      points: ["Leakage", "Margine"],
      subsections: [],
    },
    {
      heading: "Come funzionano i codici unici",
      question: "Come funzionano i codici unici?",
      answer: "Ogni destinatario riceve un codice monouso generato all'invio.",
      points: ["Generazione", "Scadenza"],
      subsections: ["Integrazione Shopify"],
    },
    {
      heading: "Da dove iniziare",
      question: "Da dove si inizia?",
      answer: "Da un solo flusso, misurando il riscatto.",
      points: ["Carrello abbandonato"],
      subsections: [],
    },
  ],
  faq: [{ question: "Scadono?", answer: "Sì, la finestra è configurabile." }],
  entities: ["codici sconto", "carrello abbandonato"],
};

afterEach(() => setLlmProvider(null));

describe("outline agent", () => {
  it("returns a validated plan and passes the business context to the model", async () => {
    let prompt = "";
    setLlmProvider(stubProvider({ structured: OUTLINE, capture: (p) => (prompt = p) }));

    const result = await runAgent(
      outlineAgent,
      {
        keyword: "codici sconto automatici",
        language: "Italian",
        businessName: "Postwren",
        businessNiche: "Email marketing",
      },
      ctx()
    );

    expect(result.title).toBe(OUTLINE.title);
    expect(result.sections).toHaveLength(3);
    expect(prompt).toContain("codici sconto automatici");
    expect(prompt).toContain("Postwren");
    expect(prompt).toContain("Italian");
  });

  it("truncates over-count arrays instead of failing the run", async () => {
    // GETTRAFFICFAST-3: a 16th entity dead-lettered a job. Maximums are code's
    // job; the model only has to meet minimums.
    setLlmProvider(
      stubProvider({
        structured: {
          ...OUTLINE,
          entities: Array.from({ length: 22 }, (_, i) => `entità ${i}`),
          faq: Array.from({ length: 9 }, (_, i) => ({
            question: `Domanda ${i}?`,
            answer: `Risposta ${i}.`,
          })),
        },
      })
    );
    const result = await runAgent(
      outlineAgent,
      { keyword: "k", language: "Italian" },
      ctx()
    );
    expect(result.entities).toHaveLength(15);
    expect(result.faq).toHaveLength(5);
  });

  it("rejects a plan with too few sections", async () => {
    setLlmProvider(
      stubProvider({ structured: { ...OUTLINE, sections: OUTLINE.sections.slice(0, 1) } })
    );
    await expect(
      runAgent(outlineAgent, { keyword: "k", language: "Italian" }, ctx())
    ).rejects.toThrow();
  });
});

describe("writing agent", () => {
  it("builds a prompt from the outline and returns the raw document", async () => {
    let prompt = "";
    setLlmProvider(
      stubProvider({
        text: "<h1>Titolo</h1><p>Corpo.</p>",
        capture: (p) => (prompt = p),
      })
    );

    const result = await runAgent(
      writingAgent,
      { keyword: "codici sconto automatici", language: "Italian", outline: OUTLINE },
      ctx()
    );

    expect(result.html).toContain("<h1>Titolo</h1>");
    // Every section, its question and its opening answer must reach the writer.
    // A heading that is not a question goes to the writer as the question
    // it answers (2026-11-15: most headings are the questions people ask).
    for (const section of OUTLINE.sections) {
      expect(prompt).toContain(section.heading.endsWith("?") ? section.heading : section.question);
      expect(prompt).toContain(section.answer);
    }
    expect(prompt).toContain("H2: Da dove si inizia?");
    // The AEO rule the outline encodes must survive into the writing brief.
    expect(prompt).toContain("stand on its own");
  });
});

describe("aeo audit agent", () => {
  const AUDIT = {
    score: 78,
    metaTitle: "Codici sconto automatici: la guida",
    metaDescription: "Come generare codici unici per ogni cliente e misurare il riscatto.",
    findings: [
      { area: "chunking", severity: "warning", message: "La sezione 3 rimanda alla precedente." },
    ],
    suggestedFaq: [],
    entities: ["codici sconto"],
  };

  it("returns a score, metadata and findings", async () => {
    setLlmProvider(stubProvider({ structured: AUDIT }));

    const result = await runAgent(
      aeoAgent,
      {
        keyword: "codici sconto automatici",
        language: "Italian",
        title: "Titolo",
        headings: [{ level: 2, text: "Sezione" }],
        bodyText: "Testo dell'articolo.",
      },
      ctx()
    );

    expect(result.score).toBe(78);
    expect(result.metaDescription.length).toBeLessThanOrEqual(160);
    expect(result.findings[0].area).toBe("chunking");
  });

  it("clamps metadata that would not fit a SERP instead of failing the run", async () => {
    // Models cannot count characters; asking them to dead-lettered a real
    // production job. Overlong metadata is clamped deterministically.
    setLlmProvider(
      stubProvider({
        structured: {
          ...AUDIT,
          metaTitle: "parola ".repeat(30).trim(),
          metaDescription: "frase lunga ".repeat(40).trim(),
        },
      })
    );
    const result = await runAgent(
      aeoAgent,
      {
        keyword: "k",
        language: "Italian",
        title: "T",
        headings: [],
        bodyText: "testo",
      },
      ctx()
    );
    expect(result.metaTitle.length).toBeLessThanOrEqual(70);
    expect(result.metaTitle.endsWith("…")).toBe(true);
    expect(result.metaDescription.length).toBeLessThanOrEqual(160);
  });
});
