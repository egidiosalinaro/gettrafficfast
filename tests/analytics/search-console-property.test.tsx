import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SearchConsolePropertyList } from "@/components/integrations/search-console-property";

/**
 * The picker a person uses to choose a Search Console property. The contract:
 * they see the host, not `sc-domain:`; the value we would POST is still
 * Google's siteUrl; the selected business is badged, a sibling grant is not.
 */

const sites = [
  { siteUrl: "sc-domain:ugcnexus.co", permissionLevel: "siteOwner" },
  { siteUrl: "sc-domain:gettrafficfa.st", permissionLevel: "siteFullUser" },
];

function visibleText(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

describe("SearchConsolePropertyList", () => {
  it("shows hosts and kinds, keeping the raw siteUrl off the visible line", () => {
    const html = renderToStaticMarkup(
      <SearchConsolePropertyList
        sites={sites}
        selected="sc-domain:gettrafficfa.st"
        websiteUrl="https://gettrafficfa.st"
        onSelect={() => {}}
      />
    );
    const text = visibleText(html);

    expect(text).toContain("gettrafficfa.st");
    expect(text).toContain("ugcnexus.co");
    expect(text).toContain("Entire domain, including subdomains");
    expect(text).not.toContain("sc-domain:");
    expect(html).toContain('title="sc-domain:gettrafficfa.st"');
    expect(html).toContain('title="sc-domain:ugcnexus.co"');
    expect(html).toContain("s2/favicons?domain=gettrafficfa.st");
    expect(html).toContain("s2/favicons?domain=ugcnexus.co");
  });

  it("badges only the property that covers the selected business", () => {
    const html = renderToStaticMarkup(
      <SearchConsolePropertyList
        sites={sites}
        selected="sc-domain:ugcnexus.co"
        websiteUrl="https://gettrafficfa.st"
        onSelect={() => {}}
      />
    );
    expect(html).toContain("This site");
    const thisSiteAt = html.indexOf("This site");
    const gtfAt = html.indexOf("gettrafficfa.st");
    const ugcAt = html.indexOf("ugcnexus.co");
    expect(thisSiteAt).toBeGreaterThan(gtfAt);
    expect(thisSiteAt).toBeLessThan(ugcAt);
    expect(html.match(/This site/g)).toHaveLength(1);
  });

  it("lists the covering property first even when another is selected", () => {
    const html = renderToStaticMarkup(
      <SearchConsolePropertyList
        sites={sites}
        selected="sc-domain:ugcnexus.co"
        websiteUrl="https://gettrafficfa.st"
        onSelect={() => {}}
      />
    );
    expect(html.indexOf("gettrafficfa.st")).toBeLessThan(html.indexOf("ugcnexus.co"));
  });

  it("marks the selected row as the checked radio, not a rewritten value", () => {
    const html = renderToStaticMarkup(
      <SearchConsolePropertyList
        sites={sites}
        selected="sc-domain:gettrafficfa.st"
        websiteUrl="https://gettrafficfa.st"
        onSelect={() => {}}
      />
    );
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('aria-checked="false"');
    expect(html).not.toContain("<select");
  });
});
