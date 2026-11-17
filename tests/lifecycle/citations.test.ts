import { describe, expect, it } from "vitest";
import { citationRate, findCitation, type CitationPoint } from "@/lib/lifecycle/citations";
import { CitationSource } from "@/lib/providers/citations/types";

/**
 * Citation measurement is a sampled metric that will be shown to customers.
 * Its contract is that it never overstates: an unmeasured article must not
 * read as "never cited", and a citation of some other page on the site must
 * not read as a citation of this article.
 */

const source = (url: string, domain: string): CitationSource => ({ url, domain, title: "" });

const SOURCES = [
  source("https://competitor.test/guide", "competitor.test"),
  source("https://customer.test/blog/cast-iron", "customer.test"),
  source("https://another.test/x", "another.test"),
];

describe("findCitation", () => {
  it("recognises the article itself as an exact citation", () => {
    const match = findCitation(SOURCES, "https://customer.test/blog/cast-iron");
    expect(match?.exact).toBe(true);
    expect(match?.source.domain).toBe("customer.test");
  });

  it("ignores a trailing slash and case when matching the url", () => {
    const match = findCitation(SOURCES, "https://Customer.test/blog/cast-iron/");
    expect(match?.exact).toBe(true);
  });

  it("counts another page on the same site, but not as exact", () => {
    const match = findCitation(SOURCES, "https://customer.test/blog/something-else");
    expect(match?.exact).toBe(false);
    expect(match?.source.url).toBe("https://customer.test/blog/cast-iron");
  });

  it("returns nothing when the site is absent from the sources", () => {
    expect(findCitation(SOURCES, "https://absent.test/page")).toBeNull();
  });

  it("returns nothing when the article has no published url", () => {
    expect(findCitation(SOURCES, "   ")).toBeNull();
  });
});

describe("citationRate", () => {
  const points: CitationPoint[] = [
    { checkedOn: "2026-08-01", engine: "perplexity", cited: false },
    { checkedOn: "2026-08-08", engine: "perplexity", cited: true },
    { checkedOn: "2026-08-15", engine: "perplexity", cited: true },
    { checkedOn: "2026-08-15", engine: "other", cited: false },
  ];

  it("is null when nothing was ever measured, never zero", () => {
    // Zero would read as "we are never cited"; null reads as "we have not
    // looked yet". Showing a customer the wrong one of those is the failure.
    expect(citationRate([])).toBeNull();
    expect(citationRate(points, "unconfigured-engine")).toBeNull();
  });

  it("computes the share of probes that found a citation", () => {
    expect(citationRate(points, "perplexity")).toBeCloseTo(2 / 3);
  });

  it("scopes to one engine, because engines are not comparable", () => {
    expect(citationRate(points, "other")).toBe(0);
    expect(citationRate(points, "perplexity")).not.toBe(citationRate(points, "other"));
  });
});
