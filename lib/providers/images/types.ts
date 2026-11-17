/**
 * The image-generation boundary. Nothing above this layer names a vendor:
 * callers describe the picture, the provider renders it.
 */

export type ImageAspectRatio = "16:9" | "4:3" | "1:1";
export type ImageQuality = "standard" | "high";

export interface ImageRequest {
  /** Full prompt — scene plus style directives, composed upstream. */
  prompt: string;
  aspectRatio: ImageAspectRatio;
  quality: ImageQuality;
  signal?: AbortSignal;
}

export interface GeneratedImage {
  /** Raw image bytes, ready for storage. Never a provider-hosted URL: those expire. */
  bytes: Uint8Array;
  mimeType: string;
  provider: string;
  model: string;
  /** Estimated cost of this render, for per-business attribution. */
  costUsd: number;
}

export interface ImageProvider {
  readonly name: string;
  generate(request: ImageRequest): Promise<GeneratedImage>;
}

export type ImageFailureKind = "billing" | "not_configured" | "error";

export class ImageProviderError extends Error {
  /** HTTP status of the refused call, when there was one. */
  readonly status: number | null;
  /** True when no key is set for this provider: nothing was called. */
  readonly notConfigured: boolean;

  constructor(
    message: string,
    readonly provider: string,
    readonly cause?: unknown,
    options?: { status?: number; notConfigured?: boolean }
  ) {
    super(message);
    this.name = "ImageProviderError";
    this.status = options?.status ?? null;
    this.notConfigured = options?.notConfigured ?? false;
  }
}

/**
 * The account behind the image provider cannot pay. A 402 says so outright;
 * the vendors also say it in the body of other statuses (a depleted prepaid
 * balance, a hard billing limit, an exhausted quota that is a billing state).
 */
const BILLING_BODY =
  /credits are depleted|prepayment credits|payment required|billing_hard_limit_reached|billing_not_active|insufficient_quota|credit balance is too low/i;

/**
 * What kind of failure this is, for the caller that has to decide between
 * "try the next image" and "stop spending attempts for an hour". Anything
 * that is not an image-provider error is a plain error.
 */
export function imageFailureKind(err: unknown): ImageFailureKind {
  if (!(err instanceof ImageProviderError)) return "error";
  if (err.notConfigured) return "not_configured";
  if (err.status === 402 || BILLING_BODY.test(err.message)) return "billing";
  return "error";
}
