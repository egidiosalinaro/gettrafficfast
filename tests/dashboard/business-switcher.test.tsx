import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  BusinessSwitcher,
  BusinessSwitcherControl,
  BusinessSwitcherMenu,
  SiteMark,
} from "@/components/dashboard/business-switcher";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {} }),
}));

const postwren = {
  id: "b-postwren",
  name: "Postwren",
  website_url: "https://www.postwren.com",
};
const gtf = {
  id: "b-gtf",
  name: "GetTrafficFast",
  website_url: "https://gettrafficfa.st",
};
const unnamed = {
  id: "b-orphan",
  name: null,
  website_url: null,
};

describe("SiteMark", () => {
  it("renders the Google favicon for a stored website URL", () => {
    const html = renderToStaticMarkup(<SiteMark site={postwren} />);
    expect(html).toContain("https://www.google.com/s2/favicons?domain=postwren.com");
    expect(html).toContain('alt=""');
  });

  it("does not invent a favicon domain when the site has no URL", () => {
    const html = renderToStaticMarkup(<SiteMark site={unnamed} />);
    expect(html).not.toContain("s2/favicons");
  });
});

describe("BusinessSwitcherMenu", () => {
  it("lists every site with its favicon and keeps Add a site as a menu action", () => {
    const html = renderToStaticMarkup(
      <BusinessSwitcherMenu
        businesses={[postwren, gtf]}
        selectedId={postwren.id}
        onSelect={() => {}}
      />,
    );
    expect(html).toContain("Postwren");
    expect(html).toContain("GetTrafficFast");
    expect(html).toContain("s2/favicons?domain=postwren.com");
    expect(html).toContain("s2/favicons?domain=gettrafficfa.st");
    expect(html).toContain("Add a site");
    expect(html).toContain('href="/settings/business?new=1"');
    expect(html).not.toContain("<select");
  });
});

describe("BusinessSwitcherControl", () => {
  it("is a custom menu, not a native select", () => {
    const html = renderToStaticMarkup(
      <BusinessSwitcherControl
        businesses={[postwren, gtf]}
        selectedId={postwren.id}
        switching={false}
        onSelect={() => {}}
      />,
    );
    expect(html).not.toMatch(/<select[\s>]/);
    expect(html).toContain('role="menu"');
    expect(html).toContain('aria-haspopup="menu"');
  });

  it("shows the selected site's favicon on the trigger", () => {
    const html = renderToStaticMarkup(
      <BusinessSwitcherControl
        businesses={[postwren, gtf]}
        selectedId={gtf.id}
        switching={false}
        onSelect={() => {}}
      />,
    );
    expect(html).toContain("s2/favicons?domain=gettrafficfa.st");
    expect(html).toContain("GetTrafficFast");
  });

  it("keeps Add a site inside the menu, not as a sibling under the trigger", () => {
    const html = renderToStaticMarkup(
      <BusinessSwitcherControl
        businesses={[postwren, gtf]}
        selectedId={postwren.id}
        switching={false}
        onSelect={() => {}}
      />,
    );
    const menuAt = html.indexOf('role="menu"');
    const addAt = html.indexOf("Add a site");
    expect(menuAt).toBeGreaterThan(-1);
    expect(addAt).toBeGreaterThan(menuAt);
    // Closed by default, but the action is still a descendant of the menu.
    expect(html).toMatch(/role="menu"[^>]*hidden/);
  });

  it("paints the selected site on the first render when the shell already knows it", () => {
    const html = renderToStaticMarkup(
      <BusinessSwitcher businesses={[postwren, gtf]} selectedId={gtf.id} />,
    );
    expect(html).toContain('id="business-switcher"');
    expect(html).toContain("GetTrafficFast");
    expect(html).toContain("s2/favicons?domain=gettrafficfa.st");
    expect(html).not.toMatch(/<select[\s>]/);
  });

  it("stays empty only when no site is known yet", () => {
    const html = renderToStaticMarkup(<BusinessSwitcher />);
    expect(html).toBe("");
  });

  it("still uses the custom selector when the account has a single site", () => {
    const html = renderToStaticMarkup(
      <BusinessSwitcherControl
        businesses={[postwren]}
        selectedId={postwren.id}
        switching={false}
        onSelect={() => {}}
      />,
    );
    expect(html).toContain('role="menu"');
    expect(html).toContain("Add a site");
    expect(html).toContain("s2/favicons?domain=postwren.com");
  });
});
