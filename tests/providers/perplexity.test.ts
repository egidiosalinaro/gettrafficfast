import { describe, expect, it } from "vitest";
import { parsePerplexityResponse } from "@/lib/providers/citations/perplexity";

/**
 * The provider's only job is mapping the vendor payload onto the platform
 * shape. It matters more than it looks: a probe that reads the wrong field and
 * finds no sources is indistinguishable from "we were not cited", and that
 * confusion would corrupt the only metric behind the AEO claim.
 */

describe("parsePerplexityResponse", () => {
  it("reads sources from search_results, with their titles", () => {
    const answer = parsePerplexityResponse("how to season a cast iron pan", {
      choices: [{ message: { content: "  Heat oil to smoking point.  " } }],
      search_results: [
        { title: "Seasoning guide", url: "https://example.com/seasoning" },
        { title: "Cast iron basics", url: "https://other.test/basics" },
      ],
    });

    expect(answer.answer).toBe("Heat oil to smoking point.");
    expect(answer.sources).toEqual([
      { url: "https://example.com/seasoning", domain: "example.com", title: "Seasoning guide" },
      { url: "https://other.test/basics", domain: "other.test", title: "Cast iron basics" },
    ]);
  });

  it("still finds sources when the model only returns bare citations", () => {
    const answer = parsePerplexityResponse("q", {
      citations: ["https://www.example.com/a", "https://other.test/b"],
    });

    expect(answer.sources.map((s) => s.domain)).toEqual(["example.com", "other.test"]);
    expect(answer.sources[0].title).toBe("");
  });

  it("merges both fields without counting the same source twice", () => {
    const answer = parsePerplexityResponse("q", {
      search_results: [{ title: "A", url: "https://example.com/a" }],
      citations: ["https://example.com/a/", "https://third.test/c"],
    });

    expect(answer.sources).toHaveLength(2);
    expect(answer.sources[0].title).toBe("A");
    expect(answer.sources[1].domain).toBe("third.test");
  });

  it("drops entries that carry no usable url", () => {
    const answer = parsePerplexityResponse("q", {
      search_results: [{ title: "No link" }, { title: "Broken", url: "not-a-url" }],
      citations: ["", "   "],
    });

    expect(answer.sources).toEqual([]);
  });

  it("keeps the payload verbatim and tags the engine", () => {
    const payload = { citations: ["https://example.com/a"] };
    const answer = parsePerplexityResponse("q", payload, "perplexity");

    expect(answer.engine).toBe("perplexity");
    expect(answer.query).toBe("q");
    expect(answer.raw).toBe(payload);
  });
});
