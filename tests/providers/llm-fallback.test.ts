import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { FallbackProvider } from "@/lib/providers/llm/fallback";
import {
  LlmError,
  type LLMProvider,
  type LlmOptions,
  type LlmStructuredResult,
  type LlmTextResult,
} from "@/lib/providers/llm/types";

const USAGE = { model: "m", inputTokens: 1, outputTokens: 1, costUsd: 0.001 };

function provider(name: string, behaviour: { text?: string; error?: unknown }) {
  const calls: { prompt: string; options?: LlmOptions }[] = [];
  const llm: LLMProvider = {
    name,
    async generateText(prompt, options): Promise<LlmTextResult> {
      calls.push({ prompt, options });
      if (behaviour.error) throw behaviour.error;
      return { text: behaviour.text ?? "", usage: { ...USAGE, model: `${name}-model` } };
    },
    async generateStructured<T>(prompt: string, schema: z.ZodType<T>, options?: LlmOptions): Promise<LlmStructuredResult<T>> {
      calls.push({ prompt, options });
      if (behaviour.error) throw behaviour.error;
      const value = schema.parse(JSON.parse(behaviour.text ?? "null"));
      return { value, usage: { ...USAGE, model: `${name}-model` }, raw: behaviour.text ?? "" };
    },
  };
  return { llm, calls };
}

function gemini(behaviour: { text?: string; error?: unknown }) {
  return { name: "gemini", build: () => provider("gemini", behaviour).llm };
}

function claude(build: () => LLMProvider) {
  return { name: "anthropic", build };
}

const DEPLETED = new LlmError(
  "Gemini credits are depleted. Generation stays paused until billing is topped up.",
  "gemini",
  undefined,
  { retryable: false, report: false }
);

describe("FallbackProvider", () => {
  afterEach(() => vi.restoreAllMocks());

  it("never builds the fallback while the primary answers", async () => {
    const build = vi.fn(() => provider("anthropic", { text: "from claude" }).llm);
    const llm = new FallbackProvider(gemini({ text: "from gemini" }), claude(build));

    expect((await llm.generateText("Write.")).text).toBe("from gemini");
    expect(build).not.toHaveBeenCalled();
    expect(llm.name).toBe("gemini+anthropic");
  });

  it("answers from the fallback when the primary cannot pay, with the same request", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fallback = provider("anthropic", { text: "from claude" });
    const build = vi.fn(() => fallback.llm);
    const llm = new FallbackProvider(gemini({ error: DEPLETED }), claude(build));
    const options: LlmOptions = { tier: "quality", temperature: 0.7 };

    const first = await llm.generateText("Write the article.", options);
    const second = await llm.generateText("Write another.", options);

    expect(first.text).toBe("from claude");
    expect(first.usage.model).toBe("anthropic-model");
    expect(second.text).toBe("from claude");
    expect(fallback.calls[0]).toEqual({ prompt: "Write the article.", options });
    expect(build).toHaveBeenCalledTimes(1);
  });

  it("falls back on any failure, a plain error included, and for structures too", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const llm = new FallbackProvider(
      gemini({ error: new TypeError("fetch failed") }),
      claude(() => provider("anthropic", { text: '{"ok":true}' }).llm)
    );

    const result = await llm.generateStructured("Judge.", z.object({ ok: z.boolean() }), { tier: "fast" });
    expect(result.value).toEqual({ ok: true });
  });

  it("falls back when the primary cannot even be built, its key not being set", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const llm = new FallbackProvider(
      {
        name: "gemini",
        build: () => {
          throw new LlmError("GEMINI_API_KEY is not set", "gemini", undefined, { retryable: false });
        },
      },
      claude(() => provider("anthropic", { text: "from claude" }).llm)
    );

    expect((await llm.generateText("Write.")).text).toBe("from claude");
    expect(JSON.parse(String(warn.mock.calls[0][0]))).toMatchObject({
      primary: "gemini",
      error: "GEMINI_API_KEY is not set",
    });
  });

  it("logs the switch without the prompt", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const llm = new FallbackProvider(
      gemini({ error: DEPLETED }),
      claude(() => provider("anthropic", { text: "ok" }).llm)
    );

    await llm.generateText("A secret customer brief.");

    const line = JSON.parse(String(warn.mock.calls[0][0]));
    expect(line).toMatchObject({ event: "llm.fallback", primary: "gemini", fallback: "anthropic" });
    expect(String(warn.mock.calls[0][0])).not.toContain("secret customer brief");
  });

  it("when both fail, says both, and stays retryable if one side can still succeed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const overloaded = new LlmError("Claude request failed: [529 overloaded_error] Overloaded", "anthropic");
    const llm = new FallbackProvider(
      gemini({ error: DEPLETED }),
      claude(() => provider("anthropic", { error: overloaded }).llm)
    );

    const error = await llm.generateText("Write.").catch((e) => e);

    expect(error).toBeInstanceOf(LlmError);
    expect(error.message).toBe(
      "Gemini credits are depleted. Generation stays paused until billing is topped up. The fallback failed too: Claude request failed: [529 overloaded_error] Overloaded"
    );
    expect(error.provider).toBe("gemini+anthropic");
    expect(error.retryable).toBe(true);
    expect(error.report).toBe(true);
  });

  it("does not report or retry two accounts that cannot pay", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const claudeDepleted = new LlmError("Claude refused the call because the account cannot pay: [402 billing_error]", "anthropic", undefined, {
      retryable: false,
      report: false,
    });
    const llm = new FallbackProvider(
      gemini({ error: DEPLETED }),
      claude(() => provider("anthropic", { error: claudeDepleted }).llm)
    );

    const error = await llm.generateText("Write.").catch((e) => e);

    expect(error.retryable).toBe(false);
    expect(error.report).toBe(false);
  });

  it("surfaces a fallback that cannot be built next to the primary's reason", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const llm = new FallbackProvider(
      gemini({ error: DEPLETED }),
      claude(() => {
        throw new LlmError("ANTHROPIC_API_KEY is not set", "anthropic", undefined, { retryable: false });
      })
    );

    const error = await llm.generateText("Write.").catch((e) => e);

    expect(error.message).toContain("Gemini credits are depleted");
    expect(error.message).toContain("The fallback failed too: ANTHROPIC_API_KEY is not set");
    expect(error.retryable).toBe(false);
    expect(error.report).toBe(true);
  });

  it("does not spend a second vendor on a call the caller already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const aborted = new DOMException("This operation was aborted", "AbortError");
    const build = vi.fn(() => provider("anthropic", { text: "late" }).llm);
    const llm = new FallbackProvider(gemini({ error: aborted }), claude(build));

    const error = await llm.generateText("Write.", { signal: controller.signal }).catch((e) => e);

    expect(error).toBe(aborted);
    expect(build).not.toHaveBeenCalled();
  });
});
