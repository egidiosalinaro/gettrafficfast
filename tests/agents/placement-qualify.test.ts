import { afterEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import { setLlmProvider } from "@/lib/providers/llm/registry";
import type { LLMProvider, LlmStructuredResult, LlmTextResult } from "@/lib/providers/llm/types";
import { createBudget, type AgentContext } from "@/lib/agents/contract";
import { runAgent } from "@/lib/agents/runner";
import { PlacementQualifyInput, placementQualifyAgent } from "@/lib/agents/placement-qualify";

/**
 * The angle is what the draft is built on. Version 2 asked for "the specific
 * thing they can add" and got briefs to present the product, and every draft
 * built on one read as an advert. What is asserted here is the definition the
 * model is now given, not its taste.
 */

const usage = { model: "stub", inputTokens: 100, outputTokens: 50, costUsd: 0.001 };

function capturing(
  structured: unknown,
  capture: (prompt: string, options?: { tier?: string }) => void
): LLMProvider {
  return {
    name: "stub",
    async generateText(): Promise<LlmTextResult> {
      return { text: "", usage };
    },
    async generateStructured<T>(prompt: string, schema: z.ZodType<T>, options?: { tier?: string }): Promise<LlmStructuredResult<T>> {
      capture(prompt, options);
      return { value: schema.parse(structured), usage, raw: "" };
    },
  };
}

const ctx = (): AgentContext => ({
  userId: "user-1",
  businessId: "biz-1",
  jobId: "job-1",
  language: "en",
  runId: "run-1",
  budget: createBudget(1),
});

afterEach(() => setLlmProvider(null));

describe("placement-qualify prompt", () => {
  it("defines the angle as knowledge a person would say, sensible with the business's name deleted, never a product brief", async () => {
    let prompt = "";
    setLlmProvider(
      capturing(
        { verdicts: [{ index: 0, verdict: "qualified", score: 80, reason: "Their topic.", angle: "The workflow around the pieces is where the time goes.", topic: "SEO tooling", intent: "recommendation" }] },
        (p) => (prompt = p)
      )
    );
    // A description handed over by an old caller is stripped by the schema
    // and never reaches the prompt: every pitch-shaped angle in production
    // was it in other words.
    const input = PlacementQualifyInput.parse({
      business: { name: "GetTrafficFast", niche: "AI SEO", description: "An AI agent that automates the entire content lifecycle.", domain: "https://gettrafficfa.st" },
      expertise: ["seo content"],
      aboutWriter: "",
      tier: "fast",
      language: "en",
      threads: [
        { index: 0, surface: "reddit", kind: "thread", community: "r/SEO", title: "Best AI tools to write SEO content?", excerpt: "Jasper is great.", ageDays: 3, score: 10, commentCount: 4 },
      ],
    });
    expect(input.business).not.toHaveProperty("description");
    const out = await runAgent(placementQualifyAgent, input, ctx());
    expect(out.verdicts[0].angle).toBe("The workflow around the pieces is where the time goes.");
    expect(prompt).toContain("the first sentence the person would type in their reply");
    expect(prompt).toContain("A piece of knowledge, a method, a trade-off, an observation from doing the work");
    expect(prompt).toContain("Two angles in the right shape:");
    expect(prompt).toContain("Never a brief about the product or its kind");
    expect(prompt).toContain("a new category of AI agents automates the entire lifecycle");
    expect(prompt).toContain("a fully automated agent addresses this by centralizing the process");
    expect(prompt).toContain("with the business, its product and its product category deleted");
    expect(prompt).toContain("the angle is null and the thread is rejected");
    expect(prompt).not.toContain("automates the entire content lifecycle.");
    expect(prompt).not.toContain("What they do");
    // The batch judges; unknown age is never by itself a reason.
    expect(prompt).toContain("Reject generously.");
    expect(prompt).toContain("unknown is not old, and unknown age or engagement is never by itself a reason to reject");
    // The pitch's second form: the product's category argued as advice.
    expect(prompt).toContain("The pitch has a second form, the product's category as advice");
    expect(prompt).toContain("true for a person who will never buy any tool");
    expect(prompt).toContain('"look for tools that automate the whole flow" is not');
    expect(prompt).toContain("None of these words: game-changer, seamless, streamline, crucial");
    expect(placementQualifyAgent.version).toBe(11);
  });

  it("in angle mode judges nothing about the thread: the person who clicked already did", async () => {
    let prompt = "";
    setLlmProvider(
      capturing(
        { verdicts: [{ index: 0, verdict: "qualified", score: 50, reason: "ok", angle: "How to choose: the trade-off is the hand-offs.", topic: null, intent: null }] },
        (p) => (prompt = p)
      )
    );
    await runAgent(
      placementQualifyAgent,
      PlacementQualifyInput.parse({
        business: { name: "GetTrafficFast", niche: "AI SEO", domain: null },
        expertise: ["seo content"],
        mode: "angle",
        tier: "quality",
        language: "en",
        threads: [{ index: 0, surface: "reddit", kind: "thread", community: "r/SEO", title: "Best tools for content writing?", excerpt: "", ageDays: null, score: null, commentCount: null }],
      }),
      ctx()
    );
    expect(prompt).toContain("The owner has already decided to answer the discussion below. Do not judge whether it is worth answering");
    expect(prompt).toContain("unknown is not a reason for anything");
    expect(prompt).toContain('return verdict "rejected" with angle null only when nothing but the product itself could be said');
    expect(prompt).not.toContain("Reject generously");
    expect(prompt).not.toContain("Still alive");
    // The angle definition is the same in both modes: one owner of what an angle is.
    expect(prompt).toContain("the first sentence the person would type in their reply");
    expect(PlacementQualifyInput.parse({ business: { name: "X", niche: null, domain: null }, language: "en", threads: [{ index: 0, surface: "reddit", kind: "thread", community: "", title: "t", excerpt: "", ageDays: null, score: null, commentCount: null }] }).mode).toBe("judge");
  });

  it("judges fast by default and on the quality tier when asked", async () => {
    const tiers: Array<string | undefined> = [];
    const verdicts = { verdicts: [{ index: 0, verdict: "rejected", score: 10, reason: "No.", angle: null, topic: null, intent: null }] };
    // The default is the schema's, so a caller that says nothing judges fast.
    const input = PlacementQualifyInput.parse({
      business: { name: "GetTrafficFast", niche: null, domain: null },
      expertise: [],
      language: "en",
      threads: [{ index: 0, surface: "reddit", kind: "thread", community: "r/SEO", title: "A question", excerpt: "", ageDays: null, score: null, commentCount: null }],
    });
    expect(input.tier).toBe("fast");
    setLlmProvider(capturing(verdicts, (_p, options) => tiers.push(options?.tier)));
    await runAgent(placementQualifyAgent, input, ctx());
    setLlmProvider(capturing(verdicts, (_p, options) => tiers.push(options?.tier)));
    await runAgent(placementQualifyAgent, { ...input, tier: "quality" }, ctx());
    expect(tiers).toEqual(["fast", "quality"]);
  });

  it("tells the qualifier who will answer: someone who uses the product, never its maker, plus how they use it", async () => {
    const prompts: string[] = [];
    const input = {
      business: { name: "GetTrafficFast", niche: "AI SEO", domain: "https://gettrafficfa.st" },
      expertise: ["seo content"],
      aboutWriter: "",
      tier: "fast" as const,
      mode: "judge" as const,
      refusedAngles: [] as string[],
      language: "en",
      threads: [
        { index: 0, surface: "reddit", kind: "thread", community: "r/SEO", title: "Best AI tools to write SEO content?", excerpt: "Jasper is great.", ageDays: 3, score: 10, commentCount: 4 },
      ],
    };
    const verdicts = { verdicts: [{ index: 0, verdict: "rejected", score: 20, reason: "Only the product to add.", angle: null, topic: null, intent: "recommendation" }] };

    setLlmProvider(capturing(verdicts, (p) => prompts.push(p)));
    await runAgent(placementQualifyAgent, input, ctx());
    expect(prompts[0]).toContain("Who will answer: someone who uses GetTrafficFast in their own work, never someone who makes it.");
    expect(prompts[0]).toContain("Nothing about them is recorded: the angle may lean on no experience");
    expect(prompts[0]).toContain("When the thread asks which tool to use, the angle is how to choose");
    // A reply names no product, so the angle is never told the reply will.
    expect(prompts[0]).toContain("A reply under the thread names no product and links nothing; it is the answer and nothing else.");
    expect(prompts[0]).toContain("and the reply will not say which one the writer uses either");
    expect(prompts[0]).not.toContain("The reply will name GetTrafficFast once");
    expect(prompts[0]).not.toContain("disclosure");

    setLlmProvider(capturing(verdicts, (p) => prompts.push(p)));
    await runAgent(placementQualifyAgent, { ...input, aboutWriter: "I run my own blog through GetTrafficFast." }, ctx());
    expect(prompts[1]).toContain("What is true about them, in their own words");
    expect(prompts[1]).toContain("I run my own blog through GetTrafficFast.");
    expect(prompts[1]).not.toContain("Nothing about them is recorded");
  });

  it("quotes the angles already refused, in angle mode, so the second ask is not a paraphrase", async () => {
    const prompts: string[] = [];
    const verdicts = { verdicts: [{ index: 0, verdict: "qualified", score: 80, reason: "Their topic.", angle: "How to choose: whether the tool gets a post live without you.", topic: null, intent: null }] };
    const input = PlacementQualifyInput.parse({
      business: { name: "GetTrafficFast", niche: null, domain: null },
      mode: "angle",
      refusedAngles: ["Introduce GetTrafficFast as the agent that automates all of this."],
      language: "en",
      threads: [{ index: 0, surface: "reddit", kind: "thread", community: "r/SEO", title: "Best AI SEO tool?", excerpt: "", ageDays: null, score: null, commentCount: null }],
    });
    setLlmProvider(capturing(verdicts, (p) => prompts.push(p)));
    await runAgent(placementQualifyAgent, input, ctx());
    expect(prompts[0]).toContain('Already refused for this thread, because each describes the product or its kind instead of saying something: "Introduce GetTrafficFast as the agent that automates all of this."');
    expect(prompts[0]).toContain("Do not return these or a paraphrase of them.");
    // Judge mode and a first ask carry no such paragraph.
    setLlmProvider(capturing(verdicts, (p) => prompts.push(p)));
    await runAgent(placementQualifyAgent, { ...input, refusedAngles: [] }, ctx());
    expect(prompts[1]).not.toContain("Already refused");
  });

  it("judges the angle against the writer in angle mode, never the business's topics as a fence (8 November 2026)", async () => {
    // Asked for an angle on a post about turning sketches into watercolors with AI, v10
    // answered "rejected, score 0, outside the business's core expertise".
    const prompts: string[] = [];
    const verdicts = { verdicts: [{ index: 0, verdict: "qualified", score: 70, reason: "A light reply fits.", angle: "Ask whether he scans the sketch before prompting.", topic: null, intent: null }] };
    const input = PlacementQualifyInput.parse({
      business: { name: "GetTrafficFast", niche: "AI SEO content", domain: null },
      expertise: ["answer engine optimization"],
      aboutWriter: "Former agency designer, remote in Taipei.",
      writerNotes: "Short, no hype.",
      mode: "angle",
      language: "en",
      threads: [{ index: 0, surface: "x", kind: "post", community: "@inkwell_ivy", title: "I turn my morning sketches into watercolors with AI.", excerpt: "", ageDays: 0, score: null, commentCount: null }],
    });
    setLlmProvider(capturing(verdicts, (p) => prompts.push(p)));
    await runAgent(placementQualifyAgent, input, ctx());
    expect(prompts[0]).toContain("The business's topics are background, not a fence.");
    expect(prompts[0]).toContain("A discussion outside them is never a reason to reject");
    expect(prompts[0]).toContain("Their own notes on how they write: Short, no hype.");
    expect(prompts[0]).toContain("Former agency designer, remote in Taipei.");
    // Judge mode keeps its test of domain fit, and does not read the notes.
    setLlmProvider(capturing({ verdicts: [] }, (p) => prompts.push(p)));
    await runAgent(placementQualifyAgent, { ...input, mode: "judge" }, ctx());
    expect(prompts[1]).toContain("Domain fit");
    expect(prompts[1]).not.toContain("not a fence");
    expect(prompts[1]).not.toContain("Their own notes on how they write");
  });
});
