import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Regression: the viewport covers the screen (`viewportFit: "cover"`, added
 * so the tab bar clears the home indicator), and nothing kept content out of
 * the top inset. As a home-screen app on an iPhone the clock was drawn over
 * the Replies filters. The body is padded by the insets, and a strip in the
 * page's colour covers the top inset for whatever scrolls under it. Every
 * inset is 0 on a desktop, so the desktop layout does not move.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = (relativePath: string) => readFileSync(path.join(root, relativePath), "utf8");

describe("safe area", () => {
  const css = source("app/globals.css");
  const body = css.match(/\n {2}body \{[^}]*\}/)?.[0] ?? "";
  const strip = css.match(/body::before \{[^}]*\}/)?.[0] ?? "";

  it("is still covered by the viewport, which is why the insets matter", () => {
    expect(source("app/layout.tsx")).toContain('viewportFit: "cover"');
  });

  it("pads the body by the top, left and right insets", () => {
    expect(body).toContain("padding-top: env(safe-area-inset-top)");
    expect(body).toContain("padding-left: env(safe-area-inset-left)");
    expect(body).toContain("padding-right: env(safe-area-inset-right)");
  });

  it("covers the top inset with the page's colour, under sheets and dialogs", () => {
    expect(strip).toContain("position: fixed");
    expect(strip).toContain("height: env(safe-area-inset-top)");
    expect(strip).toContain("background-color: hsl(var(--background))");
    expect(strip).toContain("pointer-events: none");
    const z = Number(strip.match(/z-index: (\d+)/)?.[1]);
    expect(z).toBeGreaterThan(40); // over the tab bar and sticky headers
    expect(z).toBeLessThan(50); // under sheets and dialogs
  });

  it("keeps the shell one screen tall minus the inset, and fixed columns and sticky tabs clear of it", () => {
    const shell = source("app/(app)/layout.tsx");
    // Phone: exactly one screen tall, so only the app's own area scrolls.
    expect(shell).toContain("h-[calc(100dvh-env(safe-area-inset-top))] flex-col overflow-hidden");
    expect(shell).toContain("md:min-h-[calc(100vh-env(safe-area-inset-top))]");
    // The phone's site row scrolls with the page, above it; then the page.
    expect(shell).toMatch(/<AppScroll>[\s\S]*<MobileSiteBar[\s\S]*\{children\}\s*<\/AppScroll>/);
    const sidebar = source("components/dashboard/sidebar.tsx");
    expect(sidebar).toContain("pt-[env(safe-area-inset-top)]");
    expect(sidebar).toContain("w-[calc(12rem+env(safe-area-inset-left))] pl-[env(safe-area-inset-left)]");
    const settings = source("components/dashboard/settings-submenu.tsx");
    // The desktop column is fixed to the top: its own padding clears the inset.
    expect(settings).toContain("top-0 hidden h-screen w-56 pt-[env(safe-area-inset-top)]");
    expect(settings).toContain("left-[calc(12rem+env(safe-area-inset-left))]");
    const nav = source("components/dashboard/mobile-nav.tsx");
    expect(nav).toContain("pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]");
  });
});

describe("the phone's scrolling area", () => {
  const scroll = source("components/dashboard/app-scroll.tsx");

  it("scrolls between the top and the tab bar, and is not there from md up", () => {
    expect(scroll).toContain("min-h-0 min-w-0 flex-1 flex-col overflow-y-auto");
    expect(scroll).toContain("md:contents");
  });

  it("starts a new page at its top", () => {
    expect(scroll).toContain("usePathname()");
    expect(scroll).toContain("scrollTo({ top: 0 })");
  });
});

describe("typing on a phone", () => {
  const css = source("app/globals.css");

  it("keeps every typed field at 16px below md, so iOS does not zoom in on tap", () => {
    const block = css.match(/@media \(max-width: 767px\) \{[^@]*?font-size: 16px !important;/)?.[0] ?? "";
    expect(block).toContain("textarea");
    expect(block).toContain("select");
    expect(block).toContain('input:not([type="checkbox"])');
  });

  it("does not stop pinch zoom", () => {
    const layout = source("app/layout.tsx");
    expect(layout).not.toMatch(/maximumScale|userScalable/);
  });
});
