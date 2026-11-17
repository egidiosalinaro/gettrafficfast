import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnthropicProvider } from "@/lib/providers/llm/anthropic";
import { FallbackProvider } from "@/lib/providers/llm/fallback";
import { GeminiProvider } from "@/lib/providers/llm/gemini";
import { getLlmProvider, setLlmProvider } from "@/lib/providers/llm/registry";

describe("getLlmProvider", () => {
  beforeEach(() => {
    setLlmProvider(null);
    vi.stubEnv("LLM_PROVIDER", "");
    vi.stubEnv("LLM_FALLBACK", "");
    vi.stubEnv("GEMINI_API_KEY", "gemini-test-key");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setLlmProvider(null);
  });

  it("is Gemini alone by default", () => {
    expect(getLlmProvider()).toBeInstanceOf(GeminiProvider);
  });

  it("without a fallback, a missing Gemini key stops the call with its reason", () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    expect(() => getLlmProvider()).toThrow("GEMINI_API_KEY is not set");
  });

  it("with the fallback on, Claude answers even when the Gemini key is not set", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("LLM_FALLBACK", "anthropic");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            model: "claude-sonnet-5-5",
            content: [{ type: "text", text: "from claude" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await getLlmProvider().generateText("Write.", { tier: "quality" });

    expect(result.text).toBe("from claude");
    expect(result.usage.model).toBe("claude-sonnet-5-5");
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://api.anthropic.com/v1/messages");
  });

  it("does not switch the fallback on because a Claude key exists", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    expect(getLlmProvider()).toBeInstanceOf(GeminiProvider);
  });

  it("puts Claude behind Gemini when LLM_FALLBACK names it", () => {
    vi.stubEnv("LLM_FALLBACK", "anthropic");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    const llm = getLlmProvider();
    expect(llm).toBeInstanceOf(FallbackProvider);
    expect(llm.name).toBe("gemini+anthropic");
  });

  it("accepts claude as the provider's name", () => {
    vi.stubEnv("LLM_FALLBACK", " Claude ");
    expect(getLlmProvider().name).toBe("gemini+anthropic");
  });

  it("does not stand a provider behind itself", () => {
    vi.stubEnv("LLM_FALLBACK", "gemini");
    expect(getLlmProvider()).toBeInstanceOf(GeminiProvider);
  });

  it("can run Claude as the primary", () => {
    vi.stubEnv("LLM_PROVIDER", "anthropic");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    expect(getLlmProvider()).toBeInstanceOf(AnthropicProvider);
  });

  it("never lets a misconfigured fallback stop the primary from being built", () => {
    vi.stubEnv("LLM_FALLBACK", "anthropic");
    expect(() => getLlmProvider()).not.toThrow();
    vi.stubEnv("LLM_FALLBACK", "nonsense");
    setLlmProvider(null);
    expect(() => getLlmProvider()).not.toThrow();
  });

  it("names every vendor it can send a customer's content to in the privacy policy", () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    // The policy prints the providers of lib/legal.ts (tests/legal-pages.test.tsx).
    const providers = readFileSync(path.join(root, "lib/legal.ts"), "utf8");
    expect(providers).toContain("Google (Gemini API)");
    expect(providers).toContain("Anthropic (Claude API)");
  });
});
