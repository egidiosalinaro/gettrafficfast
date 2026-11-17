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
 * root layout and nowhere else. It is mounted by the cookie banner
 * (components/cookie-consent.tsx), only after the visitor accepts; the
 * behaviour is held by tests/site/cookie-consent.test.tsx. The website id
 * (NEXT_PUBLIC_DATAFAST_WEBSITE_ID) and the domain (the host of SITE_URL)
 * are the DataFast property; with no id neither banner nor script exists.
 */
describe("DataFast tracking script", () => {
  it("loads once, behind the consent banner the root layout mounts", () => {
    const layout = source("app/layout.tsx");
    expect(layout).not.toContain("datafa.st");
    expect(layout).toContain("<CookieConsent websiteId={ANALYTICS_WEBSITE_ID} domain={SITE_HOST} />");
    expect(layout).toContain("ANALYTICS_WEBSITE_ID ?");

    const banner = source("components/cookie-consent.tsx");
    expect(banner).toContain('from "next/script"');
    expect(banner).toContain('"https://datafa.st/js/script.js"');
    expect(banner).toContain("data-website-id={websiteId}");
    expect(banner).toContain("data-domain={domain}");
    expect(banner).toContain('strategy="afterInteractive"');
    expect(banner).toContain("analyticsAllowed(state) ?");

    expect(source("lib/cookie-consent.ts")).toContain("process.env.NEXT_PUBLIC_DATAFAST_WEBSITE_ID");

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
