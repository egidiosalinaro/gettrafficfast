import {
  GeneratedImage,
  ImageProvider,
  ImageProviderError,
  ImageQuality,
  ImageRequest,
} from "./types";

/**
 * Google image generation, via the same Generative Language API key the LLM
 * provider uses — no extra credential to configure.
 *
 * It calls `generateContent` on the `gemini-*-image` models. The older
 * `imagen-*:predict` endpoint this file used to target no longer exists, which
 * is why not a single image was ever produced in production: every render
 * 404'd and degraded to "media skipped", exactly the failure GETTRAFFICFAST-1
 * was for the text models.
 *
 * So resilience is the same as over there:
 *  1. a STATIC chain of current, priced, test-pinned model names;
 *  2. the next model is tried ONLY when the failure says the model is
 *     unavailable — an auth, quota or safety refusal fails fast instead of
 *     spending three times to fail three times.
 *
 * A billed key is still required: image generation is not on the free tier.
 */

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * Static chain by quality tier. tests/providers/image-models.test.ts pins that
 * no retired name reappears and that every entry is priced.
 */
export const DEFAULT_IMAGE_MODELS: Record<ImageQuality, string> = {
  standard: process.env.IMAGE_MODEL_GEMINI || "gemini-3.1-flash-image",
  high: process.env.IMAGE_MODEL_GEMINI_HIGH || "gemini-3-pro-image",
};

/** Tried in order after the tier's default, when a model is unavailable. */
export const IMAGE_FALLBACKS = ["gemini-3.1-flash-image", "gemini-2.5-flash-image"];

/**
 * Published USD per generated image. Approximate and vendor-published — kept
 * so cost can be attributed per business; an estimate, not billing truth.
 */
export const IMAGE_PRICES: Record<string, number> = {
  "gemini-3-pro-image": 0.134,
  "gemini-3.1-flash-image": 0.039,
  "gemini-3.1-flash-lite-image": 0.02,
  "gemini-2.5-flash-image": 0.039,
};

/** Exact price when known, family estimate otherwise: never silently zero. */
function costOf(model: string): number {
  return IMAGE_PRICES[model] ?? (model.includes("pro") ? 0.134 : 0.039);
}

/** The models to try for this request, best first, without duplicates. */
export function imageModelsFor(quality: ImageQuality): string[] {
  return [...new Set([DEFAULT_IMAGE_MODELS[quality], ...IMAGE_FALLBACKS])];
}

/**
 * True when the failure is "this model is not available to this key" — the
 * only failure another model can fix.
 */
function isModelUnavailable(status: number, body: string): boolean {
  if (status === 404) return true;
  return status === 400 && /not found|not supported|NOT_FOUND/i.test(body);
}

interface GeminiImagePart {
  inlineData?: { mimeType?: string; data?: string };
  text?: string;
}

export class GoogleImageProvider implements ImageProvider {
  /** Stable provider id: it is stored in per-business media settings. */
  readonly name = "imagen";

  constructor(private readonly apiKey: string) {
    if (!apiKey) throw new ImageProviderError("GEMINI_API_KEY is not set", "imagen", undefined, { notConfigured: true });
  }

  async generate(request: ImageRequest): Promise<GeneratedImage> {
    let lastError = "no model was tried";

    for (const model of imageModelsFor(request.quality)) {
      // Key in a header, not the URL: URLs end up in logs and error messages.
      const response = await fetch(`${ENDPOINT}/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: request.prompt }] }],
          generationConfig: {
            responseModalities: ["IMAGE"],
            imageConfig: { aspectRatio: request.aspectRatio },
          },
        }),
        signal: request.signal ?? null,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        lastError = `${model} (${response.status}): ${body.slice(0, 300)}`;
        if (isModelUnavailable(response.status, body)) continue;
        throw new ImageProviderError(`Image generation failed — ${lastError}`, "imagen", undefined, {
          status: response.status,
        });
      }

      const data = (await response.json()) as {
        candidates?: Array<{ content?: { parts?: GeminiImagePart[] } }>;
      };
      const parts = data.candidates?.[0]?.content?.parts ?? [];
      const image = parts.find((part) => part.inlineData?.data);

      if (!image?.inlineData?.data) {
        // A text-only answer is the model declining (usually safety). Another
        // model would decline too, so this is not a fallback case.
        const explanation = parts.find((part) => part.text)?.text ?? "no image data";
        throw new ImageProviderError(
          `${model} returned no image: ${explanation.slice(0, 300)}`,
          "imagen"
        );
      }

      return {
        bytes: Uint8Array.from(Buffer.from(image.inlineData.data, "base64")),
        mimeType: image.inlineData.mimeType || "image/png",
        provider: this.name,
        model,
        costUsd: costOf(model),
      };
    }

    throw new ImageProviderError(
      `No available image model — last error: ${lastError}`,
      "imagen"
    );
  }
}
