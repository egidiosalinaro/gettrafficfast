import type { z } from "zod";
import { isTimeoutError, LLM_CALL_TIMEOUT_MS, withDeadline } from "./bound";
import { completeStructured } from "./structured";
import {
  LLMProvider,
  LlmError,
  LlmOptions,
  LlmStructuredResult,
  LlmTextResult,
  LlmTier,
  LlmUsage,
} from "./types";

/**
 * Claude, through the Anthropic Messages API.
 *
 * Plain fetch: one endpoint, and classifying a failure needs the HTTP status
 * and the API's error object, which the response carries as they are.
 *
 * Each tier gets the cheapest model that does its work: Haiku behind "fast"
 * (extraction, judging, planning), Sonnet behind "quality" (articles,
 * drafts), both overridable by environment. A failed call walks the static
 * chain, which survives a retired or overloaded model; an account refusal
 * stops it, because every model would be refused the same way.
 */

const ENDPOINT = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

// tests/providers/anthropic.test.ts pins that every entry is priced and that
// no retired name reappears.
export const DEFAULT_MODELS: Record<LlmTier, string> = {
  fast: process.env.ANTHROPIC_MODEL_FAST || "claude-haiku-5-5",
  quality: process.env.ANTHROPIC_MODEL_QUALITY || "claude-sonnet-5-5",
};

/**
 * Tried after the tier default, in this order: the fast tier steps to the
 * previous Haiku before it pays for Sonnet, and the quality tier (Sonnet
 * first) to the newer Haiku before the older one.
 */
export const FALLBACKS = ["claude-haiku-5-5", "claude-haiku-4-5", "claude-sonnet-5-5"];

/**
 * The API requires an output ceiling. Thinking counts against it, so an
 * article and the reasoning behind it must both fit; billing is per token
 * produced, and the ceiling costs nothing by itself.
 */
const MAX_OUTPUT_TOKENS = 16_000;

/**
 * Thinking is billed as output, and Claude 4.7 and later think at "high"
 * effort unless told otherwise. Extraction needs little of it; writing gets
 * a moderate share.
 */
const EFFORT: Record<LlmTier, "low" | "medium"> = { fast: "low", quality: "medium" };

/**
 * USD per 1M tokens, vendor-published. Kept only so cost can be attributed
 * per business; an estimate, not billing truth.
 */
export const PRICES: Record<string, { input: number; output: number }> = {
  // Up to 100K-token prompts, which is every prompt this platform sends.
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-opus-5-5": { input: 4, output: 20 },
};

/**
 * Exact for a priced alias or its dated snapshot ("claude-haiku-4-5-20251001");
 * a family estimate, rounded up, for anything else. Attribution must never
 * silently zero.
 */
export function costOf(model: string, inputTokens: number, outputTokens: number): number {
  const alias = model.replace(/-\d{8}$/, "");
  const price =
    PRICES[alias] ??
    (alias.includes("haiku")
      ? { input: 1, output: 5 }
      : alias.includes("sonnet")
        ? { input: 3, output: 15 }
        : alias.includes("opus")
          ? { input: 5, output: 25 }
          : { input: 10, output: 50 });
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

/**
 * Model generation as major * 100 + minor: "claude-sonnet-5-5" → 505,
 * "claude-haiku-4-5-20251001" → 405, "claude-sonnet-5" → 500. Null for a
 * name this cannot place.
 */
export function generationOf(model: string): number | null {
  const match = model.match(/^claude-[a-z]+-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/);
  return match ? Number(match[1]) * 100 + Number(match[2] ?? 0) : null;
}

/**
 * Claude 4.7 and later answer a non-default temperature with HTTP 400, and
 * effort is how they are steered: that includes Haiku 5.5 (generation 505),
 * which thinks by default and gets "low" on the fast tier. Haiku 4.5 has no
 * effort setting and still honours temperature. A name this cannot place gets neither, which every
 * model accepts. `options.thinking` is ignored: these requests send no
 * thinking budget to shrink, and effort stays per tier.
 */
function tuning(model: string, options: LlmOptions | undefined): Record<string, unknown> {
  const generation = generationOf(model);
  if (generation === null) return {};
  if (generation >= 407) return { output_config: { effort: EFFORT[options?.tier ?? "fast"] } };
  return options?.temperature === undefined ? {} : { temperature: options.temperature };
}

/**
 * The user turn: the prompt alone, or the images first (Claude reads an
 * image placed before the question best) and the prompt after, each image
 * a base64 block.
 */
export function messageContent(prompt: string, options: LlmOptions | undefined): string | Record<string, unknown>[] {
  const images = options?.images ?? [];
  if (images.length === 0) return prompt;
  return [
    ...images.map((image) => ({
      type: "image",
      source: { type: "base64", media_type: image.mimeType, data: image.data },
    })),
    { type: "text", text: prompt },
  ];
}

export function requestBody(
  model: string,
  prompt: string,
  options: LlmOptions | undefined,
  json: boolean
): Record<string, unknown> {
  return {
    model,
    max_tokens: options?.maxOutputTokens ?? MAX_OUTPUT_TOKENS,
    ...(json ? { system: "Answer with one JSON value and nothing else." } : {}),
    messages: [{ role: "user", content: messageContent(prompt, options) }],
    ...tuning(model, options),
  };
}

/** Whether a model can stand in for the quality tier: the configured one, or anything that is not Haiku. */
export function isQualityModel(model: string): boolean {
  return model === DEFAULT_MODELS.quality || !/haiku/.test(model);
}

export function candidateModels(tier: LlmTier, strictTier = false): string[] {
  const chain = [...new Set([DEFAULT_MODELS[tier], ...FALLBACKS])];
  return tier === "quality" && strictTier ? chain.filter(isQualityModel) : chain;
}

/** A non-2xx answer, with what deciding the next move needs. */
export class AnthropicApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The account cannot pay: billing, the tier's monthly cap, or a spend limit. */
    readonly accountRefusal: boolean
  ) {
    super(message);
    this.name = "AnthropicApiError";
  }

  /** The account or the key refused: the next model would be refused too. */
  get terminal(): boolean {
    return this.accountRefusal || this.status === 401 || this.status === 403;
  }
}

interface AnthropicErrorBody {
  error?: { type?: string; message?: string; details?: { error_code?: string } | null };
}

export function anthropicApiError(status: number, body: unknown): AnthropicApiError {
  const error = (body as AnthropicErrorBody | null)?.error;
  const message = error?.message ?? "";
  // A tier's monthly cap answers 429 like a rate limit and is told apart only
  // by its error code; a spend limit set in the Console answers 400.
  const accountRefusal =
    status === 402 ||
    error?.details?.error_code === "enforced_spend_limit_reached" ||
    /credit balance is too low|reached your specified (?:workspace )?API usage limits/i.test(message);
  return new AnthropicApiError(
    `[${status} ${error?.type ?? "error"}] ${message}`.trim(),
    status,
    accountRefusal
  );
}

interface AnthropicMessage {
  model?: string;
  content?: { type?: string; text?: string }[];
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** The answer and what it cost. Thinking blocks are not the answer. */
export function readMessage(payload: unknown, requested: string): { text: string; usage: LlmUsage } {
  const message = (payload ?? {}) as AnthropicMessage;
  // A cut-off article is corrupted content, not a shorter one.
  if (message.stop_reason === "max_tokens") throw new Error("stopped at the output token limit");
  if (message.stop_reason === "refusal") throw new Error("declined to answer");

  const text = (message.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
  if (!text.trim()) throw new Error("empty response");

  const model = message.model || requested;
  const inputTokens = message.usage?.input_tokens ?? 0;
  const outputTokens = message.usage?.output_tokens ?? 0;
  return {
    text,
    usage: { model, inputTokens, outputTokens, costUsd: costOf(model, inputTokens, outputTokens) },
  };
}

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";

  constructor(private readonly apiKey: string) {
    if (!apiKey) {
      throw new LlmError("ANTHROPIC_API_KEY is not set", "anthropic", undefined, { retryable: false });
    }
  }

  private async send(
    model: string,
    prompt: string,
    options: LlmOptions | undefined,
    json: boolean
  ): Promise<{ text: string; usage: LlmUsage }> {
    const response = await withDeadline(options?.signal, LLM_CALL_TIMEOUT_MS, (signal) =>
      fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "x-api-key": this.apiKey,
          "anthropic-version": API_VERSION,
          "content-type": "application/json",
        },
        body: JSON.stringify(requestBody(model, prompt, options, json)),
        signal,
      })
    );
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) throw anthropicApiError(response.status, payload);
    return readMessage(payload, model);
  }

  private async call(
    prompt: string,
    options: LlmOptions | undefined,
    json: boolean
  ): Promise<{ text: string; usage: LlmUsage }> {
    let lastError: unknown = null;

    const tier = options?.tier ?? "fast";
    const candidates = candidateModels(tier, options?.strictTier === true);
    for (const model of candidates) {
      try {
        const answer = await this.send(model, prompt, options, json);
        return {
          text: answer.text,
          usage: {
            ...answer.usage,
            provider: "anthropic",
            fallback: model !== candidates[0],
            tierDowngraded: tier === "quality" && !isQualityModel(model),
          },
        };
      } catch (err) {
        if (err instanceof AnthropicApiError && err.accountRefusal) {
          throw new LlmError(
            `Claude refused the call because the account cannot pay: ${err.message}`,
            "anthropic",
            err,
            { retryable: false, report: false, billingRefused: ["anthropic"] }
          );
        }
        lastError = err;
        if (options?.signal?.aborted) break;
        if (isTimeoutError(err)) continue;
        if (err instanceof AnthropicApiError && err.terminal) break;
      }
    }

    const terminal = lastError instanceof AnthropicApiError && lastError.terminal;
    const timedOut = isTimeoutError(lastError);
    throw new LlmError(
      timedOut
        ? "Claude did not answer in time."
        : `Claude request failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      "anthropic",
      lastError,
      { retryable: timedOut || !terminal }
    );
  }

  async generateText(prompt: string, options?: LlmOptions): Promise<LlmTextResult> {
    return this.call(prompt, options, false);
  }

  async generateStructured<T>(
    prompt: string,
    schema: z.ZodType<T>,
    options?: LlmOptions
  ): Promise<LlmStructuredResult<T>> {
    return completeStructured((instructed) => this.call(instructed, options, true), prompt, schema, {
      provider: "anthropic",
      label: "Claude",
    });
  }
}
