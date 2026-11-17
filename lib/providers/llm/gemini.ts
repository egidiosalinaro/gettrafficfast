import { GoogleGenerativeAI, type GenerationConfig, type Part } from "@google/generative-ai";
import type { z } from "zod";
import { abortError, isTimeoutError, LIST_MODELS_TIMEOUT_MS, LLM_CALL_TIMEOUT_MS, withDeadline } from "./bound";
import { completeStructured } from "./structured";
import {
  LLMProvider,
  LlmError,
  isProviderBillingFailure,
  LlmOptions,
  LlmStructuredResult,
  LlmTextResult,
  LlmTier,
  LlmUsage,
} from "./types";

/**
 * Gemini implementation of the LLM boundary.
 *
 * Model choice is per tier and overridable by environment, so switching the
 * model behind "quality" never touches an agent.
 *
 * Resilience is layered, because both layers have failed before:
 *  1. a STATIC chain of current, priced, test-pinned names (GETTRAFFICFAST-1:
 *     Google retired gemini-pro and the whole 1.5 series and every article job
 *     died at the outline step) — bumped deliberately, never trusted blindly;
 *  2. DYNAMIC discovery via ListModels as the net underneath: if the static
 *     chain rots faster than we bump it, live flash/pro text models are tried
 *     next, newest first within the tier's family. Specialty models
 *     (robotics, image, embedding) are not substitutes. A 404 walks the
 *     chain; an auth or billing refusal stops it.
 */

// Static chain: current, stable names. tests/providers/gemini-models.test.ts
// pins that no retired name reappears and that every entry is priced.
export const DEFAULT_MODELS: Record<LlmTier, string> = {
  fast: process.env.LLM_MODEL_FAST || "gemini-2.5-flash",
  quality: process.env.LLM_MODEL_QUALITY || "gemini-2.5-pro",
};

/** Static fallbacks tried after the tier default, before discovery kicks in. */
export const FALLBACKS = ["gemini-2.5-flash", "gemini-2.0-flash"];

/**
 * USD per 1M tokens. Approximate and vendor-published — kept only so cost can
 * be attributed per business; an estimate, not billing truth.
 */
export const PRICES: Record<string, { input: number; output: number }> = {
  "gemini-2.5-flash": { input: 0.3, output: 2.5 },
  "gemini-2.5-pro": { input: 1.25, output: 10.0 },
  "gemini-2.0-flash": { input: 0.1, output: 0.4 },
};

/**
 * Exact price when the model is in the table; a family-based estimate for
 * discovered models that are not — attribution must never silently zero.
 */
function costOf(model: string, inputTokens: number, outputTokens: number): number {
  const price =
    PRICES[model] ??
    (model.includes("flash")
      ? { input: 0.3, output: 2.5 }
      : model.includes("pro")
        ? { input: 1.25, output: 10.0 }
        : { input: 0.5, output: 2.5 });
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

/**
 * Specialty products that happen to support generateContent. They are not
 * stand-ins for a writing model: calling one spends a different quota and
 * returns a different kind of answer. "preview" must not count as "pro" —
 * the substring "pro" sits inside "preview", which is how a robotics preview
 * model became the last stop of the text chain (GETTRAFFICFAST-6).
 */
const SPECIALTY_MODEL =
  /robotics|embed|imagen|-image|aqa|tts|live|audio|veo|lyria|computer-use|learnlm|nano|deep-research|gemma/i;

/** A general text model: gemini-<version>-flash or -pro, including lite. */
export function isTextGenerationModel(name: string): boolean {
  if (!/^gemini-\d+(?:\.\d+)?(?:-|$)/.test(name)) return false;
  if (SPECIALTY_MODEL.test(name)) return false;
  return /(?:^|-)(?:flash|pro)(?:-|$)/.test(name);
}

function inFamily(name: string, family: "flash" | "pro"): boolean {
  return new RegExp(`(?:^|-)${family}(?:-|$)`).test(name);
}

/** Version number embedded in a model name ("gemini-2.5-flash" → 2.5). */
function versionOf(name: string): number {
  const match = name.match(/^gemini-(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : 0;
}

/**
 * Configured model, then the static fallbacks, then live text models of the
 * tier's family. Specialty names in `available` are dropped.
 */
export function orderCandidateModels(tier: LlmTier, available: string[]): string[] {
  const configured = DEFAULT_MODELS[tier];
  const family = tier === "fast" ? "flash" : "pro";
  const discovered = available.filter(isTextGenerationModel).sort((a, b) => {
    const familyDelta = Number(inFamily(b, family)) - Number(inFamily(a, family));
    if (familyDelta !== 0) return familyDelta;
    return versionOf(b) - versionOf(a);
  });
  return [...new Set([configured, ...FALLBACKS, ...discovered])];
}

/**
 * Whether a model can stand in for the quality tier: the configured one, or
 * any model of the pro family. Flash is not: on 2026-11-10 the audit found
 * most "quality" articles written by gemini-2.5-flash, because the chain
 * stepped from pro to flash inside one call and recorded nothing.
 */
export function isQualityModel(name: string): boolean {
  return name === DEFAULT_MODELS.quality || inFamily(name, "pro");
}

/** The candidates a call may use: the whole chain, or only the quality family when the tier is strict. */
export function candidatesFor(tier: LlmTier, available: string[], strictTier: boolean): string[] {
  const ordered = orderCandidateModels(tier, available);
  return tier === "quality" && strictTier ? ordered.filter(isQualityModel) : ordered;
}

/**
 * Auth and billing will fail the same way on every model. A 404 is the name
 * rotting, which is what the chain exists to survive.
 */
export function isTerminalProviderFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /\[(401|402|403)\b/.test(message);
}

/**
 * Thinking tokens for `thinking: "low"`. The 2.5 series thinks by default,
 * and on a short reply the thinking is most of the wait: 25 s for a 1,430
 * token answer on 9 November 2026. 512 is inside every 2.5 model's range
 * (Pro cannot go below 128, Flash-Lite below 512) and leaves room to plan
 * a reply of two sentences.
 */
export const LOW_THINKING_BUDGET = 512;

/**
 * The thinking config for this model, or nothing. Only the 2.5 series takes
 * `thinkingBudget`: 2.0 has no thinking and refuses the field, and later
 * series steer thinking another way, so sending it there would turn a speed
 * hint into a failed call that walks the chain.
 */
export function thinkingConfigFor(
  model: string,
  thinking: LlmOptions["thinking"]
): { thinkingBudget: number } | undefined {
  if (thinking !== "low") return undefined;
  return /^gemini-2\.5-/.test(model) ? { thinkingBudget: LOW_THINKING_BUDGET } : undefined;
}

/**
 * What `generateContent` is given: the prompt alone, or each image as an
 * `inlineData` part (base64) before the prompt's text part.
 */
export function contentParts(prompt: string, options: LlmOptions | undefined): string | Part[] {
  const images = options?.images ?? [];
  if (images.length === 0) return prompt;
  return [...images.map((image) => ({ inlineData: { mimeType: image.mimeType, data: image.data } })), { text: prompt }];
}

export class GeminiProvider implements LLMProvider {
  readonly name = "gemini";
  private readonly client: GoogleGenerativeAI;
  private readonly apiKey: string;
  private discovery: string[] | null = null;

  constructor(apiKey: string) {
    if (!apiKey) {
      throw new LlmError("GEMINI_API_KEY is not set", "gemini", undefined, { retryable: false });
    }
    this.apiKey = apiKey;
    this.client = new GoogleGenerativeAI(apiKey);
  }

  /**
   * Models this key can actually call, discovered from ListModels and cached
   * per instance once the request finishes. A hang is not cached: the next
   * call tries again, and the static chain stands alone until then.
   */
  private async listAvailableModels(signal?: AbortSignal): Promise<string[]> {
    if (this.discovery) return this.discovery;
    if (signal?.aborted) throw abortError(signal);
    try {
      const names = await withDeadline(signal, LIST_MODELS_TIMEOUT_MS, async (bound) => {
        const response = await fetch(
          "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200",
          { headers: { "x-goog-api-key": this.apiKey }, signal: bound }
        );
        if (!response.ok) return [];
        const data = (await response.json()) as {
          models?: { name?: string; supportedGenerationMethods?: string[] }[];
        };
        return (data.models ?? [])
          .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
          .map((m) => (m.name ?? "").replace(/^models\//, ""))
          .filter((name) => /^gemini-/.test(name));
      });
      this.discovery = names;
      return names;
    } catch (err) {
      if (signal?.aborted) throw err;
      // One dead catalogue must not cost another 8 seconds on the next write
      // of the same job. A new function tries again.
      this.discovery = [];
      return [];
    }
  }

  private async call(
    prompt: string,
    options: LlmOptions | undefined,
    json: boolean
  ): Promise<{ text: string; usage: LlmUsage }> {
    const tier = options?.tier ?? "fast";
    let lastError: unknown = null;

    const candidates = candidatesFor(
      tier,
      await this.listAvailableModels(options?.signal),
      options?.strictTier === true
    );
    for (const modelName of candidates) {
      if (options?.signal?.aborted) throw abortError(options.signal);
      try {
        // SDK 0.24's GenerationConfig type predates thinkingConfig, but the
        // SDK sends generationConfig to the REST API as it is given, and the
        // API reads generationConfig.thinkingConfig. Typed here, not cast.
        const thinkingConfig = thinkingConfigFor(modelName, options?.thinking);
        const generationConfig: GenerationConfig & { thinkingConfig?: { thinkingBudget: number } } = {
          temperature: options?.temperature,
          maxOutputTokens: options?.maxOutputTokens,
          ...(json ? { responseMimeType: "application/json" } : {}),
          ...(thinkingConfig ? { thinkingConfig } : {}),
        };
        const model = this.client.getGenerativeModel({ model: modelName, generationConfig });
        const result = await withDeadline(options?.signal, LLM_CALL_TIMEOUT_MS, (signal) =>
          model.generateContent(contentParts(prompt, options), { signal, timeout: LLM_CALL_TIMEOUT_MS })
        );
        const text = result.response.text();
        if (!text?.trim()) throw new Error("empty response");

        const meta = result.response.usageMetadata;
        const inputTokens = meta?.promptTokenCount ?? 0;
        const outputTokens = meta?.candidatesTokenCount ?? 0;

        return {
          text,
          usage: {
            model: modelName,
            inputTokens,
            outputTokens,
            costUsd: costOf(modelName, inputTokens, outputTokens),
            provider: "gemini",
            fallback: modelName !== candidates[0],
            tierDowngraded: tier === "quality" && !isQualityModel(modelName),
          },
        };
      } catch (err) {
        // The job's own clock. The next model would be aborted too.
        if (options?.signal?.aborted) throw err;
        // 402 is the account, not the model. The next name on the chain
        // fails the same way, and so does the next job retry.
        if (isProviderBillingFailure(err)) {
          throw new LlmError(
            "Gemini credits are depleted. Generation stays paused until billing is topped up.",
            "gemini",
            err,
            { retryable: false, report: false, billingRefused: ["gemini"] }
          );
        }
        lastError = err;
        // The account or the key refused the call. The next name in the
        // catalog will be refused too, and walking it is how a robotics
        // model became the error the job recorded.
        if (isTerminalProviderFailure(err)) break;
        // Said out loud: a chain that steps down in silence is how the fast
        // model wrote "quality" articles for months without a trace.
        console.warn(
          JSON.stringify({
            level: "warn",
            event: "llm.model_step_down",
            provider: "gemini",
            tier,
            model: modelName,
            strict: options?.strictTier === true,
            error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
          })
        );
      }
    }

    const terminal = isTerminalProviderFailure(lastError);
    const timedOut = isTimeoutError(lastError);
    throw new LlmError(
      timedOut
        ? "Gemini did not answer in time."
        : `Gemini request failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      "gemini",
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
      provider: "gemini",
      label: "Gemini",
    });
  }
}
