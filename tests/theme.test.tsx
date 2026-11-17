import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  usePathname: () => "/placements",
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
}));

import { THEME_BACKGROUND, THEME_CHOICES, THEME_COLOR, THEME_PROVIDER_PROPS } from "@/lib/theme";
import { APP_BACKGROUND, APP_BACKGROUND_DARK } from "@/lib/site";
import { BrandMark } from "@/components/brand-mark";
import { DashboardSidebar } from "@/components/dashboard/sidebar";
import { LandingHeader } from "@/components/landing/header";
import { ThemeChoice } from "@/components/settings/theme-choice";

/**
 * The app follows the device's colour scheme (2026-11-12). Until then the
 * provider forced the light theme, and a phone in dark mode got a white app.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (relativePath: string) => readFileSync(path.join(root, relativePath), "utf8");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(path.join(root, dir))) {
    const relative = path.join(dir, name);
    if (statSync(path.join(root, relative)).isDirectory()) out.push(...walk(relative));
    else if (/\.(ts|tsx)$/.test(name)) out.push(relative);
  }
  return out;
}

/** "0 0% 98%" -> "#fafafa", for the greys the page backgrounds are. */
function hslToHex(hsl: string): string {
  const [h, s, l] = hsl.split(/\s+/).map((part) => parseFloat(part));
  const sat = s / 100;
  const light = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const channel = (n: number) => light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return `#${[0, 8, 4].map((n) => Math.round(channel(n) * 255).toString(16).padStart(2, "0")).join("")}`;
}

describe("theme provider", () => {
  it("follows the device and forces nothing", () => {
    expect(THEME_PROVIDER_PROPS).toEqual({
      attribute: "class",
      defaultTheme: "system",
      enableSystem: true,
      disableTransitionOnChange: true,
    });
    expect(THEME_PROVIDER_PROPS).not.toHaveProperty("forcedTheme");
  });

  it("is what the root layout and the error page use, with no theme forced anywhere", () => {
    // Read as text: app/layout.tsx loads a font, which a test cannot import.
    for (const file of ["app/layout.tsx", "app/global-error.tsx"]) {
      const text = source(file);
      expect(text).toContain("<ThemeProvider {...THEME_PROVIDER_PROPS}>");
      expect(text).toContain('<html lang="en" suppressHydrationWarning>');
    }
    for (const file of [...walk("app"), ...walk("components")]) {
      expect(source(file), file).not.toMatch(/forcedTheme|enableSystem=\{false\}/);
    }
  });

  it("offers System, Light and Dark, System first", () => {
    expect(THEME_CHOICES.map((choice) => choice.value)).toEqual(["system", "light", "dark"]);
  });
});

describe("browser chrome colour", () => {
  it("is one theme-color per device scheme, each the page colour of that theme", () => {
    expect(THEME_COLOR).toEqual([
      { media: "(prefers-color-scheme: light)", color: APP_BACKGROUND },
      { media: "(prefers-color-scheme: dark)", color: APP_BACKGROUND_DARK },
    ]);
    expect(THEME_BACKGROUND).toEqual({ light: APP_BACKGROUND, dark: APP_BACKGROUND_DARK });
    expect(source("app/layout.tsx")).toContain("themeColor: THEME_COLOR,");
  });

  it("matches --background of each theme in globals.css", () => {
    const css = source("app/globals.css");
    const light = css.match(/:root \{[^}]*?--background: ([^;]+);/)?.[1] ?? "";
    const dark = css.match(/\.dark \{[^}]*?--background: ([^;]+);/)?.[1] ?? "";
    expect(hslToHex(light)).toBe(APP_BACKGROUND);
    expect(hslToHex(dark)).toBe(APP_BACKGROUND_DARK);
  });

  it("lets native controls and scrollbars follow the theme", () => {
    const css = source("app/globals.css");
    expect(css).toMatch(/:root \{\s*\/\*[^*]*\*\/\s*color-scheme: light;/);
    expect(css).toMatch(/\.dark \{\s*color-scheme: dark;/);
  });
});

describe("hardcoded colours", () => {
  // Images for other sites, drawn light on purpose, and never shown in the app.
  const ALLOWED = [/opengraph-image\.tsx$/, /twitter-image\.tsx$/];
  const files = [...walk("app"), ...walk("components")].filter(
    (file) => !ALLOWED.some((pattern) => pattern.test(file))
  );
  const HUES = "red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
  /** Shades that only read on a light page: pale fills and borders, deep text. */
  const LIGHT_ONLY = new RegExp(
    `(?:^|\\s)((?:[a-z-]+:)*)(bg-white|text-black|(bg)-(?:${HUES})-(?:50|100|200)|(text)-(?:${HUES})-(?:700|800|900)|(border)-(?:${HUES})-(?:100|200|300))(?=[\\s/]|$)`,
    "g"
  );

  /** Each string literal holding a light-only class without a dark: partner for the same property. */
  function offenders(file: string): string[] {
    const found: string[] = [];
    const text = source(file);
    for (const literal of text.matchAll(/"([^"\n]*)"|'([^'\n]*)'|`([^`]*)`/g)) {
      const value = literal[1] ?? literal[2] ?? literal[3] ?? "";
      for (const match of value.matchAll(LIGHT_ONLY)) {
        const variants = match[1];
        if (variants.includes("dark:")) continue;
        const property = match[2].split("-")[0];
        const partner = new RegExp(`(?:^|\\s)${variants.replace(/[[\]]/g, "\\$&")}dark:(?:[a-z-]+:)*${property}-`);
        const partnerAnyOrder = new RegExp(`(?:^|\\s)dark:${variants.replace(/[[\]]/g, "\\$&")}${property}-`);
        if (!partner.test(value) && !partnerAnyOrder.test(value)) found.push(`${file}: ${match[0].trim()}`);
      }
    }
    return found;
  }

  it("never leaves a white surface or black text without a dark partner", () => {
    const hits = files.flatMap(offenders).filter((hit) => /bg-white|text-black/.test(hit));
    expect(hits).toEqual([]);
  });

  it("gives every pale status fill, border and deep status text a dark partner", () => {
    expect(files.flatMap(offenders)).toEqual([]);
  });

  it("catches what it is meant to catch", () => {
    const value = "rounded bg-white text-emerald-800 dark:bg-card";
    const missing = [...value.matchAll(LIGHT_ONLY)].map((m) => m[2]);
    expect(missing).toEqual(["bg-white", "text-emerald-800"]);
  });
});

describe("the mark", () => {
  const PNG = "gettrafficfast_logo_black_on_white";

  it("is /icon.svg as a mask in the text's colour, hidden from assistive tech", () => {
    const html = renderToStaticMarkup(<BrandMark className="h-6 w-6" />);
    expect(html).toContain("mask-image:url(/icon.svg)");
    expect(html).toContain("bg-current");
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain("<img");
  });

  it("is drawn that way in the sidebar, next to the name as text", () => {
    const html = renderToStaticMarkup(<DashboardSidebar />);
    expect(html).toContain("data-brand-mark");
    expect(html).toContain("url(/icon.svg)");
    expect(html).toContain(">GetTrafficFast</span>");
    expect(html).not.toContain(PNG);
  });

  it("is drawn that way in the site header, next to the name as text", async () => {
    const html = renderToStaticMarkup(await LandingHeader());
    expect(html).toContain("data-brand-mark");
    expect(html).toContain("url(/icon.svg)");
    expect(html).toContain(">GetTrafficFast</span>");
    expect(html).not.toContain(PNG);
  });

  it("is never an <img> of icon.svg or the black-on-white PNG anywhere in the UI", () => {
    for (const file of [...walk("app"), ...walk("components")]) {
      const text = source(file);
      expect(text, file).not.toContain(PNG);
      expect(text, file).not.toMatch(/src=["'{`]*\/icon\.svg/);
    }
  });
});

describe("theme choice", () => {
  it("renders the three choices and marks none before hydration", () => {
    const html = renderToStaticMarkup(<ThemeChoice />);
    for (const label of ["System", "Light", "Dark"]) expect(html).toContain(label);
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(3);
    expect(html).not.toContain('aria-pressed="true"');
  });

  it("sits in Settings → Account", () => {
    expect(source("app/(app)/settings/account/page.tsx")).toContain("<ThemeChoice />");
  });
});
