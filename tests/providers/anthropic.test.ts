import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  AnthropicProvider,
  DEFAULT_MODELS,
  FALLBACKS,
  PRICES,
  anthropicApiError,
  candidateModels,
  costOf,
  generationOf,
  readMessage,
  requestBody,
} from "@/lib/providers/llm/anthropic";
import { LlmError } from "@/lib/providers/llm/types";

// A retired name 404s on every call. These are retired or deprecated on the
// Claude API and must not come back as a default or a fallback.
const RETIRED = [
  "claude-3-haiku-20240307",
  "claude-3-5-haiku-20241022",
  "claude-3-7-sonnet-20250219",
  "claude-sonnet-4-20250514",
  "claude-opus-4-20250514",
  "claude-opus-4-1-20250805",
  "claude-sonnet-4-5-20250929",
];

describe("claude model chain", () => {
  it("never references a retired model name", () => {
    for (const model of [...Object.values(DEFAULT_MODELS), ...FALLBACKS]) {
      expect(RETIRED).not.toContain(model);
    }
  });

  it("prices every model it can pick, so cost attribution never silently zeroes", () => {
    for (const model of [...Object.values(DEFAULT_MODELS), ...FALLBACKS]) {
      expect(PRICES[model], `missing price for ${model}`).toBeDefined();
      expect(PRICES[model].input).toBeGreaterThan(0);
      expect(PRICES[model].output).toBeGreaterThan(0);
    }
  });

  it("puts the cheap model on the fast tier and keeps a second model on each", () => {
    expect(DEFAULT_MODELS.fast).toBe("claude-haiku-5-5");
    expect(DEFAULT_MODELS.quality).toBe("claude-sonnet-5-5");
    // Haiku 4.5 stays behind Haiku 5.5; the fast tier pays for Sonnet last.
    expect(candidateModels("fast")).toEqual(["claude-haiku-5-5", "claude-haiku-4-5", "claude-sonnet-5-5"]);
    expect(candidateModels("quality")).toEqual(["claude-sonnet-5-5", "claude-haiku-5-5", "claude-haiku-4-5"]);
    expect(candidateModels("quality", true)).toEqual(["claude-sonnet-5-5"]);
  });

  it("prices Haiku 5.5 at $0.10 in and $0.50 out per 1M tokens, and keeps Haiku 4.5 priced", () => {
    expect(PRICES["claude-haiku-5-5"]).toEqual({ input: 0.1, output: 0.5 });
    expect(PRICES["claude-haiku-4-5"]).toEqual({ input: 1, output: 5 });
    expect(costOf("claude-haiku-5-5", 1_000_000, 1_000_000)).toBeCloseTo(0.6);
    expect(costOf("claude-haiku-5-5-20261001", 2_000_000, 0)).toBeCloseTo(0.2);
  });

  it("prices a dated snapshot as its alias and estimates an unknown name above zero", () => {
    expect(costOf("claude-haiku-4-5-20251001", 1_000_000, 1_000_000)).toBe(6);
    expect(costOf("claude-sonnet-5-5", 1_000_000, 0)).toBe(2);
    expect(costOf("claude-sonnet-9-9", 1000, 1000)).toBeGreaterThan(0);
  });
});

describe("claude request shape", () => {
  it("places a model's generation, including dated snapshots", () => {
    expect(generationOf("claude-sonnet-5-5")).toBe(505);
    expect(generationOf("claude-haiku-4-5-20251001")).toBe(405);
    expect(generationOf("claude-haiku-5-5")).toBe(505);
    expect(generationOf("claude-sonnet-5")).toBe(500);
    expect(generationOf("claude-opus-4-10")).toBe(410);
    expect(generationOf("claude-3-5-haiku-20241022")).toBeNull();
  });

  it("sends no temperature to Claude 4.7 and later, and steers effort by tier", () => {
    const quality = requestBody("claude-sonnet-5-5", "Write.", { tier: "quality", temperature: 0.7 }, false);
    expect(quality).not.toHaveProperty("temperature");
    expect(quality.output_config).toEqual({ effort: "medium" });
    expect(quality.max_tokens).toBe(16_000);
    expect(quality.messages).toEqual([{ role: "user", content: "Write." }]);
    expect(quality).not.toHaveProperty("system");

    const fast = requestBody("claude-sonnet-5-5", "Judge.", { tier: "fast", temperature: 0.1 }, true);
    expect(fast.output_config).toEqual({ effort: "low" });
    expect(fast.system).toMatch(/JSON/);
  });

  it("sends Haiku 5.5 low effort on the fast tier and no temperature", () => {
    const body = requestBody("claude-haiku-5-5", "Judge.", { tier: "fast", temperature: 0.1 }, true);
    expect(body).toEqual({
      model: "claude-haiku-5-5",
      max_tokens: 16_000,
      system: "Answer with one JSON value and nothing else.",
      messages: [{ role: "user", content: "Judge." }],
      output_config: { effort: "low" },
    });
  });

  it("keeps the caller's temperature on Haiku 4.5, which has no effort setting", () => {
    const body = requestBody("claude-haiku-4-5", "Judge.", { tier: "fast", temperature: 0.1 }, true);
    expect(body.temperature).toBe(0.1);
    expect(body).not.toHaveProperty("output_config");
  });

  it("sends neither knob to a name it cannot place, and honours a caller's ceiling", () => {
    const body = requestBody("custom-deployment", "Hi.", { temperature: 0.4, maxOutputTokens: 900 }, false);
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("output_config");
    expect(body.max_tokens).toBe(900);
  });
});

describe("claude errors", () => {
  it("treats billing, the monthly cap and a spend limit as the account, not the call", () => {
    expect(anthropicApiError(402, { error: { type: "billing_error", message: "Fix billing" } }).accountRefusal).toBe(true);
    const cap = anthropicApiError(429, {
      error: {
        type: "rate_limit_error",
        message: "You have reached your API usage limits",
        details: { error_code: "enforced_spend_limit_reached" },
      },
    });
    expect(cap.accountRefusal).toBe(true);
    expect(cap.terminal).toBe(true);
    expect(
      anthropicApiError(400, {
        error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." },
      }).accountRefusal
    ).toBe(true);
    expect(
      anthropicApiError(400, {
        error: { type: "invalid_request_error", message: "You have reached your specified API usage limits." },
      }).accountRefusal
    ).toBe(true);
  });

  it("stops on a refused key, and walks on a rate limit, an outage or a retired name", () => {
    const auth = anthropicApiError(401, { error: { type: "authentication_error", message: "invalid x-api-key" } });
    expect(auth.terminal).toBe(true);
    expect(auth.accountRefusal).toBe(false);
    expect(auth.message).toBe("[401 authentication_error] invalid x-api-key");

    const limited = anthropicApiError(429, { error: { type: "rate_limit_error", message: "Slow down" } });
    expect(limited.terminal).toBe(false);
    expect(anthropicApiError(529, { error: { type: "overloaded_error", message: "Overloaded" } }).terminal).toBe(false);
    expect(anthropicApiError(404, { error: { type: "not_found_error", message: "model" } }).terminal).toBe(false);
    expect(anthropicApiError(502, null).message).toBe("[502 error]");
  });
});

describe("readMessage", () => {
  it("returns the text blocks only, and the usage of the model that answered", () => {
    const { text, usage } = readMessage(
      {
        model: "claude-sonnet-5-5",
        stop_reason: "end_turn",
        content: [
          { type: "thinking", thinking: "plan" },
          { type: "text", text: "<h1>Title</h1>" },
          { type: "text", text: "<p>Body</p>" },
        ],
        usage: { input_tokens: 1000, output_tokens: 2000 },
      },
      "claude-sonnet-5-5"
    );
    expect(text).toBe("<h1>Title</h1><p>Body</p>");
    expect(usage).toEqual({
      model: "claude-sonnet-5-5",
      inputTokens: 1000,
      outputTokens: 2000,
      costUsd: (1000 * 2 + 2000 * 10) / 1_000_000,
    });
  });

  it("refuses a cut-off answer and an empty one", () => {
    expect(() =>
      readMessage({ stop_reason: "max_tokens", content: [{ type: "text", text: "<h1>Half" }] }, "m")
    ).toThrow(/output token limit/);
    expect(() => readMessage({ stop_reason: "end_turn", content: [{ type: "thinking" }] }, "m")).toThrow(
      /empty response/
    );
  });
});

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function answer(text: string, model = "claude-haiku-5-5-20261001") {
  return { model, stop_reason: "end_turn", content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 20 } };
}

function stubFetch(respond: () => Response) {
  const fetchMock = vi.fn<typeof fetch>(async () => respond());
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function sentBody(fetchMock: ReturnType<typeof stubFetch>, call = 0) {
  return JSON.parse(String(fetchMock.mock.calls[call][1]?.body));
}

describe("AnthropicProvider", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("refuses to start without a key, as a failure retrying cannot fix", () => {
    try {
      new AnthropicProvider("");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(LlmError);
      expect((err as LlmError).message).toBe("ANTHROPIC_API_KEY is not set");
      expect((err as LlmError).retryable).toBe(false);
    }
  });

  it("calls the Messages API with the key and returns text with its cost", async () => {
    const fetchMock = stubFetch(() => reply(200, answer("Hello")));

    const result = await new AnthropicProvider("sk-test").generateText("Say hi.", { tier: "fast", temperature: 0.2 });

    expect(result.text).toBe("Hello");
    expect(result.usage.model).toBe("claude-haiku-5-5-20261001");
    expect(result.usage.costUsd).toBeCloseTo((10 * 0.1 + 20 * 0.5) / 1_000_000);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect((init?.headers as Record<string, string>)["x-api-key"]).toBe("sk-test");
    expect((init?.headers as Record<string, string>)["anthropic-version"]).toBe("2023-06-01");
    expect(sentBody(fetchMock)).toMatchObject({ model: "claude-haiku-5-5", output_config: { effort: "low" } });
    expect(sentBody(fetchMock)).not.toHaveProperty("temperature");
  });

  it("walks to the next model when a name is gone", async () => {
    const fetchMock = stubFetch(() => reply(200, answer("ok", "claude-haiku-4-5"))).mockResolvedValueOnce(
      reply(404, { error: { type: "not_found_error", message: "model: claude-haiku-5-5" } })
    );

    const result = await new AnthropicProvider("sk-test").generateText("Hi.", { tier: "fast" });

    expect(result.text).toBe("ok");
    const models = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).model);
    expect(models).toEqual(["claude-haiku-5-5", "claude-haiku-4-5"]);
    // The older model keeps its temperature; the answer says it was a step down.
    expect(sentBody(fetchMock, 1)).not.toHaveProperty("output_config");
    expect(result.usage).toMatchObject({ model: "claude-haiku-4-5", fallback: true });
  });

  it("stops at a refused key: one call, not retryable, still reported", async () => {
    const fetchMock = stubFetch(() =>
      reply(401, { error: { type: "authentication_error", message: "invalid x-api-key" } })
    );

    const error = await new AnthropicProvider("sk-bad").generateText("Hi.").catch((e) => e);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(LlmError);
    expect(error.message).toBe("Claude request failed: [401 authentication_error] invalid x-api-key");
    expect(error.retryable).toBe(false);
    expect(error.report).toBe(true);
  });

  it("stops at an account that cannot pay, and does not report it", async () => {
    const fetchMock = stubFetch(() =>
      reply(402, { error: { type: "billing_error", message: "Check your payment details." } })
    );

    const error = await new AnthropicProvider("sk-test").generateText("Hi.").catch((e) => e);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.message).toMatch(/^Claude refused the call because the account cannot pay/);
    expect(error.retryable).toBe(false);
    expect(error.report).toBe(false);
  });

  it("keeps an outage on every model retryable", async () => {
    stubFetch(() => reply(529, { error: { type: "overloaded_error", message: "Overloaded" } }));

    const error = await new AnthropicProvider("sk-test").generateText("Hi.", { tier: "quality" }).catch((e) => e);

    expect(error.message).toBe("Claude request failed: [529 overloaded_error] Overloaded");
    expect(error.retryable).toBe(true);
  });

  it("produces validated structures through the shared schema contract", async () => {
    const fetchMock = stubFetch(() => reply(200, answer('{"verdict":"yes"}')));

    const result = await new AnthropicProvider("sk-test").generateStructured(
      "Judge.",
      z.object({ verdict: z.enum(["yes", "no"]) }),
      { tier: "fast" }
    );

    expect(result.value).toEqual({ verdict: "yes" });
    const body = sentBody(fetchMock);
    expect(body.system).toMatch(/JSON/);
    expect(body.messages[0].content).toContain("matching this JSON Schema exactly");
  });
});
