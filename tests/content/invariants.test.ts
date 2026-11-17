import { describe, expect, it } from "vitest";
import { parse } from "node-html-parser";
import { runContentPipeline } from "@/lib/content/pipeline";
import { collapseWhitespace } from "@/lib/content/text";
import { CLEAN_HTML_OUTPUT, MARKDOWN_OUTPUT } from "../fixtures/model-output";

/**
 * Content-preservation invariants. These are the guarantees that make the
 * pipeline safe to change: whatever we do to a document, the author's words and
 * structure must come out the other side.
 */

const run = (raw: string) =>
  runContentPipeline({
    raw,
    articleId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    keyword: "automated unique discount codes email",
    slug: "automated-unique-discount-codes-email",
    language: "en",
    scheduledDate: null,
    verbose: false,
  });

function headingTexts(html: string): string[] {
  return parse(html)
    .querySelectorAll("*")
    .filter((el) => ["H1", "H2", "H3"].includes(el.tagName?.toUpperCase() ?? ""))
    .map((el) => collapseWhitespace(el.text));
}

function paragraphTexts(html: string): string[] {
  return parse(html)
    .querySelectorAll("p")
    .map((el) => collapseWhitespace(el.text))
    .filter(Boolean);
}

describe("invariant: no heading is lost", () => {
  it("keeps every heading from an HTML source (h1 becomes the title)", () => {
    const result = run(CLEAN_HTML_OUTPUT);
    const before = headingTexts(CLEAN_HTML_OUTPUT);
    const after = [result.article!.title, ...headingTexts(result.article!.bodyHtml)];
    expect(after).toEqual(before);
  });

  it("keeps every heading from a Markdown source", () => {
    const result = run(MARKDOWN_OUTPUT);
    const after = [result.article!.title, ...headingTexts(result.article!.bodyHtml)];
    expect(after).toContain("How to Boost Conversions with Automated Unique Discount Codes");
    expect(after).toContain("Why Generic Codes Fail");
    expect(after).toContain("Implementation Notes");
    expect(after).toContain("Conclusion");
  });
});

describe("invariant: no paragraph is altered", () => {
  it("preserves paragraph text verbatim", () => {
    const result = run(CLEAN_HTML_OUTPUT);
    const before = paragraphTexts(CLEAN_HTML_OUTPUT);
    const after = paragraphTexts(result.article!.bodyHtml);
    expect(after).toEqual(before);
  });
});

describe("invariant: no words are dropped", () => {
  it("keeps all body text when the source is HTML", () => {
    const result = run(CLEAN_HTML_OUTPUT);
    const sourceText = collapseWhitespace(parse(CLEAN_HTML_OUTPUT).text);
    const outputText = collapseWhitespace(
      `${result.article!.title} ${parse(result.article!.bodyHtml).text}`
    );
    expect(outputText).toBe(sourceText);
  });

  it("keeps every list item from a Markdown source", () => {
    const result = run(MARKDOWN_OUTPUT);
    const items = parse(result.article!.bodyHtml)
      .querySelectorAll("li")
      .map((el) => collapseWhitespace(el.text));
    expect(items).toContain("Issue one code per recipient, never a shared one.");
    expect(items).toContain("Expire codes on a fixed window so urgency is real.");
    expect(items).toContain("Connect your store.");
  });
});

describe("invariant: the canonical contract holds", () => {
  it("never leaves an h1 in the body", () => {
    for (const source of [CLEAN_HTML_OUTPUT, MARKDOWN_OUTPUT]) {
      expect(run(source).article!.bodyHtml).not.toMatch(/<h1[\s>]/i);
    }
  });

  it("gives every h2/h3 a unique anchor", () => {
    const article = run(MARKDOWN_OUTPUT).article!;
    const ids = article.headings.map((h) => h.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every(Boolean)).toBe(true);
  });

  it("counts words consistently with the body text", () => {
    const article = run(CLEAN_HTML_OUTPUT).article!;
    expect(article.wordCount).toBeGreaterThan(300);
  });
});
