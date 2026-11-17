import {
  GeneratedImage,
  ImageProvider,
  ImageProviderError,
  ImageRequest,
} from "./types";

/**
 * OpenAI image generation (gpt-image-1 by default). Optional: only available
 * when OPENAI_API_KEY is configured.
 */

const MODEL = process.env.IMAGE_MODEL_OPENAI || "gpt-image-1";

/** The API takes pixel sizes, not ratios. */
const SIZES: Record<ImageRequest["aspectRatio"], string> = {
  "16:9": "1536x1024",
  "4:3": "1536x1024",
  "1:1": "1024x1024",
};

/** Attribution estimate per image at the sizes above. */
const COST_USD: Record<ImageRequest["quality"], number> = {
  standard: 0.06,
  high: 0.25,
};

export class OpenAiImageProvider implements ImageProvider {
  readonly name = "openai";

  constructor(private readonly apiKey: string) {
    if (!apiKey) throw new ImageProviderError("OPENAI_API_KEY is not set", "openai", undefined, { notConfigured: true });
  }

  async generate(request: ImageRequest): Promise<GeneratedImage> {
    const response = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        prompt: request.prompt,
        n: 1,
        size: SIZES[request.aspectRatio],
        quality: request.quality === "high" ? "high" : "medium",
      }),
      signal: request.signal ?? null,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new ImageProviderError(
        `OpenAI image request failed (${response.status}): ${body.slice(0, 300)}`,
        "openai",
        undefined,
        { status: response.status }
      );
    }

    const data = (await response.json()) as { data?: { b64_json?: string }[] };
    const b64 = data.data?.[0]?.b64_json;
    if (!b64) {
      throw new ImageProviderError("OpenAI returned no image data", "openai");
    }

    return {
      bytes: Uint8Array.from(Buffer.from(b64, "base64")),
      mimeType: "image/png",
      provider: this.name,
      model: MODEL,
      costUsd: COST_USD[request.quality],
    };
  }
}
