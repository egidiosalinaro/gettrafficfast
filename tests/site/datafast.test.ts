import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function source(relativePath: string): string {
  return readFileSync(path.join(root, relativePath), "utf8");
}

/**
 * The tracking tag has to be on every page, which in the App Router means the
 * root layout and nowhere else. The website id (NEXT_PUBLIC_DATAFAST_WEBSITE_ID)
 * and the domain (the host of SITE_URL) are the DataFast property; with no id
 * the script is not loaded at all.
 */
describe("DataFast tracking script", () => {
  it("loads once, from the root layout, with the site id and domain", () => {
    const layout = source("app/layout.tsx");
    expect(layout).toContain('from "next/script"');
    expect(layout).toContain('src="https://datafa.st/js/script.js"');
    expect(layout).toContain("data-website-id={DATAFAST_WEBSITE_ID}");
    expect(layout).toContain("process.env.NEXT_PUBLIC_DATAFAST_WEBSITE_ID");
    expect(layout).toContain("data-domain={SITE_HOST}");
    expect(layout).toContain('strategy="afterInteractive"');

    const appShell = source("app/(app)/layout.tsx");
    expect(appShell).not.toContain("datafa.st");
  });

  it("names DataFast in the privacy policy", () => {
    // The policy prints the providers of lib/legal.ts (tests/legal-pages.test.tsx).
    const providers = source("lib/legal.ts");
    expect(providers).toContain('name: "DataFast"');
    expect(providers).toContain("Visitor analytics for the gettrafficfa.st website");
    expect(source("app/privacy-policy/page.tsx")).toContain("measured with DataFast");
  });

  it("keeps datafa.st allowed if a Content-Security-Policy appears", () => {
    const files = ["next.config.ts", "vercel.json", "middleware.ts", "lib/supabase/middleware.ts"];
    for (const file of files) {
      const text = source(file);
      const hasCsp = /content-security-policy/i.test(text) || /script-src/.test(text);
      if (!hasCsp) continue;
      expect(text, file).toContain("https://datafa.st");
    }
  });
});
