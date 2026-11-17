import { afterEach, describe, expect, it } from "vitest";
import { createBudget, type AgentContext } from "@/lib/agents/contract";
import { DraftCorrectInput, buildDraftCorrectPrompt, draftCorrectAgent } from "@/lib/agents/draft-correct";
import { PlacementDraftInput, buildPlacementDraftPrompt, placementDraftAgent } from "@/lib/agents/placement-draft";
import { runAgent } from "@/lib/agents/runner";
import { READ_THE_POST } from "@/lib/placements/reading";
import { setLlmProvider } from "@/lib/providers/llm/registry";
import type { LLMProvider, LlmStructuredResult, LlmTextResult } from "@/lib/providers/llm/types";
import type { z } from "zod";

/**
 * Reading the post before writing (drafter version 20), and the owner's
 * correction as an instruction, never content (correction version 3).
 *
 * The case, in production on 10 November 2026: an ironic post read as a
 * complaint, the owner's note saying so in Italian, and a rewrite that
 * answered the note. Pinned: what both prompts say about it, that the
 * reading comes back from the same call, and that a garbled one is null.
 */

/** The post, by @DanaShips on X, word for word. */
const POST =
  "Every time one of my LinkedIn posts gets traction, some 50+ year old CEO turns up to call me a scammer. For sharing my own revenue. Is this the price of posting???";
/** The owner's note, word for word. */
const NOTE = "Quello non è uno struggle of getting traction è un post ironico sta prendendo in giro i ceo boomer over 50";
/** The first draft, as far as the report kept it. */
const FIRST_DRAFT = "it's frustrating when that happens, especially after putting your own numbers out there. i'm still trying to get my blog";

const ABOUT = "Since late September an AI pipeline writes and publishes my own blog: articles sit around position 30-40.";

const draftInput = (over: Record<string, unknown> = {}) =>
  PlacementDraftInput.parse({
    business: { name: "GetTrafficFast", domain: "https://gettrafficfa.st", niche: "AI SEO content" },
    thread: { surface: "x", kind: "post", community: "@DanaShips", title: POST.slice(0, 80), excerpt: POST, author: "DanaShips" },
    angle: null,
    chosenByPerson: true,
    voice: { preset: "warm", person: "auto", aboutYou: ABOUT, instructions: "Lowercase, short lines." },
    language: "en",
    variants: ["short_comment"],
    ...over,
  });

const correctInput = (over: Record<string, unknown> = {}) =>
  DraftCorrectInput.parse({
    business: { name: "GetTrafficFast", site: "https://gettrafficfa.st", niche: "AI SEO content" },
    thread: { surface: "x", kind: "post", title: POST.slice(0, 80), excerpt: POST },
    variant: "short_comment",
    draft: FIRST_DRAFT,
    reason: NOTE,
    aboutYou: ABOUT,
    notes: "Lowercase, short lines.",
    ...over,
  });

function stub(value: unknown): LLMProvider {
  return {
    name: "stub",
    async generateText(): Promise<LlmTextResult> {
      throw new Error("not used");
    },
    async generateStructured<T>(_prompt: string, schema: z.ZodType<T>): Promise<LlmStructuredResult<T>> {
      return { value: schema.parse(value), usage: { model: "stub", inputTokens: 100, outputTokens: 50, costUsd: 0.001 }, raw: "" };
    },
  };
}

const ctx = (): AgentContext => ({ userId: "user-1", businessId: "biz-1", language: "en", runId: "run-1", budget: createBudget(0.5) });

afterEach(() => setLlmProvider(null));

describe("placement-draft, version 20: the post is read before the reply is written", () => {
  it("is version 20", () => {
    expect(placementDraftAgent.version).toBeGreaterThanOrEqual(20);
  });

  it("asks for the tone and what the poster means, and for a reply that fits it", () => {
    const prompt = buildPlacementDraftPrompt(draftInput());
    expect(prompt).toContain(READ_THE_POST);
    expect(prompt).toContain('Decide its tone: "sincere" (they mean it as written), "ironic" (they mean the opposite, or are mocking someone), "joke", "rant" (venting, not asking) or "question"');
    expect(prompt).toContain(
      "An ironic post or a joke gets a reply that plays along or adds a sharper example of the same thing, never sympathy for a problem the poster does not have and never advice they did not ask for."
    );
    // After the post, before the rules on how to write.
    expect(prompt.indexOf("The discussion (")).toBeLessThan(prompt.indexOf("Read the post before you write."));
    expect(prompt.indexOf("Read the post before you write.")).toBeLessThan(prompt.indexOf("Rules, in order of importance:"));
    expect(prompt.split("Read the post before you write.")).toHaveLength(2);
  });

  it("asks for the reading first in the answer, in the same call", () => {
    const prompt = buildPlacementDraftPrompt(draftInput());
    expect(prompt).toContain(
      'Return JSON, with "reading" first, before any variant: { "reading": { "tone": "sincere" | "ironic" | "joke" | "rant" | "question", "means": one line, what the poster actually means }, "variants": ['
    );
  });

  it("returns the reading with the variants, and null when the model gave none or garbled it", async () => {
    const variants = [{ variant: "short_comment", body: "the 50+ ceo is a rite of passage. did he ask to connect after?", linkUrl: null, claims: [] }];
    setLlmProvider(stub({ reading: { tone: "Ironic", means: "He is mocking the CEOs who call him a scammer." }, variants }));
    expect((await runAgent(placementDraftAgent, draftInput(), ctx())).reading).toEqual({
      tone: "ironic",
      means: "He is mocking the CEOs who call him a scammer.",
    });
    setLlmProvider(stub({ variants }));
    expect((await runAgent(placementDraftAgent, draftInput(), ctx())).reading).toBeNull();
    setLlmProvider(stub({ reading: { tone: "kind of sad", means: "?" }, variants }));
    expect((await runAgent(placementDraftAgent, draftInput(), ctx())).reading).toBeNull();
  });
});

describe("draft-correct, version 3: the correction is an instruction, never content", () => {
  it("is version 3", () => {
    expect(draftCorrectAgent.version).toBeGreaterThanOrEqual(3);
  });

  it("puts the note in its own block, addressed to the writer, in any language", () => {
    const prompt = buildDraftCorrectPrompt(correctInput());
    expect(prompt).toContain(
      `The owner's correction, written to you, the writer, not to the poster. It may be in any language. Obey it first. It overrules the draft's reading of the post: where the two disagree, the draft was wrong.\n"""\n${NOTE}\n"""`
    );
    expect(prompt).not.toContain("The owner's note on this draft.");
  });

  it("says the correction is never quoted, answered or mentioned", () => {
    const prompt = buildDraftCorrectPrompt(correctInput());
    expect(prompt).toContain(
      `The correction is not part of the conversation. Never quote it, never answer it, never agree or disagree with it, never mention that a note or a reading exists: no "that's how I read it too", no "as you said", no "you're right". The reply speaks to the poster, about the post, and to nobody else.`
    );
  });

  it("says the words the correction rules out do not come back", () => {
    const prompt = buildDraftCorrectPrompt(correctInput());
    expect(prompt).toContain(
      `Words the correction says are wrong do not come back. If it says the post is "not X", neither X nor a paraphrase of X appears in the reply, not even to deny it.`
    );
  });

  it("takes the correction's reading of the post as the reading", () => {
    const prompt = buildDraftCorrectPrompt(correctInput());
    expect(prompt).toContain("If the correction says how the post is meant (ironic, a joke, mocking someone), that is how it is meant");
    expect(prompt).toContain("with no sympathy and no advice for a problem the poster does not have");
  });

  it("keeps the reply in the draft's language whatever the note's", () => {
    const prompt = buildDraftCorrectPrompt(correctInput());
    expect(prompt).toContain("Write in the language of the draft, which is the post's, whatever language the correction is written in.");
  });

  it("shows the stored reading as the earlier one, which the correction may overrule", () => {
    const reading = { tone: "sincere" as const, means: "He is frustrated that sharing numbers gets him called a scammer." };
    const prompt = buildDraftCorrectPrompt(correctInput({ reading }));
    expect(prompt).toContain(
      "How the post was read when that draft was written (sincere: He is frustrated that sharing numbers gets him called a scammer.). If the correction reads the post differently, this reading was the mistake."
    );
    expect(buildDraftCorrectPrompt(correctInput())).not.toContain("How the post was read when that draft was written");
    expect(correctInput().reading).toBeNull();
  });

  it("asks for the reading the correction leaves standing, first, and returns it", async () => {
    expect(buildDraftCorrectPrompt(correctInput())).toContain(
      'Return JSON, with "reading" first: { "reading": { "tone": "sincere" | "ironic" | "joke" | "rant" | "question", "means": one line, what the poster actually means, as the correction has it where it says }, "body": "...", "claims": ['
    );
    const body = "the 50+ ceo calling you a scammer is basically a rite of passage on linkedin. did he ask to connect after?";
    setLlmProvider(stub({ reading: { tone: "ironic", means: "He is making fun of the CEOs." }, body, claims: [] }));
    expect(await runAgent(draftCorrectAgent, correctInput(), ctx())).toMatchObject({ body, reading: { tone: "ironic", means: "He is making fun of the CEOs." } });
    setLlmProvider(stub({ body, claims: [] }));
    expect((await runAgent(draftCorrectAgent, correctInput(), ctx())).reading).toBeNull();
  });
});
