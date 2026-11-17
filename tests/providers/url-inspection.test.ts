import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyInspectionStatus,
  parseUrlInspectionResponse,
  SearchConsoleProvider,
} from "@/lib/providers/analytics/search-console";
import { InspectionError } from "@/lib/providers/analytics/types";
import { CRAWLED_NOT_INDEXED, INDEXED, NOINDEX, NOT_FOUND, REDIRECT, UNKNOWN_TO_GOOGLE } from "../fixtures/url-inspection";

/**
 * Google's URL Inspection, read without a network. What is pinned: each
 * real-shaped answer maps onto the fields the product stores, with Google's
 * sentence kept verbatim; an unknown verdict is never read as either
 * indexed or not; the request is the one Google documents; 403 and 429 are
 * told apart, because one means "reconnect" and the other "stop for today".
 */

afterEach(() => vi.unstubAllGlobals());

describe("parseUrlInspectionResponse", () => {
  it("reads an indexed page", () => {
    const parsed = parseUrlInspectionResponse(INDEXED);
    expect(parsed).toMatchObject({
      verdict: "PASS",
      coverageState: "Submitted and indexed",
      indexingState: "INDEXING_ALLOWED",
      robotsTxtState: "ALLOWED",
      pageFetchState: "SUCCESSFUL",
      googleCanonical: "https://acme.test/blog/ai-seo",
      userCanonical: "https://acme.test/blog/ai-seo",
      lastCrawlTime: "2026-11-10T08:12:44Z",
      sitemap: ["https://acme.test/sitemap.xml"],
      referringUrls: ["https://acme.test/blog", "https://acme.test/"],
    });
    expect(parsed.inspectionResultLink).toContain("search.google.com/search-console/inspect");
    expect(parsed.raw).toBe(INDEXED);
  });

  it("reads a redirect, a crawled-not-indexed page, a noindex and a 404 in Google's words", () => {
    expect(parseUrlInspectionResponse(REDIRECT)).toMatchObject({
      verdict: "NEUTRAL",
      coverageState: "Page with redirect",
      googleCanonical: "https://acme.test/",
      userCanonical: null,
      referringUrls: [],
    });
    expect(parseUrlInspectionResponse(CRAWLED_NOT_INDEXED)).toMatchObject({
      verdict: "NEUTRAL",
      coverageState: "Crawled - currently not indexed",
      googleCanonical: null,
    });
    expect(parseUrlInspectionResponse(NOINDEX)).toMatchObject({
      verdict: "NEUTRAL",
      coverageState: "Excluded by 'noindex' tag",
      indexingState: "BLOCKED_BY_META_TAG",
    });
    expect(parseUrlInspectionResponse(NOT_FOUND)).toMatchObject({
      verdict: "FAIL",
      coverageState: "Not found (404)",
      pageFetchState: "NOT_FOUND",
    });
    expect(parseUrlInspectionResponse(UNKNOWN_TO_GOOGLE)).toMatchObject({
      coverageState: "URL is unknown to Google",
      lastCrawlTime: null,
      sitemap: [],
    });
  });

  it("narrows a verdict it does not know to VERDICT_UNSPECIFIED, and survives an empty answer", () => {
    expect(parseUrlInspectionResponse({ inspectionResult: { indexStatusResult: { verdict: "MAYBE" } } }).verdict).toBe(
      "VERDICT_UNSPECIFIED"
    );
    expect(parseUrlInspectionResponse({})).toMatchObject({
      verdict: "VERDICT_UNSPECIFIED",
      coverageState: null,
      inspectionResultLink: null,
      sitemap: [],
    });
  });
});

describe("SearchConsoleProvider.inspectUrl", () => {
  it("posts the documented body with the bearer token and parses the answer", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(REDIRECT), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await new SearchConsoleProvider("TOKEN").inspectUrl("sc-domain:acme.test", "https://acme.test/check");
    expect(result.coverageState).toBe("Page with redirect");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://searchconsole.googleapis.com/v1/urlInspection/index:inspect");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer TOKEN");
    expect(JSON.parse(init.body as string)).toEqual({
      inspectionUrl: "https://acme.test/check",
      siteUrl: "sc-domain:acme.test",
      languageCode: "en-US",
    });
  });

  it.each([
    [403, "forbidden"],
    [429, "quota"],
    [400, "invalid"],
    [401, "unauthorized"],
    [500, "unavailable"],
  ] as const)("classifies HTTP %i as %s", async (status, kind) => {
    expect(classifyInspectionStatus(status)).toBe(kind);
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"error":{"message":"no"}}', { status })));
    const error = await new SearchConsoleProvider("TOKEN")
      .inspectUrl("sc-domain:acme.test", "https://acme.test/x")
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(InspectionError);
    expect(error).toMatchObject({ kind, status });
  });

  it("calls a network failure unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("socket hang up"))));
    await expect(new SearchConsoleProvider("T").inspectUrl("sc-domain:acme.test", "https://acme.test/x")).rejects.toMatchObject({
      kind: "unavailable",
      status: null,
    });
  });
});
