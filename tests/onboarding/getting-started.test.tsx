import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { initialCollapsed, PILL_ATTRIBUTE } from "@/components/onboarding/getting-started";
import { ONBOARDING_STEPS } from "@/lib/onboarding";

/**
 * The Getting started widget starts as a pill on every device, and while the
 * pill shows it marks <html> so a phone's content keeps room above it
 * (tests/dashboard/mobile-nav.test.tsx checks the CSS side).
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = (relativePath: string) => readFileSync(path.join(root, relativePath), "utf8");

describe("Getting started widget", () => {
  it("starts collapsed when this device has no saved choice, whatever the screen", () => {
    expect(initialCollapsed(null)).toBe(true);
    expect(source("components/onboarding/getting-started.tsx")).not.toContain("matchMedia");
  });

  it("keeps the choice a person made on this device", () => {
    expect(initialCollapsed("1")).toBe(true);
    expect(initialCollapsed("")).toBe(false);
  });

  it("flags the pill on <html> with the attribute the CSS reads", () => {
    expect(PILL_ATTRIBUTE).toBe("data-getting-started-pill");
    expect(source("app/globals.css")).toContain(`:root[${PILL_ATTRIBUTE}] .pb-mobile-chrome`);
  });
});

describe("checklist copy", () => {
  it("names settings pages as the menu does, and keeps em dashes out", () => {
    const text = ONBOARDING_STEPS.map((step) => `${step.label} ${step.description}`).join(" ");
    // Nothing to turn on since 2026-11-24: Autopilot and images are on by default.
    expect(text).not.toMatch(/turn on/i);
    expect(text).not.toContain("Images & video");
    expect(text).not.toMatch(/\bGeneration\b/);
    expect(text).not.toMatch(/\bPlacements\b/);
    expect(text).not.toContain("—");
  });
});
