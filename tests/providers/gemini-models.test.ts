import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODELS,
  FALLBACKS,
  PRICES,
  isTerminalProviderFailure,
  isTextGenerationModel,
  orderCandidateModels,
} from "@/lib/providers/llm/gemini";

// GETTRAFFICFAST-1: every model in the chain (gemini-1.5-flash, gemini-1.5-pro,
// gemini-pro) had been retired by Google, so each attempt 404'd and article
// production died at the outline step. Model names are config that rots — these
// tests pin the invariants that made the outage silent.

const RETIRED = ["gemini-pro", "gemini-1.0-pro", "gemini-1.5-flash", "gemini-1.5-pro"];

describe("gemini model chain", () => {
  it("never references a retired model name", () => {
    for (const model of [...Object.values(DEFAULT_MODELS), ...FALLBACKS]) {
      expect(RETIRED).not.toContain(model);
    }
  });

  it("prices every model it can pick, so cost attribution never silently zeroes", () => {
    for (const model of [...Object.values(DEFAULT_MODELS), ...FALLBACKS]) {
      expect(PRICES[model], `missing price for ${model}`).toBeDefined();
      expect(PRICES[model].input).toBeGreaterThan(0);
      expect(PRICES[model].output).toBeGreaterThan(0);
    }
  });

  it("keeps a fallback that differs from each tier default", () => {
    for (const preferred of Object.values(DEFAULT_MODELS)) {
      expect(FALLBACKS.some((m) => m !== preferred)).toBe(true);
    }
  });

  it("does not treat a specialty or preview-only name as a text model", () => {
    expect(isTextGenerationModel("gemini-2.5-flash")).toBe(true);
    expect(isTextGenerationModel("gemini-2.5-pro")).toBe(true);
    expect(isTextGenerationModel("gemini-2.5-flash-lite")).toBe(true);
    expect(isTextGenerationModel("gemini-2.5-pro-preview")).toBe(true);
    // "preview" contains "pro". That substring must not admit a robotics model.
    expect(isTextGenerationModel("gemini-robotics-er-2-preview")).toBe(false);
    expect(isTextGenerationModel("gemini-embedding-001")).toBe(false);
    expect(isTextGenerationModel("gemini-2.5-flash-image")).toBe(false);
  });

  it("orders text models of the tier and drops everything else", () => {
    const available = [
      "gemini-robotics-er-2-preview",
      "gemini-2.5-flash-lite",
      "gemini-2.5-pro-preview",
      "gemini-embedding-001",
      "gemini-2.5-flash-image",
    ];

    const quality = orderCandidateModels("quality", available);
    expect(quality[0]).toBe(DEFAULT_MODELS.quality);
    expect(quality).not.toContain("gemini-robotics-er-2-preview");
    expect(quality).not.toContain("gemini-embedding-001");
    expect(quality).not.toContain("gemini-2.5-flash-image");
    expect(quality.indexOf("gemini-2.5-pro-preview")).toBeLessThan(
      quality.indexOf("gemini-2.5-flash-lite")
    );

    const fast = orderCandidateModels("fast", available);
    expect(fast[0]).toBe(DEFAULT_MODELS.fast);
    expect(fast.indexOf("gemini-2.5-flash-lite")).toBeLessThan(
      fast.indexOf("gemini-2.5-pro-preview")
    );
  });

  it("treats an account refusal as terminal and a retired name as not", () => {
    expect(
      isTerminalProviderFailure(
        new Error("[402 Payment Required] credits are depleted")
      )
    ).toBe(true);
    expect(isTerminalProviderFailure(new Error("[401 Unauthorized]"))).toBe(true);
    expect(isTerminalProviderFailure(new Error("[404 Not Found] models/gemini-pro"))).toBe(
      false
    );
  });
});
