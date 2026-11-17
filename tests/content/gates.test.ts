import { describe, expect, it } from "vitest";
import { runQualityGates } from "@/lib/content/quality/gates";
import { CANONICAL_SCHEMA_VERSION, CanonicalArticle, decisionFor } from "@/lib/content/types";

function article(overrides: Partial<CanonicalArticle> = {}): CanonicalArticle {
  return {
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    articleId: "id",
    title: "A Perfectly Reasonable Article Title",
    bodyHtml:
      '<p><strong>The short version:</strong> A direct answer. It stands on its own. It says what to do.</p>' +
      '<p>An opening paragraph that reads like a real article.</p>' +
      '<h2 id="one">One?</h2><p>Body.</p><h2 id="two">Two?</h2><p>Body.</p>',
    headings: [
      { level: 2, id: "one", text: "One?" },
      { level: 2, id: "two", text: "Two?" },
    ],
    excerpt: "An opening paragraph that reads like a real article.",
    metaDescription: "An opening paragraph that reads like a real article.",
    wordCount: 1200,
    slug: "slug",
    keyword: "keyword",
    language: "en",
    scheduledDate: null,
    ...overrides,
  };
}

const codes = (a: CanonicalArticle) => runQualityGates(a).map((i) => i.code);

describe("quality gates", () => {
  it("passes a healthy article", () => {
    const issues = runQualityGates(article());
    expect(issues).toEqual([]);
    expect(decisionFor(issues)).toBe("publish");
  });

  it("blocks an empty body", () => {
    expect(codes(article({ bodyHtml: "  " }))).toContain("EMPTY_BODY");
  });

  it("regenerates an article below the hard word floor", () => {
    const issues = runQualityGates(article({ wordCount: 120 }));
    expect(decisionFor(issues)).toBe("regenerate");
  });

  it("asks for review when the article is thin", () => {
    const issues = runQualityGates(article({ wordCount: 450 }));
    expect(decisionFor(issues)).toBe("needs_review");
    expect(issues.map((i) => i.code)).toContain("ARTICLE_TOO_SHORT");
  });

  it("asks for review when there are not enough sections", () => {
    expect(
      codes(
        article({
          bodyHtml: '<p>Only text.</p><h2 id="one">One</h2><p>Body.</p>',
          headings: [{ level: 2, id: "one", text: "One" }],
        })
      )
    ).toContain("INSUFFICIENT_SECTIONS");
  });

  it("detects leftover Markdown in the prose", () => {
    expect(
      codes(article({ bodyHtml: article().bodyHtml + "<p>### Still a heading</p>" }))
    ).toContain("MARKDOWN_RESIDUE");
    expect(
      codes(article({ bodyHtml: article().bodyHtml + "<p>Some **bold** text</p>" }))
    ).toContain("MARKDOWN_RESIDUE");
  });

  it("ignores Markdown-looking characters inside code samples", () => {
    expect(
      codes(article({ bodyHtml: article().bodyHtml + "<pre><code>a ** b</code></pre>" }))
    ).not.toContain("MARKDOWN_RESIDUE");
  });

  it("detects a plan or brief presented as an article", () => {
    const leaked = article({
      bodyHtml:
        "<p>900-1500 words. Output only valid HTML.</p>" +
        "<p>Primary Keyword: discount codes</p>" +
        article().bodyHtml,
    });
    expect(codes(leaked)).toContain("CHAIN_OF_THOUGHT");
  });

  it("does not flag a normal SEO article that merely mentions the topic", () => {
    const seo = article({
      bodyHtml:
        "<p>Avoid keyword stuffing when you write for search engines.</p>" +
        article().bodyHtml,
    });
    expect(codes(seo)).not.toContain("CHAIN_OF_THOUGHT");
  });

  it("flags an h1 that survived into the body", () => {
    expect(codes(article({ bodyHtml: "<h1>Title again</h1>" + article().bodyHtml }))).toContain(
      "DUPLICATE_H1"
    );
  });

  it("flags an outline that does not match the body", () => {
    expect(
      codes(article({ headings: [{ level: 2, id: "missing", text: "Nowhere" }] }))
    ).toContain("HEADING_ANCHOR_MISMATCH");
  });

  it("flags an absurdly long title", () => {
    expect(codes(article({ title: "x".repeat(400) }))).toContain("TITLE_TOO_LONG");
  });
});
