import { describe, expect, it } from "vitest";
import { parseGeminiGroundedResponse } from "@/lib/providers/citations/gemini";
import { isGoogleHost, isSourceRedirect } from "@/lib/providers/citations/resolve";
import { findCitation } from "@/lib/lifecycle/citations";

/**
 * Grounded Gemini responses hide the source behind a Google redirect. Reading
 * the domain from that redirect instead of the chunk title would make every
 * source look like it came from google.com, and the citation rate would sit at
 * a flat zero for every customer with nothing in the logs to explain it.
 * These tests exist for exactly that failure.
 */

const redirect = (id: string) =>
  `https://vertexaisearch.cloud.google.com/grounding-api-redirect/${id}`;

describe("parseGeminiGroundedResponse", () => {
  it("reads the domain from the title when the uri is a Google redirect", () => {
    const answer = parseGeminiGroundedResponse("how to season cast iron", {
      candidates: [
        {
          content: { parts: [{ text: "Heat the oil " }, { text: "to smoking point." }] },
          groundingMetadata: {
            groundingChunks: [
              { web: { uri: redirect("abc"), title: "customer.test" } },
              { web: { uri: redirect("def"), title: "competitor.test" } },
            ],
          },
        },
      ],
    });

    expect(answer.engine).toBe("gemini");
    expect(answer.answer).toBe("Heat the oil to smoking point.");
    expect(answer.sources.map((s) => s.domain)).toEqual(["customer.test", "competitor.test"]);
    // The redirect is kept as the link: it is the only URL Google gives us.
    expect(answer.sources[0].url).toContain("grounding-api-redirect");
  });

  it("finds our site through a redirected source, which is the whole point", () => {
    const answer = parseGeminiGroundedResponse("q", {
      candidates: [
        {
          groundingMetadata: {
            groundingChunks: [{ web: { uri: redirect("x"), title: "customer.test" } }],
          },
        },
      ],
    });

    const match = findCitation(answer.sources, "https://customer.test/blog/post");
    expect(match).not.toBeNull();
    // Domain-level, not exact: grounding never tells us which page was used.
    expect(match?.exact).toBe(false);
  });

  it("uses the real host when the uri is not a redirect", () => {
    const answer = parseGeminiGroundedResponse("q", {
      candidates: [
        {
          groundingMetadata: {
            groundingChunks: [{ web: { uri: "https://www.direct.test/page", title: "Direct" } }],
          },
        },
      ],
    });
    expect(answer.sources[0].domain).toBe("direct.test");
  });

  it("counts a domain once even when grounding cites it repeatedly", () => {
    const answer = parseGeminiGroundedResponse("q", {
      candidates: [
        {
          groundingMetadata: {
            groundingChunks: [
              { web: { uri: redirect("1"), title: "customer.test" } },
              { web: { uri: redirect("2"), title: "customer.test" } },
            ],
          },
        },
      ],
    });
    expect(answer.sources).toHaveLength(1);
  });

  it("returns no sources when the answer was not grounded at all", () => {
    const answer = parseGeminiGroundedResponse("q", {
      candidates: [{ content: { parts: [{ text: "From memory." }] } }],
    });
    expect(answer.sources).toEqual([]);
    expect(answer.answer).toBe("From memory.");
  });
});

describe("Google hosts are matched on the label boundary", () => {
  it("accepts Google's hosts and their subdomains", () => {
    for (const host of ["google.com", "www.google.com", "vertexaisearch.cloud.google.com", "googleapis.com", "storage.googleapis.com", "Cloud.Google.Com"]) {
      expect(isGoogleHost(host)).toBe(true);
    }
  });

  it("rejects look-alikes that merely end with the same letters", () => {
    for (const host of ["evilgoogle.com", "notgoogleapis.com", "google.com.evil.test", "google.co", ""]) {
      expect(isGoogleHost(host)).toBe(false);
    }
  });

  it("does not treat a look-alike redirect as a source redirect", () => {
    expect(isSourceRedirect("https://evilgoogle.com/grounding-api-redirect/abc")).toBe(false);
    expect(isSourceRedirect("https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc")).toBe(true);
  });

  it("keeps a look-alike chunk's own domain instead of reading the title", () => {
    const answer = parseGeminiGroundedResponse("q", {
      candidates: [
        { groundingMetadata: { groundingChunks: [{ web: { uri: "https://evilgoogle.com/page", title: "customer.test" } }] } },
      ],
    });
    expect(answer.sources.map((s) => s.domain)).toEqual(["evilgoogle.com"]);
  });
});
