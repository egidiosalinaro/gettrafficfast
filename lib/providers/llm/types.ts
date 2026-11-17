import type { z } from "zod";

/**
 * The LLM boundary.
 *
 * Nothing above this layer names a model vendor. Agents ask for text or for a
 * validated structure; which provider and which model serve the request is
 * configuration, not code.
 */

/**
 * Capability tier rather than a model name: agents declare how hard their task
 * is, and the provider maps that onto a concrete model. Routing a cheap model
 * to extraction and a strong one to writing is then a config change.
 */
export type LlmTier = "fast" | "quality";

export interface LlmUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** The provider that answered. Absent on rows recorded before 2026-11-10. */
  provider?: string;
  /**
   * True when the answer did not come from the model the tier is configured
   * for: the provider stepped down its own chain, or the second provider
   * answered. Recorded, never hidden: on 2026-11-10 most "quality" articles
   * turned out to have been written by the fast model and nothing said so.
   */
  fallback?: boolean;
  /** True when a "quality" request was answered by a model outside the quality family. */
  tierDowngraded?: boolean;
}

export interface LlmTextResult {
  text: string;
  usage: LlmUsage;
}

export interface LlmStructuredResult<T> {
  value: T;
  usage: LlmUsage;
  /** The raw response, kept for diagnostics when validation is the issue. */
  raw: string;
}

/**
 * How much the model may reason before it answers, where the model reasons
 * by default. "default" leaves the vendor's own setting; "low" asks for a
 * small budget, for a short output whose quality does not come from long
 * reasoning (a reply under a post). A provider that has no such control
 * ignores it.
 */
export type LlmThinking = "low" | "default";

/** The image formats every provider of this layer reads. */
export const LLM_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
export type LlmImageType = (typeof LLM_IMAGE_TYPES)[number];

/**
 * One image the model reads beside the prompt: the bytes, base64, and their
 * type. Bytes rather than a URL because both providers take bytes, and
 * because an image that cannot be fetched has to be known before the call
 * (the caller records it), not discovered as a failed call. Fetched with
 * `fetchLlmImage` (./images.ts).
 */
export interface LlmImage {
  mimeType: LlmImageType;
  /** Base64, no `data:` prefix. */
  data: string;
}

export interface LlmOptions {
  tier?: LlmTier;
  temperature?: number;
  maxOutputTokens?: number;
  thinking?: LlmThinking;
  signal?: AbortSignal;
  /**
   * Images the model reads with the prompt, placed before the text. Billed
   * as input tokens (a few hundred to about 1,600 per image, by its size).
   * Empty or absent: a text-only call, exactly as before.
   */
  images?: readonly LlmImage[];
  /**
   * What an agent sets when its work must stay on quality models: with a
   * second provider configured, a "quality" request the first provider's
   * quality family cannot serve goes to the second provider's quality model
   * instead of the first provider's fast one. With one provider alone there
   * is nobody to hand over to, so its own chain stays the net and the
   * step-down is recorded on the usage (`fallback`, `tierDowngraded`).
   */
  keepTier?: boolean;
  /**
   * Set by the fallback layer, never by an agent: the provider fails rather
   * than answer a quality request outside its quality family. It is how
   * `keepTier` is carried out once somebody stands behind the provider.
   */
  strictTier?: boolean;
}

/**
 * Who is asking. A role may be routed to its own primary provider by
 * environment (`LLM_<ROLE>_PROVIDER`) while everything else stays on the
 * default; callers name the role, never a vendor.
 */
export type LlmRole = "writer";

/**
 * The provider a production job was given for the day
 * (`LLM_ARTICLE_ROTATION`, lib/providers/llm/registry.ts). Chosen once per
 * job and carried by the job, so every agent of one article asks the same
 * provider first. A name to callers, never a vendor they know about.
 */
export interface LlmArm {
  /** The provider of the day; null when no rotation is configured. */
  arm: string | null;
  /** The UTC day the arm was chosen on, YYYY-MM-DD. */
  day?: string;
  /** The rotation as it was configured that day. */
  rotation?: string[];
}

export interface LLMProvider {
  readonly name: string;
  generateText(prompt: string, options?: LlmOptions): Promise<LlmTextResult>;
  /**
   * Generates a value satisfying `schema`. Implementations must validate before
   * returning: a response that does not match is a failure, never a partial
   * result the caller has to second-guess.
   */
  generateStructured<T>(
    prompt: string,
    schema: z.ZodType<T>,
    options?: LlmOptions
  ): Promise<LlmStructuredResult<T>>;
}

export class LlmError extends Error {
  /**
   * False when retrying cannot succeed: the key is missing, or the account
   * refused the call (auth or billing). A schema miss and a retired model
   * name stay retryable, because the next attempt or the next model can
   * still produce a result.
   */
  readonly retryable: boolean;
  /**
   * Billing exhaustion is an account state, not a defect. Reporting it on
   * every cron turns one depleted balance into a standing Sentry issue.
   */
  readonly report: boolean;
  /**
   * The providers whose accounts refused to pay for this call, when that
   * refusal is the whole outcome: one provider refused and there was no
   * fallback, or the primary and the fallback both refused. Empty for every
   * other failure, including a refused primary behind a fallback that failed
   * some other way. Non-empty is what pauses LLM work and alerts the operator
   * (`lib/llm-billing.ts`); the layer itself never decides that.
   */
  readonly billingRefused: readonly string[];

  constructor(
    message: string,
    readonly provider: string,
    readonly cause?: unknown,
    options?: { retryable?: boolean; report?: boolean; billingRefused?: readonly string[] }
  ) {
    super(message);
    this.name = "LlmError";
    this.retryable = options?.retryable ?? true;
    this.report = options?.report ?? true;
    this.billingRefused = options?.billingRefused ?? [];
  }
}

/** True when every provider asked refused because its account cannot pay. */
export function isLlmBillingRefusal(err: unknown): err is LlmError {
  return err instanceof LlmError && err.billingRefused.length > 0;
}

/** The provider refused because the account cannot pay, not because the call was bad. */
export function isProviderBillingFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const status =
    typeof err === "object" && err !== null && "status" in err && typeof (err as { status: unknown }).status === "number"
      ? (err as { status: number }).status
      : null;
  const payment = /payment required|credits are depleted|prepayment credits/i.test(message);
  return payment && (status === 402 || /\b402\b/.test(message) || /billing/i.test(message));
}

/**
 * What kind of failure a stored LLM error message records, read from the
 * sentences the providers in this layer write (Gemini's "credits are
 * depleted", Claude's "the account cannot pay", the vendor's own "credit
 * balance is too low", a timeout, a call that failed, a missing key, and the
 * fallback's "failed too"). Callers above this layer show a sentence of their
 * own and never the vendor's: "billing" is an account that cannot pay,
 * "unavailable" a provider that did not answer or is not set up, null
 * anything else (a validation error, a step's own sentence). Billing wins
 * when both are present: a fallback that timed out behind a depleted primary
 * is still a balance to top up.
 */
export type LlmFailureKind = "billing" | "unavailable";

export function llmFailureKind(message: string | null | undefined): LlmFailureKind | null {
  const text = message ?? "";
  if (/credits are depleted|prepayment credits|account cannot pay|credit balance is too low|payment required/i.test(text)) {
    return "billing";
  }
  if (/did not answer in time|request failed:|_API_KEY is not set|Unknown LLM provider|The fallback failed too/i.test(text)) {
    return "unavailable";
  }
  return null;
}
