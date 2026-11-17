import { afterEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import { AgentBudgetExceeded, createBudget, type AgentContext } from "@/lib/agents/contract";
import { DraftCorrectInput, buildDraftCorrectPrompt, draftCorrectAgent } from "@/lib/agents/draft-correct";
import { runAgent } from "@/lib/agents/runner";
import { xLength } from "@/lib/placements/audit";
import { setLlmProvider } from "@/lib/providers/llm/registry";
import type { LLMProvider, LlmOptions, LlmStructuredResult, LlmTextResult } from "@/lib/providers/llm/types";

/**
 * The correction agent: what the model is told (the owner's note first, the
 * gate's rules as the floor), and what comes back (one structured call with
 * little thinking, the X reply fitted, claim bases settled by code).
 */

const base = {
  business: { name: "GetTrafficFast", site: "https://gettrafficfa.st" },
  thread: {
    surface: "x",
    kind: "post",
    title: "Is it naive to blog for SEO in 2026?",
    excerpt: "Everyone says AI answers killed blog traffic.",
  },
  variant: "short_comment" as const,
  draft: "It's not naive. Blogging still works if you answer real questions.",
  reason: "too generic, use one of my real numbers",
  aboutYou: "I get 200+ impressions a day on my blog and still zero clicks.",
  notes: "Never start with It's.",
};

const usage = (costUsd = 0.002) => ({ model: "stub", inputTokens: 400, outputTokens: 80, costUsd });

function stub(value: unknown, seen: Array<{ prompt: string; options?: LlmOptions }>, costUsd?: number): LLMProvider {
  return {
    name: "stub",
    async generateText(): Promise<LlmTextResult> {
      throw new Error("not used");
    },
    async generateStructured<T>(prompt: string, schema: z.ZodType<T>, options?: LlmOptions): Promise<LlmStructuredResult<T>> {
      seen.push({ prompt, options });
      return { value: schema.parse(value), usage: usage(costUsd), raw: "" };
    },
  };
}

const ctx = (maxUsd = 0.05): AgentContext => ({
  userId: "user-1",
  businessId: "biz-1",
  language: "en",
  runId: "run-1",
  budget: createBudget(maxUsd),
});

afterEach(() => setLlmProvider(null));

describe("draft-correct prompt", () => {
  it("puts the owner's note first, with the draft, the thread, About you and the notes as rules", () => {
    const prompt = buildDraftCorrectPrompt(DraftCorrectInput.parse(base));
    const label = "The owner's correction, written to you, the writer, not to the poster. It may be in any language. Obey it first.";
    expect(prompt).toContain(label);
    expect(prompt.indexOf(label)).toBeLessThan(prompt.indexOf("The current draft"));
    expect(prompt).toContain(base.reason);
    expect(prompt).toContain(base.draft);
    expect(prompt).toContain(base.thread.title);
    expect(prompt).toContain(`About the writer, the only experience the text may claim: ${base.aboutYou}`);
    expect(prompt).toContain("The writer's own notes, hard rules:");
    expect(prompt).toContain(base.notes);
    expect(prompt).toContain("Every one of the writer's notes holds.");
  });

  it("keeps a reply free of the product and of links, and an X reply under 280 characters", () => {
    const prompt = buildDraftCorrectPrompt(DraftCorrectInput.parse(base));
    expect(prompt).toContain("Name no product and put no link, URL or domain anywhere: not GetTrafficFast");
    expect(prompt).toContain("at most 280 characters, spaces included");
    expect(prompt).toContain("Invent nothing.");
    expect(prompt).toContain("Two at most, often none.");
  });

  it("claims no experience when nothing is recorded about the writer", () => {
    const prompt = buildDraftCorrectPrompt(DraftCorrectInput.parse({ ...base, aboutYou: "", notes: "" }));
    expect(prompt).toContain("nothing is recorded, so claim none");
    expect(prompt).not.toContain("hard rules:");
  });

  it("keeps the article's one clause and link instead of stripping them, and drops the X limit elsewhere", () => {
    const prompt = buildDraftCorrectPrompt(
      DraftCorrectInput.parse({ ...base, variant: "article_draft", thread: { ...base.thread, surface: "linkedin" } })
    );
    expect(prompt).toContain("keep the one clause that names GetTrafficFast with its one link to https://gettrafficfa.st");
    expect(prompt).not.toContain("Name no product and put no link");
    expect(prompt).not.toContain("280 characters");
  });

  it("refuses a note shorter than 3 or longer than 300 characters at the boundary", () => {
    expect(DraftCorrectInput.safeParse({ ...base, reason: "no" }).success).toBe(false);
    expect(DraftCorrectInput.safeParse({ ...base, reason: "x".repeat(301) }).success).toBe(false);
    expect(DraftCorrectInput.safeParse({ ...base, reason: "x".repeat(300) }).success).toBe(true);
  });
});

describe("draft-correct run", () => {
  it("makes one structured call on the quality tier with little thinking", async () => {
    const seen: Array<{ prompt: string; options?: LlmOptions }> = [];
    setLlmProvider(stub({ body: "Not naive. 200+ impressions a day here, zero clicks.", claims: [] }, seen));
    const output = await runAgent(draftCorrectAgent, DraftCorrectInput.parse(base), ctx());
    expect(seen).toHaveLength(1);
    expect(seen[0].options).toMatchObject({ tier: "quality", thinking: "low" });
    expect(output.body).toBe("Not naive. 200+ impressions a day here, zero clicks.");
  });

  it("fits an X reply into the post and settles unknown claim bases as unverified", async () => {
    const seen: Array<{ prompt: string; options?: LlmOptions }> = [];
    const long = `${"Answer the question people actually type, then stop. ".repeat(8)}Short pages win.`;
    setLlmProvider(
      stub(
        {
          body: long,
          claims: [
            { text: "200+ impressions a day", basis: "business_profile" },
            { text: "most blogs fail", basis: "vibes" },
          ],
        },
        seen
      )
    );
    const output = await runAgent(draftCorrectAgent, DraftCorrectInput.parse(base), ctx());
    expect(xLength(output.body)).toBeLessThanOrEqual(280);
    expect(output.claims).toEqual([
      { text: "200+ impressions a day", basis: "business_profile" },
      { text: "most blogs fail", basis: "unverified" },
    ]);
  });

  it("stops at the $0.05 budget: a call that cost more is refused", async () => {
    const seen: Array<{ prompt: string; options?: LlmOptions }> = [];
    setLlmProvider(stub({ body: "Not naive.", claims: [] }, seen, 0.06));
    await expect(runAgent(draftCorrectAgent, DraftCorrectInput.parse(base), ctx(0.05))).rejects.toBeInstanceOf(AgentBudgetExceeded);
    expect(seen).toHaveLength(1);
  });
});
