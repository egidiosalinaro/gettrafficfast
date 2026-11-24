import { GoogleImageProvider } from "./google";
import { OpenAiImageProvider } from "./openai";
import { ImageProvider, ImageProviderError } from "./types";

/**
 * Resolves an image provider. A business may pin one in its media settings;
 * otherwise the platform default (IMAGE_PROVIDER, default imagen) applies.
 * The only place an image vendor is named.
 *
 * Images are on for every site by default (2026-11-24), and the default
 * provider runs on the same key as the text models, so the key alone must
 * not start spending: the deployment opts in with IMAGES_ENABLED=1
 * (CLAUDE.md, cost never switches itself on). Without it every render is
 * skipped as not configured, before anything is paid.
 */

/** True when the deployment has opted in to generating images. */
export function imagesEnabled(): boolean {
  const value = (process.env.IMAGES_ENABLED ?? "").trim().toLowerCase();
  return value === "1" || value === "true";
}

const cache = new Map<string, ImageProvider>();

export function getImageProvider(preferred?: string | null): ImageProvider {
  if (!imagesEnabled()) {
    throw new ImageProviderError("Images are off for this deployment (IMAGES_ENABLED is not set).", "none", undefined, {
      notConfigured: true,
    });
  }
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
