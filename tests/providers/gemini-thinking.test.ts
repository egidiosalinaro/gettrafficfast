import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiProvider, LOW_THINKING_BUDGET, thinkingConfigFor } from "@/lib/providers/llm/gemini";

/**
 * `thinking: "low"` reaches the API as generationConfig.thinkingConfig, on
 * the 2.5 series only. SDK 0.24 does not type the field but sends the
 * generationConfig it is given, which is what these tests pin.
 */

const { generateContent, modelParams } = vi.hoisted(() => ({
  generateContent: vi.fn(),
  modelParams: [] as Array<{ model: string; generationConfig?: Record<string, unknown> }>,
}));

vi.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: class {
    getGenerativeModel(params: { model: string; generationConfig?: Record<string, unknown> }) {
      modelParams.push(params);
      return { generateContent };
    }
  },
}));

function answer(text: string) {
  return { response: { text: () => text, usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 } } };
}

describe("Gemini thinking budget", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    generateContent.mockReset();
    modelParams.length = 0;
  });

  it("sends a small thinking budget when the call asks for little thinking, and none otherwise", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ models: [] }), { status: 200 })));
    generateContent.mockResolvedValue(answer("ok"));
    const provider = new GeminiProvider("test-key");

    await provider.generateText("Write.", { tier: "fast", thinking: "low" });
    await provider.generateText("Write.", { tier: "fast", thinking: "default" });
    await provider.generateText("Write.", { tier: "fast" });

    expect(modelParams.map((p) => p.model)).toEqual(["gemini-2.5-flash", "gemini-2.5-flash", "gemini-2.5-flash"]);
    expect(modelParams[0].generationConfig?.thinkingConfig).toEqual({ thinkingBudget: LOW_THINKING_BUDGET });
    expect(modelParams[1].generationConfig).not.toHaveProperty("thinkingConfig");
    expect(modelParams[2].generationConfig).not.toHaveProperty("thinkingConfig");
  });

  it("never sends it to a model that does not take it", () => {
    expect(thinkingConfigFor("gemini-2.5-pro", "low")).toEqual({ thinkingBudget: 512 });
    expect(thinkingConfigFor("gemini-2.5-flash-lite", "low")).toEqual({ thinkingBudget: 512 });
    expect(thinkingConfigFor("gemini-2.0-flash", "low")).toBeUndefined();
    expect(thinkingConfigFor("gemini-3-pro-preview", "low")).toBeUndefined();
    expect(thinkingConfigFor("gemini-2.5-flash", "default")).toBeUndefined();
    expect(thinkingConfigFor("gemini-2.5-flash", undefined)).toBeUndefined();
  });
});
