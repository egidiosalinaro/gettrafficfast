import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiProvider } from "@/lib/providers/llm/gemini";

const { generateContent } = vi.hoisted(() => ({ generateContent: vi.fn() }));

vi.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: class {
    getGenerativeModel() {
      return { generateContent };
    }
  },
}));

function answer(text: string) {
  return {
    response: {
      text: () => text,
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 },
    },
  };
}

describe("Gemini calls that do not return", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    generateContent.mockReset();
  });

  it("tries the next model when one does not answer, instead of holding the call open", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ models: [] }), { status: 200 }))
    );
    let calls = 0;
    generateContent.mockImplementation((_prompt: string, options: { signal: AbortSignal }) => {
      calls += 1;
      if (calls === 1) {
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      }
      return Promise.resolve(answer("from the next model"));
    });

    const pending = new GeminiProvider("test-key").generateText("Write.", { tier: "fast" });
    const assertion = pending.then((result) => result.text);
    await vi.advanceTimersByTimeAsync(40_000);

    expect(await assertion).toBe("from the next model");
    expect(generateContent).toHaveBeenCalledTimes(2);
  });

  it("does not start a generation the caller already aborted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ models: [] }), { status: 200 }))
    );
    const caller = new AbortController();
    caller.abort();
    const error = await new GeminiProvider("test-key")
      .generateText("Write.", { signal: caller.signal })
      .catch((err) => err);

    expect(error).toMatchObject({ name: "AbortError" });
    expect(generateContent).not.toHaveBeenCalled();
  });

  it("does not try another model when the caller aborts during the generation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ models: [] }), { status: 200 }))
    );
    let calls = 0;
    generateContent.mockImplementation((_prompt: string, options: { signal: AbortSignal }) => {
      calls += 1;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    });
    const caller = new AbortController();
    const pending = new GeminiProvider("test-key").generateText("Write.", { signal: caller.signal, tier: "fast" });
    await vi.waitFor(() => expect(calls).toBe(1));
    caller.abort();

    const error = await pending.catch((err) => err);
    expect(error).toMatchObject({ name: "AbortError" });
    expect(calls).toBe(1);
  });

  it("does not let a hung model catalogue block the draft", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          })
      )
    );
    generateContent.mockResolvedValue(answer("from the static chain"));

    const pending = new GeminiProvider("test-key").generateText("Write.", { tier: "fast" });
    const assertion = pending.then((result) => result.text);
    await vi.advanceTimersByTimeAsync(8_000);

    expect(await assertion).toBe("from the static chain");
    expect(generateContent).toHaveBeenCalledTimes(1);
  });
});
