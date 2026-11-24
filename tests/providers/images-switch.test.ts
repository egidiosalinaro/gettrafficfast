import { afterEach, describe, expect, it, vi } from "vitest";
import { getImageProvider, imagesEnabled, setImageProvider } from "@/lib/providers/images/registry";
import { imageFailureKind } from "@/lib/providers/images/types";

/**
 * Images are on for every site by default, and the default provider runs on
 * the same key as the text models: the deployment's IMAGES_ENABLED is what
 * lets a render spend (CLAUDE.md, cost never switches itself on).
 */
describe("the deployment's image switch", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    setImageProvider("imagen", null);
  });

  it("refuses as not configured, before any provider is built, when the deployment has not opted in", () => {
    vi.stubEnv("IMAGES_ENABLED", "");
    expect(imagesEnabled()).toBe(false);
    let error: unknown = null;
    try {
      getImageProvider();
    } catch (err) {
      error = err;
    }
    expect(imageFailureKind(error)).toBe("not_configured");
  });

  it("hands over the provider once the deployment opted in", () => {
    vi.stubEnv("IMAGES_ENABLED", "1");
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    expect(imagesEnabled()).toBe(true);
    expect(getImageProvider()).toBeDefined();
    vi.stubEnv("IMAGES_ENABLED", "true");
    expect(imagesEnabled()).toBe(true);
  });
});
