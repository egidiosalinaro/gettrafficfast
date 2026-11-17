import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LEGACY_REDIRECTS } from "@/lib/legacy-redirects";

/**
 * Every old address of Results and Prompts keeps working (2026-11-14): one
 * entry each in the shared redirect list, served by next.config.ts before
 * the middleware (Next.js carries the query string across), temporary, and
 * no page left behind at the old path.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("old addresses", () => {
  it("send Results to Growth and Prompts to AI answers, its settings and a question's history", () => {
    for (const [source, destination] of [
      ["/results", "/growth"],
      ["/visibility", "/growth/ai"],
      ["/visibility/settings", "/growth/ai/settings"],
      ["/visibility/queries/:id", "/growth/ai/queries/:id"],
    ]) {
      expect(LEGACY_REDIRECTS).toContainEqual({ source, destination, permanent: false });
    }
    expect(readFileSync(path.join(root, "next.config.ts"), "utf8")).toContain("LEGACY_REDIRECTS");
  });

  it("leaves no page at the old paths, and the new ones exist", () => {
    for (const old of ["app/(app)/results", "app/(app)/visibility"]) expect(existsSync(path.join(root, old))).toBe(false);
    for (const page of ["app/(app)/growth/page.tsx", "app/(app)/growth/ai/page.tsx", "app/(app)/growth/ai/settings/page.tsx", "app/(app)/growth/ai/queries/[id]/page.tsx"]) {
      expect(existsSync(path.join(root, page)), page).toBe(true);
    }
  });
});
