import { describe, expect, it } from "vitest";
import { finalizeSuggestions, looksLikeKeyword } from "@/lib/visibility/propose";
import type { ProposedPrompt } from "@/lib/agents/propose-prompts";

function prompt(query: string, extra: Partial<ProposedPrompt> = {}): ProposedPrompt {
  return {
    query,
    cluster: "citations",
    intent: "commercial",
    why: "A buyer would type this.",
    ...extra,
  };
}

describe("looksLikeKeyword", () => {
  it("drops short category fragments and definitions", () => {
    expect(looksLikeKeyword("AEO vs SEO")).toBe(true);
    expect(looksLikeKeyword("content calendar automation")).toBe(true);
    expect(looksLikeKeyword("what is AEO")).toBe(true);
  });

  it("keeps a question a person would type", () => {
    expect(looksLikeKeyword("how do I get my site cited by ChatGPT")).toBe(false);
    expect(looksLikeKeyword("best AI SEO writer for a small business")).toBe(false);
    expect(looksLikeKeyword("tool that publishes SEO articles to WordPress")).toBe(false);
  });
});

describe("finalizeSuggestions", () => {
  it("drops keyword leftovers and duplicates of the current set", () => {
    const kept = finalizeSuggestions(
      [
        prompt("AEO vs SEO"),
        prompt("how do I get cited by ChatGPT"),
        prompt("how do I get cited by ChatGPT"),
        prompt("best AI writer that publishes to WordPress"),
      ],
      ["how do I get cited by ChatGPT"],
    );
    expect(kept.map((p) => p.query)).toEqual([
      "best AI writer that publishes to WordPress",
    ]);
  });

  it("does not invent prompts to fill a short list", () => {
    const kept = finalizeSuggestions([prompt("AEO vs SEO")], []);
    expect(kept).toEqual([]);
  });
});
