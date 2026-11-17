import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { candidateModels, isQualityModel as isClaudeQuality } from "@/lib/providers/llm/anthropic";
import { FallbackProvider } from "@/lib/providers/llm/fallback";
import { candidatesFor, isQualityModel } from "@/lib/providers/llm/gemini";
import { getLlmProvider, llmChain, setLlmProvider } from "@/lib/providers/llm/registry";
import { LlmError, type LLMProvider, type LlmOptions, type LlmTextResult } from "@/lib/providers/llm/types";

/**
 * Why the fast model wrote "quality" articles, and what stops it.
 *
 * The audit of 2026-11-10 found most articles written by gemini-2.5-flash
 * while the writer asked for the quality tier. No env var said so: the
 * quality chain is [gemini-2.5-pro, gemini-2.5-flash, …], a refused pro call
 * steps to flash inside the same request, and nothing recorded the step.
 */

const USAGE = { model: "m", inputTokens: 1, outputTokens: 1, costUsd: 0.001 };

describe("the quality chain", () => {
  it("steps from pro to flash by default: this is how flash wrote the articles", () => {
    expect(candidatesFor("quality", [], false).slice(0, 2)).toEqual(["gemini-2.5-pro", "gemini-2.5-flash"]);
  });

  it("stays in the pro family when the tier is strict", () => {
    const strict = candidatesFor("quality", ["gemini-3.1-pro", "gemini-3.6-flash", "gemini-2.0-flash"], true);
    expect(strict).toEqual(["gemini-2.5-pro", "gemini-3.1-pro"]);
    expect(strict.every(isQualityModel)).toBe(true);
    expect(isQualityModel("gemini-2.5-flash")).toBe(false);
  });

  it("leaves the fast tier's chain alone, strict or not", () => {
    expect(candidatesFor("fast", [], true)).toEqual(candidatesFor("fast", [], false));
  });

  it("keeps Claude's strict quality chain off Haiku", () => {
    expect(candidateModels("quality")).toContain("claude-haiku-4-5");
    expect(candidateModels("quality", true)).toEqual(["claude-sonnet-5-5"]);
    expect(isClaudeQuality("claude-haiku-4-5")).toBe(false);
  });
});

function provider(name: string, answer: (options?: LlmOptions) => LlmTextResult) {
  const calls: (LlmOptions | undefined)[] = [];
  const llm: LLMProvider = {
    name,
    async generateText(_prompt, options) {
      calls.push(options);
      return answer(options);
    },
    async generateStructured() {
      throw new Error("not used");
    },
  };
  return { llm, calls };
}

describe("keepTier through the fallback", () => {
  afterEach(() => vi.restoreAllMocks());

  it("turns keepTier into strictTier for both providers, and marks the second provider's answer as a fallback", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = provider("gemini", (options) => {
      // What a strict Gemini does when pro is refused: fail, not step to flash.
      if (options?.strictTier) throw new LlmError("Gemini request failed: [429] quota", "gemini");
      return { text: "from flash", usage: { ...USAGE, model: "gemini-2.5-flash", tierDowngraded: true } };
    });
    const second = provider("anthropic", () => ({
      text: "from sonnet",
      usage: { ...USAGE, model: "claude-sonnet-5-5", provider: "anthropic", fallback: false },
    }));
    const llm = new FallbackProvider(
      { name: "gemini", build: () => first.llm },
      { name: "anthropic", build: () => second.llm }
    );

    const result = await llm.generateText("Write.", { tier: "quality", keepTier: true });

    expect(result.text).toBe("from sonnet");
    expect(result.usage).toMatchObject({ model: "claude-sonnet-5-5", provider: "anthropic", fallback: true });
    expect(first.calls[0]).toMatchObject({ strictTier: true });
    expect(second.calls[0]).toMatchObject({ strictTier: true });
  });

  it("does not make a request strict that did not ask to keep its tier", async () => {
    const first = provider("gemini", () => ({ text: "ok", usage: USAGE }));
    const llm = new FallbackProvider(
      { name: "gemini", build: () => first.llm },
      { name: "anthropic", build: () => first.llm }
    );
    const result = await llm.generateText("Extract.", { tier: "fast" });
    expect(first.calls[0]?.strictTier).toBeUndefined();
    expect(result.usage.fallback).toBeUndefined();
  });
});

describe("a role's own provider", () => {
  beforeEach(() => {
    setLlmProvider(null);
    vi.stubEnv("LLM_PROVIDER", "");
    vi.stubEnv("LLM_FALLBACK", "");
    vi.stubEnv("LLM_WRITER_PROVIDER", "");
    vi.stubEnv("GEMINI_API_KEY", "gemini-test-key");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setLlmProvider(null);
  });

  it("is the default chain when the role has no override", () => {
    expect(llmChain("writer")).toEqual(["gemini"]);
    vi.stubEnv("LLM_FALLBACK", "anthropic");
    expect(llmChain("writer")).toEqual(["gemini", "anthropic"]);
    expect(getLlmProvider("writer")).toBe(getLlmProvider());
  });

  it("puts the writer on its own provider first, with the default behind it, and leaves the others alone", () => {
    vi.stubEnv("LLM_WRITER_PROVIDER", "anthropic");
    expect(llmChain("writer")).toEqual(["anthropic", "gemini"]);
    expect(llmChain()).toEqual(["gemini"]);
    expect(getLlmProvider("writer").name).toBe("anthropic+gemini");
    expect(getLlmProvider().name).toBe("gemini");
  });

  it("accepts claude as a name, and ignores an override equal to the primary", () => {
    vi.stubEnv("LLM_WRITER_PROVIDER", "Claude");
    expect(llmChain("writer")).toEqual(["anthropic", "gemini"]);
    vi.stubEnv("LLM_WRITER_PROVIDER", "gemini");
    vi.stubEnv("LLM_FALLBACK", "anthropic");
    expect(llmChain("writer")).toEqual(["gemini", "anthropic"]);
  });

  it("sends the writer's quality request to Claude's quality model first", async () => {
    vi.stubEnv("LLM_WRITER_PROVIDER", "anthropic");
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            model: "claude-sonnet-5-5",
            content: [{ type: "text", text: "the article" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await getLlmProvider("writer").generateText("Write.", { tier: "quality", keepTier: true });

    expect(String(fetchMock.mock.calls[0][0])).toBe("https://api.anthropic.com/v1/messages");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).model).toBe("claude-sonnet-5-5");
    expect(result.usage).toMatchObject({
      model: "claude-sonnet-5-5",
      provider: "anthropic",
      fallback: false,
      tierDowngraded: false,
    });
  });

  it("a stub set by a test answers for every role", () => {
    const stub = provider("stub", () => ({ text: "", usage: USAGE })).llm;
    setLlmProvider(stub);
    vi.stubEnv("LLM_WRITER_PROVIDER", "anthropic");
    expect(getLlmProvider("writer")).toBe(stub);
  });
});
