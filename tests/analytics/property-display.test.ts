import { describe, expect, it } from "vitest";
import {
  describeSearchConsoleProperty,
  permissionLabel,
  propertyCoversHost,
  searchConsolePropertyLabel,
  sortSearchConsoleSites,
} from "@/lib/analytics/property-display";

/**
 * Google's siteUrl is the identity we store. The label a person reads must
 * never be that string for a domain property, and "this site" must not light
 * up on a sibling domain the grant also happens to list.
 */

describe("describeSearchConsoleProperty", () => {
  it("turns a domain property into the host a person recognises", () => {
    const view = describeSearchConsoleProperty("sc-domain:ugcnexus.co");
    expect(view).toMatchObject({
      siteUrl: "sc-domain:ugcnexus.co",
      kind: "domain",
      host: "ugcnexus.co",
      label: "ugcnexus.co",
      detail: "Entire domain, including subdomains",
    });
  });

  it("strips www from a domain property without rewriting siteUrl", () => {
    const view = describeSearchConsoleProperty("sc-domain:www.gettrafficfa.st");
    expect(view.siteUrl).toBe("sc-domain:www.gettrafficfa.st");
    expect(view.label).toBe("gettrafficfa.st");
    expect(view.host).toBe("gettrafficfa.st");
  });

  it("keeps a URL-prefix path on the label", () => {
    const view = describeSearchConsoleProperty("https://www.example.com/blog/");
    expect(view.kind).toBe("url_prefix");
    expect(view.host).toBe("example.com");
    expect(view.label).toBe("www.example.com/blog");
    expect(view.detail).toBe("This URL prefix only");
    expect(view.siteUrl).toBe("https://www.example.com/blog/");
  });

  it("does not invent a host from an empty domain property", () => {
    const view = describeSearchConsoleProperty("sc-domain:");
    expect(view.kind).toBe("unknown");
    expect(view.host).toBeNull();
    expect(view.label).toBe("sc-domain:");
  });
});

describe("searchConsolePropertyLabel", () => {
  it("is null when nothing is selected", () => {
    expect(searchConsolePropertyLabel(null)).toBeNull();
    expect(searchConsolePropertyLabel("")).toBeNull();
  });

  it("hides the sc-domain prefix on Results captions", () => {
    expect(searchConsolePropertyLabel("sc-domain:gettrafficfa.st")).toBe(
      "gettrafficfa.st"
    );
  });
});

describe("propertyCoversHost", () => {
  it("marks the domain property that matches the selected business", () => {
    expect(
      propertyCoversHost("sc-domain:gettrafficfa.st", "https://gettrafficfa.st")
    ).toBe(true);
    expect(
      propertyCoversHost("sc-domain:ugcnexus.co", "https://gettrafficfa.st")
    ).toBe(false);
  });

  it("treats www as the same host people store", () => {
    expect(
      propertyCoversHost("sc-domain:example.com", "https://www.example.com")
    ).toBe(true);
    expect(
      propertyCoversHost("https://www.example.com/", "https://example.com")
    ).toBe(true);
  });

  it("lets a domain property cover a subdomain, but not a sibling", () => {
    expect(
      propertyCoversHost("sc-domain:example.com", "https://blog.example.com")
    ).toBe(true);
    expect(
      propertyCoversHost("https://blog.example.com/", "https://example.com")
    ).toBe(false);
    expect(
      propertyCoversHost("sc-domain:nexus.co", "https://ugcnexus.co")
    ).toBe(false);
  });

  it("does not guess when the business has no URL", () => {
    expect(propertyCoversHost("sc-domain:example.com", null)).toBe(false);
    expect(propertyCoversHost("sc-domain:example.com", "")).toBe(false);
  });
});

describe("sortSearchConsoleSites", () => {
  it("puts the property that covers this site first", () => {
    const ordered = sortSearchConsoleSites(
      [
        { siteUrl: "sc-domain:ugcnexus.co" },
        { siteUrl: "sc-domain:gettrafficfa.st" },
      ],
      "https://gettrafficfa.st"
    );
    expect(ordered.map((s) => s.siteUrl)).toEqual([
      "sc-domain:gettrafficfa.st",
      "sc-domain:ugcnexus.co",
    ]);
  });

  it("prefers a covering domain property over a covering URL prefix", () => {
    const ordered = sortSearchConsoleSites(
      [
        { siteUrl: "https://example.com/" },
        { siteUrl: "sc-domain:example.com" },
      ],
      "https://www.example.com"
    );
    expect(ordered.map((s) => s.siteUrl)).toEqual([
      "sc-domain:example.com",
      "https://example.com/",
    ]);
  });
});

describe("permissionLabel", () => {
  it("maps Google's levels without inventing one", () => {
    expect(permissionLabel("siteOwner")).toBe("Owner");
    expect(permissionLabel("siteFullUser")).toBe("Full");
    expect(permissionLabel("mystery")).toBeNull();
    expect(permissionLabel(null)).toBeNull();
  });
});
