import { describe, expect, it } from "vitest";
import { normalizeToHtml } from "@/lib/content/stages/normalize";
import { sanitizeHtml } from "@/lib/content/stages/sanitize";

/**
 * Every Markdown construct the platform may receive must survive normalization
 * as its HTML equivalent. A regression here is what put raw "###" and "***" on
 * a customer's site.
 */

const convert = (markdown: string) => sanitizeHtml(normalizeToHtml(markdown).html).html;

describe("normalization: Markdown → HTML", () => {
  it("converts headings at every level", () => {
    const html = convert("# One\n\n## Two\n\n### Three");
    expect(html).toContain("<h1>One</h1>");
    expect(html).toContain("<h2>Two</h2>");
    expect(html).toContain("<h3>Three</h3>");
    expect(html).not.toContain("#");
  });

  it("converts paragraphs and keeps their text intact", () => {
    const html = convert("First paragraph.\n\nSecond paragraph.");
    expect(html).toContain("<p>First paragraph.</p>");
    expect(html).toContain("<p>Second paragraph.</p>");
  });

  it("converts unordered lists", () => {
    const html = convert("- alpha\n- beta\n- gamma");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>alpha</li>");
    expect(html).toContain("<li>gamma</li>");
    expect(html).not.toMatch(/^\s*-\s/m);
  });

  it("converts ordered lists", () => {
    const html = convert("1. first\n2. second");
    expect(html).toContain("<ol>");
    expect(html).toContain("<li>first</li>");
  });

  it("converts blockquotes", () => {
    const html = convert("> quoted line");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("quoted line");
    expect(html).not.toContain("&gt; quoted");
  });

  it("converts fenced code blocks", () => {
    const html = convert("```js\nconst a = 1;\n```");
    expect(html).toContain("<pre>");
    expect(html).toContain("<code");
    expect(html).toContain("const a = 1;");
  });

  it("converts inline code", () => {
    const html = convert("Call `generateCode()` at send time.");
    expect(html).toContain("<code>generateCode()</code>");
  });

  it("converts links", () => {
    const html = convert("Read the [guide](https://example.com/guide) first.");
    expect(html).toContain('<a href="https://example.com/guide">guide</a>');
    expect(html).not.toContain("](");
  });

  it("converts images", () => {
    const html = convert("![Alt text](https://example.com/a.png)");
    expect(html).toContain('src="https://example.com/a.png"');
    expect(html).toContain('alt="Alt text"');
  });

  it("converts tables", () => {
    const html = convert("| Flow | Rate |\n| --- | --- |\n| Welcome | 12% |");
    expect(html).toContain("<table>");
    expect(html).toContain("<th>Flow</th>");
    expect(html).toContain("<td>Welcome</td>");
  });

  it("converts bold and italic, including the *** combination", () => {
    const html = convert("**bold** and *italic* and ***both***");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    // The old regex left orphan asterisks here; a real parser must not.
    expect(html).not.toContain("*");
  });

  it("converts thematic breaks", () => {
    const html = convert("above\n\n---\n\nbelow");
    expect(html).toContain("<hr");
    expect(html).not.toMatch(/^\s*---\s*$/m);
  });

  it("passes HTML through unchanged", () => {
    const html = convert("<h2>Kept</h2>\n<p>As is.</p>");
    expect(html).toContain("<h2>Kept</h2>");
    expect(html).toContain("<p>As is.</p>");
  });

  it("handles mixed HTML and Markdown in one document", () => {
    const html = convert("<h2>HTML heading</h2>\n\n- markdown item\n\n**bold**");
    expect(html).toContain("<h2>HTML heading</h2>");
    expect(html).toContain("<li>markdown item</li>");
    expect(html).toContain("<strong>bold</strong>");
  });
});
