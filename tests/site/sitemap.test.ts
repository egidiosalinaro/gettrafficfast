import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LEGACY_REDIRECTS } from "@/lib/legacy-redirects";

/**
 * Regression, 2026-11-12: Search Console reported "Page with redirect" for
 * gettrafficfa.st. The sitemap listed a page that only redirected. A
 * sitemap lists pages that answer 200, never a redirect, and internal links
 * point at the target, not at the redirect.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = (file: string) => readFileSync(path.join(root, file), "utf8");

/** Pages under app/ whose page.tsx only redirects. */
function redirectingRoutes(): string[] {
  const found: string[] = [];
  const walk = (dir: string, route: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith("(") || entry.name.startsWith("[") || entry.name.startsWith("_") || entry.name === "api") continue;
      const sub = path.join(dir, entry.name);
      const next = `${route}/${entry.name}`;
      try {
        const page = readFileSync(path.join(sub, "page.tsx"), "utf8");
        if (/\b(permanentRedirect|redirect)\(/.test(page) && !/<\w/.test(page)) found.push(next);
      } catch {
        // no page here
      }
      walk(sub, next);
    }
  };
  walk(path.join(root, "app"), "");
  return found;
}

describe("sitemap", () => {
  const sitemap = source("app/sitemap.ts");

  it("lists no route that only redirects", () => {
    for (const route of redirectingRoutes()) {
      expect(sitemap).not.toContain("`${baseUrl}" + route + "`");
    }
  });

  it("lists no address that lib/legacy-redirects.ts sends elsewhere", () => {
    for (const { source: old } of LEGACY_REDIRECTS) {
      expect(sitemap).not.toContain("`${baseUrl}" + old + "`");
    }
  });
});

describe("the removed Citation Index (2026-11-16)", () => {
  it("sends its old addresses home, permanently, so shared links and search results do not 404", () => {
    for (const source of ["/citation-index", "/citation-index/:path*", "/check"]) {
      expect(LEGACY_REDIRECTS).toContainEqual({ source, destination: "/", permanent: true });
    }
  });

  it("leaves no page, API route or cron behind", () => {
    for (const old of [
      "app/citation-index",
      "app/check",
      "app/api/check",
      "app/api/cron/ingest-citation-index",
      "app/api/cron/classify-citation-index",
      "app/api/cron/probe-citation-index",
      "lib/study",
    ]) {
      expect(existsSync(path.join(root, old)), old).toBe(false);
    }
    expect(source("vercel.json")).not.toContain("citation-index");
  });
});
