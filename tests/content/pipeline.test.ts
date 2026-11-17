import { describe, expect, it } from "vitest";
import { runContentPipeline } from "@/lib/content/pipeline";
import {
  CLEAN_HTML_OUTPUT,
  FENCED_OUTPUT,
  MARKDOWN_OUTPUT,
  PROMPT_LEAKED_OUTPUT,
  TOO_SHORT_OUTPUT,
} from "../fixtures/model-output";

const run = (raw: string) =>
  runContentPipeline({
    raw,
    articleId: "11111111-2222-3333-4444-555555555555",
    keyword: "automated unique discount codes email",
    slug: "automated-unique-discount-codes-email",
    language: "en",
    scheduledDate: "2026-08-02",
    verbose: false,
  });

describe("pipeline: clean HTML", () => {
  const result = run(CLEAN_HTML_OUTPUT);

  it("publishes", () => {
    expect(result.decision).toBe("publish");
  });

  it("takes the title from the h1 and removes it from the body", () => {
    expect(result.article?.title).toBe(
      "How to Boost Conversions with Automated Unique Discount Codes"
    );
    expect(result.article?.bodyHtml).not.toContain("<h1");
  });

  it("anchors every h2/h3 and mirrors them in the outline", () => {
    const article = result.article!;
    expect(article.headings.length).toBeGreaterThan(2);
    for (const heading of article.headings) {
      expect(heading.id).not.toBe("");
      expect(article.bodyHtml).toContain(`id="${heading.id}"`);
    }
  });

  it("builds an excerpt from the first paragraph", () => {
    expect(result.article?.excerpt).toMatch(/^Generic discount codes leak/);
    expect(result.article?.metaDescription.length).toBeLessThanOrEqual(160);
  });
});

describe("pipeline: Markdown input", () => {
  const result = run(MARKDOWN_OUTPUT);

  it("publishes an article with no Markdown left in it", () => {
    expect(result.decision).toBe("publish");
    expect(result.article?.bodyHtml).not.toMatch(/^\s*#{1,6}\s/m);
    expect(result.article?.bodyHtml).not.toMatch(/\*\*/);
  });

  it("keeps every structural element", () => {
    const body = result.article!.bodyHtml;
    expect(body).toContain("<ul>");
    expect(body).toContain("<ol>");
    expect(body).toContain("<blockquote>");
    expect(body).toContain("<table>");
    expect(body).toContain("<strong>");
    expect(body).toContain("<em>");
    expect(body).toContain("<a href=");
  });
});

describe("pipeline: code-fenced output", () => {
  it("unwraps the fence and publishes normally", () => {
    const result = run(FENCED_OUTPUT);
    expect(result.decision).toBe("publish");
    expect(result.article?.bodyHtml).not.toContain("```");
  });
});

describe("pipeline: the production failure (prompt leakage)", () => {
  const result = run(PROMPT_LEAKED_OUTPUT);

  it("never publishes automatically", () => {
    expect(result.decision).toBe("needs_review");
  });

  it("detects the leaked preamble", () => {
    expect(result.issues.map((i) => i.code)).toContain("PROMPT_LEAKAGE");
  });

  it("recovers the real title instead of the brief", () => {
    expect(result.article?.title).toBe(
      "How to Boost Conversions with Automated Unique Discount Codes"
    );
    expect(result.article?.title).not.toContain("900-1500");
    expect(result.article?.title.length).toBeLessThan(120);
  });

  it("keeps the brief out of the body", () => {
    const body = result.article!.bodyHtml;
    expect(body).not.toContain("Expert SEO Content Writer");
    expect(body).not.toContain("Primary Keyword:");
    expect(body).not.toContain("900-1500 words");
  });

  it("produces clean heading anchors, not slugs made of prompt text", () => {
    for (const heading of result.article!.headings) {
      expect(heading.id.length).toBeLessThan(80);
      expect(heading.text.length).toBeLessThan(120);
      expect(heading.text).not.toContain("Primary Keyword");
    }
  });
});

describe("pipeline: unusable output", () => {
  it("asks for regeneration when the response is empty", () => {
    const result = run("");
    expect(result.decision).toBe("regenerate");
    expect(result.article).toBeNull();
    expect(result.issues.map((i) => i.code)).toContain("EMPTY_OUTPUT");
  });

  it("asks for regeneration when the response is far too short", () => {
    const result = run(TOO_SHORT_OUTPUT);
    expect(result.decision).toBe("regenerate");
  });

  it("asks for regeneration when there is no article start", () => {
    const result = run("Sure! Here is a summary of what I would write. ".repeat(20));
    expect(result.decision).toBe("regenerate");
    expect(result.issues.map((i) => i.code)).toContain("NO_DOCUMENT_START");
  });
});

describe("pipeline: determinism", () => {
  it("gives the same result for the same input", () => {
    const a = run(MARKDOWN_OUTPUT);
    const b = run(MARKDOWN_OUTPUT);
    expect(a.article).toEqual(b.article);
    expect(a.decision).toBe(b.decision);
  });

  it("is idempotent: re-running over its own output changes nothing", () => {
    const first = run(CLEAN_HTML_OUTPUT);
    const again = run(
      `<h1>${first.article!.title}</h1>\n${first.article!.bodyHtml}`
    );
    expect(again.article?.title).toBe(first.article?.title);
    expect(again.article?.bodyHtml).toBe(first.article?.bodyHtml);
    expect(again.article?.headings).toEqual(first.article?.headings);
  });
});
