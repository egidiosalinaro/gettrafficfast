import type { z } from "zod";
import { LLMProvider, LlmError, LlmOptions, LlmStructuredResult, LlmTextResult, LlmUsage } from "./types";

/** A provider by name, built on first need. */
export interface ProviderSlot {
  name: string;
  build: () => LLMProvider;
}

/**
 * A second provider behind the first.
 *
 * Any failure of the primary (an account that cannot pay, a refused key, a
 * key that is not set, an outage, an answer that never matched the schema)
 * sends the same request to the fallback, once. Our own abort is not a
 * provider failure: the caller ran out of time, and a second vendor would not
 * give it back.
 *
 * Both sides are built on first need, so a fallback that is misconfigured
 * never stops a primary that works; its error surfaces when it was needed,
 * next to the primary's.
 */
export class FallbackProvider implements LLMProvider {
  readonly name: string;
  private primaryProvider: LLMProvider | null = null;
  private fallbackProvider: LLMProvider | null = null;

  constructor(
    private readonly primary: ProviderSlot,
    private readonly fallback: ProviderSlot
  ) {
    this.name = `${primary.name}+${fallback.name}`;
  }

  generateText(prompt: string, requested?: LlmOptions): Promise<LlmTextResult> {
    const options = strict(requested);
    return this.attempt(options, (llm) => llm.generateText(prompt, options));
  }

  generateStructured<T>(
    prompt: string,
    schema: z.ZodType<T>,
    requested?: LlmOptions
  ): Promise<LlmStructuredResult<T>> {
    const options = strict(requested);
    return this.attempt(options, (llm) => llm.generateStructured(prompt, schema, options));
  }

  private async attempt<R extends { usage: LlmUsage }>(
    options: LlmOptions | undefined,
    call: (llm: LLMProvider) => Promise<R>
  ): Promise<R> {
    try {
      this.primaryProvider ??= this.primary.build();
      return await call(this.primaryProvider);
    } catch (primaryError) {
      if (options?.signal?.aborted) throw primaryError;
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "llm.fallback",
          primary: this.primary.name,
          fallback: this.fallback.name,
          error: messageOf(primaryError).slice(0, 300),
        })
      );
      try {
        this.fallbackProvider ??= this.fallback.build();
        const answer = await call(this.fallbackProvider);
        // The second provider answered: whoever reads the usage must be able
        // to tell, because the model on it is not the one configured.
        return { ...answer, usage: { ...answer.usage, provider: answer.usage.provider ?? this.fallback.name, fallback: true } };
      } catch (fallbackError) {
        throw this.bothFailed(primaryError, fallbackError);
      }
    }
  }

  /**
   * Retrying runs both again, so it can succeed if either side can. A defect
   * on either side is reported; two accounts that cannot pay are not sent to
   * Sentry as exceptions. They are marked `billingRefused` instead, and the
   * caller's operator alert (`lib/llm-billing.ts`) says it once a day.
   */
  private bothFailed(primaryError: unknown, fallbackError: unknown): LlmError {
    const first = asLlmError(primaryError, this.primary.name);
    const second = asLlmError(fallbackError, this.fallback.name);
    return new LlmError(
      `${first.message} The fallback failed too: ${second.message}`,
      this.name,
      { primary: primaryError, fallback: fallbackError },
      {
        retryable: first.retryable || second.retryable,
        report: first.report || second.report,
        // Only when neither side can pay is the whole layer refused. A primary
        // that cannot pay behind a fallback that timed out is still a failure
        // the next attempt may get past.
        billingRefused:
          first.billingRefused.length > 0 && second.billingRefused.length > 0
            ? [...first.billingRefused, ...second.billingRefused]
            : [],
      }
    );
  }
}

/**
 * `keepTier` becomes `strictTier` here, where somebody stands behind the
 * primary: its quality family fails over to the fallback's quality model
 * rather than to its own fast one.
 */
function strict(options: LlmOptions | undefined): LlmOptions | undefined {
  return options?.keepTier ? { ...options, strictTier: true } : options;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function asLlmError(err: unknown, provider: string): LlmError {
  return err instanceof LlmError ? err : new LlmError(messageOf(err), provider, err);
}
