import { safeFetch } from "../safe-fetch";
import { LLM_IMAGE_TYPES, type LlmImage, type LlmImageType } from "./types";

/**
 * Images for a model call, fetched before the call.
 *
 * Both providers of this layer read an image as bytes beside the prompt
 * (Claude: a base64 `image` block; Gemini: an `inlineData` part), so the
 * bytes are fetched here, once, and an image that cannot be fetched (403,
 * timeout, too large, not an image) is known before anything is paid: the
 * caller drafts without it and records that it did. It never throws.
 *
 * The URL comes from a source this platform read (a post's media), not from
 * a person, but it is still fetched through `safeFetch`: public addresses
 * only, a deadline, and a size ceiling.
 */

/** Long enough for a CDN, short enough that a draft does not wait on a picture. */
export const IMAGE_FETCH_TIMEOUT_MS = 8_000;

/**
 * Claude refuses an image over 5 MB in base64, which is about 3.75 MB of
 * bytes; Gemini's inline limit is higher. The smaller one decides.
 */
export const MAX_IMAGE_BYTES = 3_750_000;

export type ImageFetchFailure = "http" | "timeout" | "too_large" | "not_an_image" | "unreachable";

export type ImageFetchResult = { ok: true; image: LlmImage } | { ok: false; reason: ImageFetchFailure; detail: string };

type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

const defaultFetch: FetchImpl = (url, init) =>
  safeFetch(url, init, { timeoutMs: IMAGE_FETCH_TIMEOUT_MS, maxBytes: MAX_IMAGE_BYTES + 1 });

/** The image type of `bytes` by their first bytes, or null. The header is a hint; the bytes decide. */
export function sniffImageType(bytes: Uint8Array): LlmImageType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

/** One image as model input, or why not. */
export async function fetchLlmImage(
  url: string,
  options: { fetchImpl?: FetchImpl; signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<ImageFetchResult> {
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? IMAGE_FETCH_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { Accept: LLM_IMAGE_TYPES.join(",") }, signal });
  } catch (err) {
    const timedOut = timeout.aborted || (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError"));
    return {
      ok: false,
      reason: timedOut ? "timeout" : "unreachable",
      detail: timedOut ? "the image did not load in time" : "the image could not be reached",
    };
  }
  if (!response.ok) return { ok: false, reason: "http", detail: `the image answered ${response.status}` };
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch {
    return { ok: false, reason: "too_large", detail: "the image could not be read whole" };
  }
  if (bytes.length > MAX_IMAGE_BYTES) return { ok: false, reason: "too_large", detail: "the image is too large to send" };
  const mimeType = sniffImageType(bytes);
  if (!mimeType) return { ok: false, reason: "not_an_image", detail: "the file is not an image a model reads" };
  return { ok: true, image: { mimeType, data: Buffer.from(bytes).toString("base64") } };
}

/** Several images, in order, at once; each one's own result. */
export async function fetchLlmImages(
  urls: readonly string[],
  options: { fetchImpl?: FetchImpl; signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<ImageFetchResult[]> {
  return Promise.all(urls.map((url) => fetchLlmImage(url, options)));
}
