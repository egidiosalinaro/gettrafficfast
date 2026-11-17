import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import manifest from "@/app/manifest";
import { isPublicPath } from "@/lib/public-paths";
import { APP_BACKGROUND, SITE_NAME } from "@/lib/site";

/**
 * The home-screen app: it opens on Replies, full screen, under its own name,
 * with the icons that exist in public/. Its manifest must be readable without
 * a session, because browsers fetch it with credentials omitted.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = (relativePath: string) => readFileSync(path.join(root, relativePath), "utf8");

describe("web app manifest", () => {
  const m = manifest();

  it("names the app and opens it on Today, standalone", () => {
    expect(m.name).toBe("GetTrafficFast");
    expect(m.short_name).toBe("GetTrafficFast");
    expect(m.start_url).toBe("/today");
    expect(m.display).toBe("standalone");
  });

  it("uses the light theme's page colour: a manifest cannot follow the device's scheme", () => {
    // The theme-color meta tags do follow it (lib/theme.ts, tests/theme.test.tsx).
    expect(APP_BACKGROUND).toBe("#fafafa");
    expect(source("app/globals.css")).toContain("--background: 0 0% 98%;");
    expect(m.background_color).toBe(APP_BACKGROUND);
    expect(m.theme_color).toBe(APP_BACKGROUND);
  });

  it("points at icons that exist", () => {
    expect(m.icons).toEqual([
      { src: "/icon.png", sizes: "512x512", type: "image/png" },
      { src: "/apple-icon.png", sizes: "180x180", type: "image/png" },
    ]);
    for (const icon of m.icons ?? []) {
      expect(() => readFileSync(path.join(root, "public", icon.src))).not.toThrow();
    }
  });

  it("is served without a session", () => {
    expect(isPublicPath("/manifest.webmanifest")).toBe(true);
  });
});

describe("home-screen metadata", () => {
  const layout = source("app/layout.tsx");

  it("declares the iPhone home-screen app under the product's name", () => {
    expect(layout).toMatch(/appleWebApp: \{\s*capable: true,\s*title: SITE_NAME,\s*statusBarStyle: "default",/);
    expect(SITE_NAME).toBe("GetTrafficFast");
  });

  it("keeps the em dash out of the page title a phone may offer as the name", () => {
    const title = layout.match(/const TITLE = `([^`]*)`/)?.[1] ?? "";
    expect(title).toContain("${SITE_NAME}");
    expect(title).not.toContain("—");
  });
});
