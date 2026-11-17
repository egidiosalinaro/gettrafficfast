import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function source(relativePath: string): string {
  return readFileSync(path.join(root, relativePath), "utf8");
}

/** Every layout under the shell, at any depth, except the shell's own. */
function sectionLayouts(dir = "app/(app)"): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = `${dir}/${entry.name}`;
    if (existsSync(path.join(root, child, "layout.tsx"))) found.push(`${child}/layout.tsx`);
    found.push(...sectionLayouts(child));
  }
  return found;
}

/**
 * The site switcher disappeared on every left-menu click because each section
 * layout mounted its own sidebar. The switcher renders nothing until it has a
 * list, so a fresh mount is a blank control that pops back in after the fetch.
 * One shell owns the sidebar, the phone's site row and the tab bar; sections
 * must not mount a second one.
 */
describe("authenticated shell", () => {
  it("mounts the navigation once, in the shell that survives section changes", () => {
    const shell = source("app/(app)/layout.tsx");
    expect(shell).toContain("<DashboardSidebar");
    expect(shell).toContain("businesses={businesses}");
    expect(shell).toContain("selectedId={selectedId}");
    expect(shell).toContain("const selectedId = selected?.id ?? null;");
    expect(shell).toContain("<MobileSiteBar businesses={businesses} selectedId={selectedId} />");
    expect(shell).toContain("<MobileNav />");

    const layouts = sectionLayouts();
    expect(layouts.length).toBeGreaterThan(0);
    for (const layout of layouts) {
      const text = source(layout);
      for (const shellPart of ["DashboardSidebar", "MobileNav", "MobileSiteBar", "BusinessSwitcher"]) {
        expect(text, layout).not.toContain(shellPart);
      }
    }
  });

  it("frames every section that is about a site in SiteSection; Settings creates the site", () => {
    const topLevel = sectionLayouts().filter(
      (layout) => layout.split("/").length === 4 && !layout.startsWith("app/(app)/settings/"),
    );
    expect(topLevel.length).toBeGreaterThan(0);
    for (const layout of topLevel) expect(source(layout), layout).toContain("SiteSection");
  });

  it("shows the phone's site row only when there is a site to switch", () => {
    const shell = source("app/(app)/layout.tsx");
    expect(shell).toMatch(/businesses\.length > 0 && \(\s*<MobileSiteBar/);
  });

  it("keeps settings as the page that creates a site, without a redirect loop", () => {
    const settings = source("app/(app)/settings/layout.tsx");
    expect(settings).toContain("requireAppAccess(");
    expect(settings).not.toContain("requireSite(");
    expect(settings).not.toContain("DashboardSidebar");

    const gate = source("lib/app-access.ts");
    expect(gate).toContain('redirect("/settings/business")');
    expect(gate).toMatch(/if \(!access\.selected\)/);
  });
});
