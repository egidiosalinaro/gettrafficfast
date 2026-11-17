/**
 * URL Inspection answers in the shape Google's `urlInspection/index:inspect`
 * returns (`{ inspectionResult: { inspectionResultLink, indexStatusResult,
 * mobileUsabilityResult?, richResultsResult? } }`), one per case the product
 * has to read: indexed, a redirect (the 2026-11-12 "Page with redirect"
 * email), crawled but not indexed, excluded by noindex, and a 404. The URLs
 * are the fake site of the tests; the field names and enum values are
 * Google's.
 */

const link = (path: string) =>
  `https://search.google.com/search-console/inspect?resource_id=sc-domain:acme.test&id=${encodeURIComponent(path)}`;

export const INDEXED = {
  inspectionResult: {
    inspectionResultLink: link("/blog/ai-seo"),
    indexStatusResult: {
      verdict: "PASS",
      coverageState: "Submitted and indexed",
      robotsTxtState: "ALLOWED",
      indexingState: "INDEXING_ALLOWED",
      lastCrawlTime: "2026-11-10T08:12:44Z",
      pageFetchState: "SUCCESSFUL",
      googleCanonical: "https://acme.test/blog/ai-seo",
      userCanonical: "https://acme.test/blog/ai-seo",
      sitemap: ["https://acme.test/sitemap.xml"],
      referringUrls: ["https://acme.test/blog", "https://acme.test/"],
      crawledAs: "MOBILE",
    },
    mobileUsabilityResult: { verdict: "VERDICT_UNSPECIFIED" },
  },
};

export const REDIRECT = {
  inspectionResult: {
    inspectionResultLink: link("/check"),
    indexStatusResult: {
      verdict: "NEUTRAL",
      coverageState: "Page with redirect",
      robotsTxtState: "ALLOWED",
      indexingState: "INDEXING_ALLOWED",
      lastCrawlTime: "2026-11-09T21:03:10Z",
      pageFetchState: "SUCCESSFUL",
      googleCanonical: "https://acme.test/",
      sitemap: ["https://acme.test/sitemap.xml"],
      crawledAs: "MOBILE",
    },
  },
};

export const CRAWLED_NOT_INDEXED = {
  inspectionResult: {
    inspectionResultLink: link("/blog/thin-page"),
    indexStatusResult: {
      verdict: "NEUTRAL",
      coverageState: "Crawled - currently not indexed",
      robotsTxtState: "ALLOWED",
      indexingState: "INDEXING_ALLOWED",
      lastCrawlTime: "2026-11-08T03:40:00Z",
      pageFetchState: "SUCCESSFUL",
      userCanonical: "https://acme.test/blog/thin-page",
      crawledAs: "MOBILE",
    },
  },
};

export const NOINDEX = {
  inspectionResult: {
    inspectionResultLink: link("/blog/draft"),
    indexStatusResult: {
      verdict: "NEUTRAL",
      coverageState: "Excluded by 'noindex' tag",
      robotsTxtState: "ALLOWED",
      indexingState: "BLOCKED_BY_META_TAG",
      lastCrawlTime: "2026-11-07T12:00:00Z",
      pageFetchState: "SUCCESSFUL",
      userCanonical: "https://acme.test/blog/draft",
      crawledAs: "DESKTOP",
    },
  },
};

export const NOT_FOUND = {
  inspectionResult: {
    inspectionResultLink: link("/blog/gone"),
    indexStatusResult: {
      verdict: "FAIL",
      coverageState: "Not found (404)",
      robotsTxtState: "ALLOWED",
      indexingState: "INDEXING_ALLOWED",
      lastCrawlTime: "2026-11-06T09:30:00Z",
      pageFetchState: "NOT_FOUND",
      referringUrls: ["https://acme.test/blog"],
      crawledAs: "MOBILE",
    },
  },
};

/** A URL Google has never seen: no crawl, no canonical. */
export const UNKNOWN_TO_GOOGLE = {
  inspectionResult: {
    inspectionResultLink: link("/blog/new"),
    indexStatusResult: {
      verdict: "NEUTRAL",
      coverageState: "URL is unknown to Google",
      robotsTxtState: "ROBOTS_TXT_STATE_UNSPECIFIED",
      indexingState: "INDEXING_STATE_UNSPECIFIED",
      pageFetchState: "PAGE_FETCH_STATE_UNSPECIFIED",
    },
  },
};
