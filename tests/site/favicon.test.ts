import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Regression, twice over. First the only icons carried a media query and no
 * crawler found one. Then unconditional icons were added, the black mark on
 * transparent, and a dark browser picked those over the dark variant and
 * drew nothing. Now: one SVG that adapts by itself, and one .ico on a tile
 * for whatever cannot adapt.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const file = (name: string) => readFileSync(path.join(root, "public", name));

describe("favicon", () => {
  it("declares the tile .ico at 32x32 and the adaptive SVG, and nothing with a media attribute", () => {
    // Read as text: app/layout.tsx loads a font, which a test cannot import.
    const layout = readFileSync(path.join(root, "app/layout.tsx"), "utf8");
    const icons = layout.slice(layout.indexOf("  icons: {"), layout.indexOf("};", layout.indexOf("  icons: {")));
    expect(icons).toContain('{ url: "/favicon.ico", sizes: "32x32" }');
    expect(icons).toContain('{ url: "/icon.svg", type: "image/svg+xml" }');
    expect(icons).toContain('apple: [{ url: "/apple-icon.png", sizes: "180x180" }]');
    expect(icons).not.toContain("media:");
    expect(icons).not.toContain('sizes: "any"');
    expect(icons.match(/url:/g)).toHaveLength(3);
  });

  it("serves an SVG that is black by default and white on a dark browser", () => {
    const svg = file("icon.svg").toString("utf8");
    expect(svg).toContain("path{fill:#000}");
    expect(svg).toContain("@media (prefers-color-scheme:dark){path{fill:#fff}}");
    // Self-contained: an SVG used as an icon may not load anything.
    expect(svg).not.toMatch(/href=|url\(/);
  });

  it("serves the files it declares, and no longer the two it replaced", () => {
    for (const name of ["favicon.ico", "icon.svg", "icon.png", "apple-icon.png"]) {
      expect(file(name).length).toBeGreaterThan(500);
    }
    expect(() => file("favicon-light.png")).toThrow();
    expect(() => file("favicon-dark.png")).toThrow();
  });

  it("draws the tile icons on an opaque black ground, so they show on any background", () => {
    // PNG: the IHDR colour type at byte 25 is 2 (RGB, no alpha) for the
    // home-screen icon, which iOS would otherwise fill with black anyway.
    expect(file("apple-icon.png")[25]).toBe(2);
    // ICO: three sizes, 16, 32 and 48.
    const ico = file("favicon.ico");
    expect(ico.readUInt16LE(4)).toBe(3);
  });
});
