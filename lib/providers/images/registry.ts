import { GoogleImageProvider } from "./google";
import { OpenAiImageProvider } from "./openai";
import { ImageProvider, ImageProviderError } from "./types";

/**
 * Resolves an image provider. A business may pin one in its media settings;
 * otherwise the platform default (IMAGE_PROVIDER, default imagen) applies.
 * The only place an image vendor is named.
 */

const cache = new Map<string, ImageProvider>();

export function getImageProvider(preferred?: string | null): ImageProvider {
  const name = (preferred || process.env.IMAGE_PROVIDER || "imagen").toLowerCase();
  const cached = cache.get(name);
  if (cached) return cached;

  let provider: ImageProvider;
  switch (name) {
    case "imagen":
      provider = new GoogleImageProvider(process.env.GEMINI_API_KEY ?? "");
      break;
    case "openai":
      provider = new OpenAiImageProvider(process.env.OPENAI_API_KEY ?? "");
      break;
    default:
      throw new ImageProviderError(`Unknown image provider: ${name}`, name);
  }
  cache.set(name, provider);
  return provider;
}

/** Test seam. */
export function setImageProvider(name: string, provider: ImageProvider | null): void {
  if (provider) cache.set(name, provider);
  else cache.delete(name);
}
