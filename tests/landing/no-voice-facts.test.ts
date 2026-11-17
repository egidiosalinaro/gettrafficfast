import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The owner's decision of 12 November 2026: the public site and the articles
 * state only true things, and may leave weak results out. About you holds
 * candid early numbers for replies ("9 to 342 impressions, 0 clicks"); none
 * of it may reach a public page by being read there. A cheap guard: the
 * landing and pricing sources never import the voice
 * settings or read `voice_settings`.
 */

const root = path.resolve(__dirname, "../..");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return files(full);
    return /\.(tsx?|mdx?)$/.test(name) ? [full] : [];
  });
}

const PUBLIC_SOURCES = [
  path.join(root, "app/page.tsx"),
  ...files(path.join(root, "app/pricing")),
  ...files(path.join(root, "components/landing")),
];

describe("the public pages never read the voice settings", () => {
  it("has sources to check", () => {
    expect(PUBLIC_SOURCES.length).toBeGreaterThan(10);
  });

  for (const file of PUBLIC_SOURCES) {
    it(path.relative(root, file), () => {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/voice_settings|lib\/voice\/|aboutYou|articleFacts/);
    });
  }
});
