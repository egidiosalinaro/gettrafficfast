import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FileText, Inbox, SlidersVertical, TrendingUp } from "lucide-react";

const nav = vi.hoisted(() => ({ pathname: "/today" }));

vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));

import {
  ACCOUNT_HREF,
  DOCS_HREF,
  appNav,
  isNavActive,
} from "@/components/dashboard/nav";
import { MobileNav, MobileSiteBar } from "@/components/dashboard/mobile-nav";
import { DashboardSidebar } from "@/components/dashboard/sidebar";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = (relativePath: string) =>
  readFileSync(path.join(root, relativePath), "utf8");

/** Every item lit for `pathname`, by title. */
const lit = (pathname: string | null) =>
  appNav.filter((item) => isNavActive(item, pathname)).map((item) => item.title);

const sites = [
  { id: "b-gtf", name: "GetTrafficFast", website_url: "https://gettrafficfa.st" },
  { id: "b-postwren", name: "Postwren", website_url: "https://www.postwren.com" },
];

/**
 * 2026-11-14: nine entries (Overview, Replies, Articles, Keywords, Prompts,
 * Results, Settings, Help, Contact Us) and a phone "More" sheet became four
 * sections. The owner found the nine confusing on the phone.
 */
describe("nav model", () => {
  it("is four sections, in this order, on both the sidebar and the tab bar", () => {
    expect(appNav.map((item) => [item.title, item.href])).toEqual([
      ["Today", "/today"],
      ["Growth", "/growth"],
      ["Content", "/content"],
      ["Settings", "/settings"],
    ]);
  });

  it("draws each with the mock's icon: inbox, trending up, file, sliders", () => {
    expect(appNav.map((item) => item.icon)).toEqual([
      Inbox,
      TrendingUp,
      FileText,
      SlidersVertical,
    ]);
  });

  it("keeps none of the old entries", () => {
    const titles: string[] = appNav.map((item) => item.title);
    for (const old of [
      "Overview",
      "Replies",
      "Articles",
      "Keywords",
      "Prompts",
      "Results",
      "Help",
      "Contact Us",
      "More",
      "Placements",
    ]) {
      expect(titles).not.toContain(old);
    }
  });

  it("lights a section on its pages and on nothing else", () => {
    expect(lit("/today")).toEqual(["Today"]);
    expect(lit("/growth")).toEqual(["Growth"]);
    expect(lit("/growth/ai")).toEqual(["Growth"]);
    expect(lit("/content")).toEqual(["Content"]);
    expect(lit("/content/topics")).toEqual(["Content"]);
    expect(lit("/growth/ai/queries/abc")).toEqual(["Growth"]);
    expect(lit("/settings/account")).toEqual(["Settings"]);
    expect(lit("/growthx")).toEqual([]);
    expect(lit("/docs")).toEqual([]);
    expect(lit(null)).toEqual([]);
  });

  it("points every item at a page that exists, and the docs and the account too", () => {
    for (const item of appNav) {
      expect(existsSync(path.join(root, `app/(app)${item.href}/page.tsx`)), item.href).toBe(true);
    }
    expect(existsSync(path.join(root, `app${DOCS_HREF}/page.tsx`))).toBe(true);
    expect(existsSync(path.join(root, `app/(app)${ACCOUNT_HREF}/page.tsx`))).toBe(true);
  });

  it("sends help to the public docs and the account to Settings", () => {
    expect(DOCS_HREF).toBe("/docs");
    expect(ACCOUNT_HREF).toBe("/settings/account");
  });
});

describe("MobileNav", () => {
  it("is a bottom tab bar of four, in the flow, hidden from md up, with safe-area padding", () => {
    nav.pathname = "/today";
    const html = renderToStaticMarkup(<MobileNav />);
    // In the flow under the app's scrolling area, never fixed: iOS left a
    // fixed bar in the middle of the screen (components/dashboard/app-scroll.tsx).
    expect(html).toContain("relative z-40 shrink-0");
    expect(html).not.toMatch(/<nav[^>]*class="[^"]*\bfixed\b/);
    expect(html).toContain("md:hidden");
    expect(html).toContain("pb-[env(safe-area-inset-bottom)]");
    expect(html).toContain("grid-cols-4");
    for (const label of ["Today", "Growth", "Content", "Settings"]) {
      expect(html).toContain(`<span>${label}</span>`);
    }
  });

  it("has no More button, no sheet, no contact link and no account menu", () => {
    const html = renderToStaticMarkup(<MobileNav />);
    expect(html).not.toContain("More");
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain("mailto:");
    expect(html).not.toContain("Logout");
    expect(source("components/dashboard/mobile-nav.tsx")).not.toContain("mobile-more-sheet");
  });

  it("marks the current tab and keeps every tab a 44px+ touch target", () => {
    nav.pathname = "/growth/ai";
    const html = renderToStaticMarkup(<MobileNav />);
    expect(html).toMatch(/href="\/growth"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/growth"/);
    expect(html.match(/aria-current="page"/g) ?? []).toHaveLength(1);
    expect(html.match(/min-h-\[56px\]/g) ?? []).toHaveLength(4);
  });
});

describe("MobileSiteBar", () => {
  it("puts the site switcher on the phone's top row, with its own ids", () => {
    const html = renderToStaticMarkup(
      <MobileSiteBar businesses={sites} selectedId="b-postwren" />,
    );
    expect(html).toMatch(/^<div class="[^"]*\bmd:hidden\b/);
    expect(html).toContain('id="business-switcher-bar"');
    expect(html).toContain('aria-controls="business-switcher-bar-menu"');
    expect(html).not.toContain('id="business-switcher"');
    expect(html).toContain("Postwren");
    expect(html).toContain("Add a site");
    expect(html).toContain("min-h-[44px]");
  });
});

describe("DashboardSidebar", () => {
  it("is desktop-only: the four sections, then docs and the account", () => {
    nav.pathname = "/content";
    const html = renderToStaticMarkup(
      <DashboardSidebar
        userEmail="owner@example.com"
        businesses={sites}
        selectedId="b-gtf"
      />,
    );
    expect(html).toMatch(/<aside class="[^"]*\bhidden\b[^"]*\bmd:flex\b/);
    const order = ["Today", "Growth", "Content", "Settings", "Docs and help", "owner"].map(
      (label) => html.indexOf(`>${label}</span>`),
    );
    for (const at of order) expect(at).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain('href="/docs"');
    expect(html).toContain('href="/settings/account"');
    expect(html).toContain('title="owner@example.com"');
    expect(html).toContain('id="business-switcher"');
    expect(html).toMatch(/href="\/content"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/content"/);
  });

  it("has no Contact Us mailto and no account dropdown", () => {
    const html = renderToStaticMarkup(<DashboardSidebar userEmail="owner@example.com" />);
    expect(html).not.toContain("mailto:");
    expect(html).not.toContain("Contact Us");
    expect(html).not.toContain("Logout");
    expect(html).not.toContain('aria-haspopup="menu"');
  });

  it("draws initials when there is no photo, and leaves out the account when signed out", () => {
    const withEmail = renderToStaticMarkup(<DashboardSidebar userEmail="owner@example.com" />);
    expect(withEmail).toContain(">OW</span>");
    const without = renderToStaticMarkup(<DashboardSidebar />);
    expect(without).not.toContain('href="/settings/account"');
    expect(without).toContain('href="/docs"');
  });
});

describe("the account menu", () => {
  it("is gone: sign out lives in Settings → Account", () => {
    expect(existsSync(path.join(root, "components/dashboard/user-menu-dashboard.tsx"))).toBe(false);
  });
});

describe("one name per section", () => {
  it("titles each section's page as the menu does", () => {
    expect(source("app/(app)/today/page.tsx")).toContain(">Today</h1>");
    expect(source("components/growth/growth-view.tsx")).toContain(">Growth</h1>");
    expect(source("components/content/content-parts.tsx")).toContain(">Content</h1>");
    expect(source("components/settings/settings-overview.tsx")).toContain(">Settings</h1>");
  });

  it("titles the Articles page as Content's tab does", () => {
    expect(source("app/(app)/content/articles/page.tsx")).toContain(">Articles</h1>");
  });

  // The settings pages' names, groups and back links: tests/settings/settings-nav.test.tsx.
});

describe("layout offsets", () => {
  it("only offsets content for the sidebar from md up, and reserves room for the tab bar", () => {
    expect(source("components/dashboard/site-section.tsx")).toContain("<SectionFrame>");
    const frame = source("components/dashboard/section-frame.tsx");
    expect(frame).toContain("md:ml-48");
    expect(frame).not.toMatch(/[\s"]ml-48/);
    expect(frame).toContain("pb-mobile-chrome");

    const settings = source("app/(app)/settings/layout.tsx");
    expect(settings).toContain("md:ml-[416px]");
    expect(settings).not.toMatch(/[\s"]ml-\[416px\]/);
    expect(settings).toContain("pb-mobile-chrome");

    const shell = source("app/(app)/layout.tsx");
    expect(shell).toContain("<MobileNav />");
  });

  it("keeps the last button clear of the Getting started pill; the tab bar is in the flow and covers nothing", () => {
    const css = source("app/globals.css");
    const rule = (selector: string) =>
      css.match(new RegExp(`\\n\\s*${selector.replace(/[[\]().]/g, "\\$&")} \\{([^}]*)\\}`))?.[1] ?? "";
    expect(rule(".pb-mobile-chrome")).toContain("padding-bottom: 1rem");
    expect(rule(":root[data-getting-started-pill] .pb-mobile-chrome")).toContain("padding-bottom: 3.5rem");
    // From md up the sidebar replaces the tab bar: nothing is reserved.
    expect(css).toMatch(/@media \(min-width: 768px\) \{\s*\.pb-mobile-chrome,\s*:root\[data-getting-started-pill\] \.pb-mobile-chrome \{\s*padding-bottom: 0;/);
  });
});
