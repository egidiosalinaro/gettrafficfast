import { describe, expect, it } from "vitest";
import {
  DEFAULT_IMAGE_MODELS,
  IMAGE_FALLBACKS,
  IMAGE_PRICES,
  imageModelsFor,
} from "@/lib/providers/images/google";

/**
 * The image provider pointed at `imagen-3.0-generate-002:predict` — an
 * endpoint Google removed. Every render 404'd and degraded to "media skipped",
 * so the feature looked enabled and produced nothing for months. Same failure
 * class as GETTRAFFICFAST-1: model names are config that rots.
 */

const RETIRED = [
  "imagen-3.0-generate-001",
  "imagen-3.0-generate-002",
  "imagen-3.0-fast-generate-001",
  "imagegeneration",
];

describe("image model chain", () => {
  it("never references a retired model name", () => {
    for (const model of [...Object.values(DEFAULT_IMAGE_MODELS), ...IMAGE_FALLBACKS]) {
      expect(RETIRED).not.toContain(model);
    }
  });

  it("only picks models served by generateContent, not the removed predict API", () => {
    for (const model of [...Object.values(DEFAULT_IMAGE_MODELS), ...IMAGE_FALLBACKS]) {
      expect(model.startsWith("gemini-"), `${model} is not a gemini image model`).toBe(true);
      expect(model).toContain("image");
    }
  });

  it("prices every model it can pick, so cost attribution never silently zeroes", () => {
    for (const model of [...Object.values(DEFAULT_IMAGE_MODELS), ...IMAGE_FALLBACKS]) {
      expect(IMAGE_PRICES[model], `missing price for ${model}`).toBeDefined();
      expect(IMAGE_PRICES[model]).toBeGreaterThan(0);
    }
  });

  it("tries the tier's model first, then distinct fallbacks", () => {
    const standard = imageModelsFor("standard");
    expect(standard[0]).toBe(DEFAULT_IMAGE_MODELS.standard);
    expect(new Set(standard).size).toBe(standard.length);

    const high = imageModelsFor("high");
    expect(high[0]).toBe(DEFAULT_IMAGE_MODELS.high);
    expect(high.length).toBeGreaterThan(1);
  });
});
