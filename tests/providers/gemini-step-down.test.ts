import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GeminiProvider } from "@/lib/providers/llm/gemini";
import { LlmError } from "@/lib/providers/llm/types";

/**
 * The call that wrote production's articles on the fast model: the quality
 * tier asks for pro, pro is refused in milliseconds, and flash answers inside
 * the same request. (Flash drafts took 12 to 36 seconds end to end, under the
 * 40-second call limit, so pro was refused, not timed out.) The step is now
 * logged and recorded on the usage, and a strict call does not take it.
 */

const { generateContent, models } = vi.hoisted(() => ({ generateContent: vi.fn(), models: [] as string[] }));

vi.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: class {
    getGenerativeModel({ model }: { model: string }) {
      models.push(model);
      return { generateContent: () => generateContent(model) };
    }
  },
}));

const answer = (text: string) => ({
  response: { text: () => text, usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 } },
});

describe("Gemini stepping down its chain", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    models.length = 0;
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ models: [] }), { status: 200 })));
    generateContent.mockImplementation(async (model: string) => {
      if (model.includes("pro")) throw new Error("[429 Too Many Requests] quota exceeded for gemini-2.5-pro");
      return answer("written by flash");
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    generateContent.mockReset();
  });

  it("says so on the usage and in the log when flash answers a quality request", async () => {
    const result = await new GeminiProvider("test-key").generateText("Write.", { tier: "quality" });

    expect(models).toEqual(["gemini-2.5-pro", "gemini-2.5-flash"]);
    expect(result.usage).toMatchObject({
      model: "gemini-2.5-flash",
      provider: "gemini",
      fallback: true,
      tierDowngraded: true,
    });
    const logged = JSON.parse(String(warn.mock.calls[0][0]));
    expect(logged).toMatchObject({ event: "llm.model_step_down", model: "gemini-2.5-pro", tier: "quality" });
    expect(logged.error).toContain("429");
  });

  it("fails instead of stepping to flash when the tier is strict, so the next provider can take it", async () => {
    const error = await new GeminiProvider("test-key")
      .generateText("Write.", { tier: "quality", strictTier: true })
      .catch((err) => err);

    expect(error).toBeInstanceOf(LlmError);
    expect(models).toEqual(["gemini-2.5-pro"]);
  });

  it("reports no fallback when the configured model answers", async () => {
    const result = await new GeminiProvider("test-key").generateText("Extract.", { tier: "fast" });
    expect(result.usage).toMatchObject({ model: "gemini-2.5-flash", fallback: false, tierDowngraded: false });
  });
});
