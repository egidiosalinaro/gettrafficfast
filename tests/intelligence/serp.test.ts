import { describe, expect, it } from "vitest";
import { parseSerperResponse, timeFilter } from "@/lib/providers/serp/serper";
import { domainOf } from "@/lib/providers/serp/types";
import { extractCompetitorDomains } from "@/lib/intelligence/serp";

describe("domainOf", () => {
  it("lowercases and strips www", () => {
    expect(domainOf("https://WWW.Example.com/page?x=1")).toBe("example.com");
    expect(domainOf("https://blog.example.com/p")).toBe("blog.example.com");
  });

  it("returns empty on garbage instead of throwing", () => {
    expect(domainOf("not a url")).toBe("");
  });
});

describe("parseSerperResponse", () => {
  const payload = {
    organic: [
      { position: 1, title: "Guida ai codici sconto", link: "https://www.shopify.com/it/blog/x", snippet: "Come creare codici." },
      { position: 2, title: "", link: "https://no-title.example" },
      { position: 3, title: "Senza link" },
      { title: "Senza posizione", link: "https://klaviyo.com/blog/y", snippet: "s", date: "4 mesi fa" },
    ],
    peopleAlsoAsk: [{ question: " Come si genera un codice sconto? " }, { question: "" }],
    relatedSearches: [{ query: "codici sconto shopify" }, {}],
  };

  it("maps organic results, extracts domains, and drops incomplete rows", () => {
    const data = parseSerperResponse("codici sconto", payload);
    expect(data.results).toHaveLength(2);
    expect(data.results[0]).toEqual({
      position: 1,
      title: "Guida ai codici sconto",
      url: "https://www.shopify.com/it/blog/x",
      domain: "shopify.com",
      snippet: "Come creare codici.",
      // No date shown: none, not today.
      publishedAt: null,
      publishedAtPrecision: null,
    });
    // A missing position falls back to the list index.
    expect(data.results[1].position).toBe(4);
    expect(data.results[1].domain).toBe("klaviyo.com");
  });

  it("reads the date Google shows beside a result, in the interface language, as the bound it is", () => {
    const now = new Date("2026-09-29T12:00:00Z");
    const data = parseSerperResponse("codici sconto", payload, now);
    // "4 mesi fa": at least four months, less than five. The latest instant
    // it allows is four months back, and the width is a month.
    expect(data.results[1].publishedAt).toBe("2026-05-29T12:00:00.000Z");
    expect(data.results[1].publishedAtPrecision).toBe("month");
    const dated = parseSerperResponse("k", { organic: [{ title: "t", link: "https://a.example/p", date: "Jun 6, 2025" }] }, now);
    expect(dated.results[0]).toMatchObject({ publishedAt: "2025-06-06T00:00:00.000Z", publishedAtPrecision: "day" });
  });

  it("maps an age window onto Google's time filter, never narrower than asked", () => {
    expect(timeFilter(180)).toBe("qdr:m6");
    expect(timeFilter(365)).toBe("qdr:y1");
    expect(timeFilter(10)).toBe("qdr:w2");
    expect(timeFilter(3)).toBe("qdr:d3");
    expect(timeFilter(1)).toBe("qdr:d");
  });

  it("collects people-also-ask and related searches, trimmed and non-empty", () => {
    const data = parseSerperResponse("codici sconto", payload);
    expect(data.peopleAlsoAsk).toEqual(["Come si genera un codice sconto?"]);
    expect(data.relatedSearches).toEqual(["codici sconto shopify"]);
  });

  it("keeps the provider payload verbatim for the snapshot", () => {
    expect(parseSerperResponse("k", payload).raw).toBe(payload);
  });
});

describe("extractCompetitorDomains", () => {
  const result = (position: number, url: string) => ({
    position,
    title: `t${position}`,
    url,
    domain: domainOf(url),
    snippet: "",
  });

  it("excludes the business's own site, including subdomains", () => {
    const competitors = extractCompetitorDomains(
      [
        result(1, "https://www.postwren.it/blog/a"),
        result(2, "https://app.postwren.it/docs"),
        result(3, "https://klaviyo.com/blog/x"),
      ],
      "https://www.postwren.it"
    );
    expect(competitors).toEqual([{ domain: "klaviyo.com", bestPosition: 3 }]);
  });

  it("excludes generic platforms, including their subdomains", () => {
    const competitors = extractCompetitorDomains([
      result(1, "https://en.wikipedia.org/wiki/Coupon"),
      result(2, "https://www.reddit.com/r/ecommerce/x"),
      result(3, "https://www.youtube.com/watch?v=1"),
      result(4, "https://mailchimp.com/resources/x"),
    ]);
    expect(competitors).toEqual([{ domain: "mailchimp.com", bestPosition: 4 }]);
  });

  it("dedupes by domain keeping the best position, ordered by it", () => {
    const competitors = extractCompetitorDomains([
      result(2, "https://klaviyo.com/blog/a"),
      result(5, "https://klaviyo.com/blog/b"),
      result(3, "https://mailchimp.com/x"),
    ]);
    expect(competitors).toEqual([
      { domain: "klaviyo.com", bestPosition: 2 },
      { domain: "mailchimp.com", bestPosition: 3 },
    ]);
  });
});
