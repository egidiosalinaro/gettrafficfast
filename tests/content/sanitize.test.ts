import { describe, expect, it } from "vitest";
import { sanitizeHtml } from "@/lib/content/stages/sanitize";

describe("sanitization", () => {
  it("removes scripts and styles with their content", () => {
    const { html } = sanitizeHtml("<p>keep</p><script>steal()</script><style>.a{}</style>");
    expect(html).toContain("<p>keep</p>");
    expect(html).not.toContain("steal()");
    expect(html).not.toContain(".a{}");
  });

  it("unwraps unknown elements but keeps their text", () => {
    const { html } = sanitizeHtml("<div><span>important words</span></div>");
    expect(html).not.toContain("<div>");
    expect(html).not.toContain("<span>");
    expect(html).toContain("important words");
  });

  it("strips inline event handlers", () => {
    const { html } = sanitizeHtml('<p onclick="hack()">text</p>');
    expect(html).not.toContain("onclick");
    expect(html).toContain("text");
  });

  it("drops javascript: urls but keeps the link text", () => {
    const { html } = sanitizeHtml('<a href="javascript:alert(1)">click</a>');
    expect(html).not.toContain("javascript:");
    expect(html).toContain("click");
  });

  it("keeps safe links and their attributes", () => {
    const { html } = sanitizeHtml('<a href="https://example.com" title="t" data-x="1">link</a>');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('title="t"');
    expect(html).not.toContain("data-x");
  });

  it("reports what it removed", () => {
    const { issues } = sanitizeHtml("<script>x()</script><p>ok</p>");
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("UNSAFE_MARKUP_REMOVED");
    expect(issues[0].action).toBe("warn");
  });

  it("leaves a clean document untouched", () => {
    const input = "<h2>Title</h2><p>Body with <strong>bold</strong>.</p>";
    expect(sanitizeHtml(input).html).toBe(input);
  });
});
