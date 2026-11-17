import { describe, expect, it } from "vitest";
import { buildLlmsTxt, LLMS_TXT_POST_CAP, type LlmsTxtInput, type LlmsTxtPost } from "@/lib/llms-txt";
import { DOC_SECTIONS } from "@/components/docs/sections";
import { SITE_SUMMARY } from "@/lib/site";

/**
 * /llms.txt is built from what the site publishes: the docs' sections, the
 * published posts with their stored meta description, newest first and
 * capped. A title or a description cannot break out of its line or its link.
 */

const post = (slug: string, title = `Title ${slug}`, metaDescription = `About ${slug}.`): LlmsTxtPost => ({ slug, title, metaDescription });

const input = (posts: LlmsTxtInput["posts"]): LlmsTxtInput => ({
  siteUrl: "https://gettrafficfa.st/",
  siteName: "GetTrafficFast",
  tagline: "A content operating system.",
  summary: SITE_SUMMARY,
  docSections: DOC_SECTIONS,
  posts,
});

describe("buildLlmsTxt", () => {
  it("opens with the name, the tagline and the summary, then links every docs section and pricing", () => {
    const text = buildLlmsTxt(input([]));
    const lines = text.split("\n");
    expect(lines.slice(0, 5)).toEqual(["# GetTrafficFast", "", "> A content operating system.", "", SITE_SUMMARY]);
    for (const section of DOC_SECTIONS) {
      expect(text).toContain(`- [${section.title}](https://gettrafficfa.st/docs#${section.id})`);
    }
    expect(text).toContain("- [Pricing](https://gettrafficfa.st/pricing): ");
    expect(text).toContain("- [Blog](https://gettrafficfa.st/blog): ");
    expect(text.endsWith("\n")).toBe(true);
  });

  it("states no number about GetTrafficFast", () => {
    // The owner's rule: no early results quoted. The only digits are in URLs.
    const withoutUrls = buildLlmsTxt(input([])).replace(/\(https?:[^)]*\)/g, "");
    expect(withoutUrls).not.toMatch(/\d/);
  });

  it("lists the posts in the order given (newest first), with the stored description", () => {
    const text = buildLlmsTxt(input([post("newest"), post("older")]));
    const newest = text.indexOf("- [Title newest](https://gettrafficfa.st/blog/newest): About newest.");
    const older = text.indexOf("- [Title older](https://gettrafficfa.st/blog/older): About older.");
    expect(newest).toBeGreaterThan(0);
    expect(older).toBeGreaterThan(newest);
  });

  it(`stops at ${LLMS_TXT_POST_CAP} posts`, () => {
    const posts = Array.from({ length: LLMS_TXT_POST_CAP + 5 }, (_, i) => post(`p-${i}`));
    const text = buildLlmsTxt(input(posts));
    expect(text.match(/\(https:\/\/gettrafficfa\.st\/blog\/p-/g)).toHaveLength(LLMS_TXT_POST_CAP);
    expect(text).toContain(`/blog/p-${LLMS_TXT_POST_CAP - 1})`);
    expect(text).not.toContain(`/blog/p-${LLMS_TXT_POST_CAP})`);
  });

  it("escapes a title that would close the link, and keeps every field on one line", () => {
    const text = buildLlmsTxt(
      input([post("a-(b)", "Brackets [x] and \\ slash\n## Not a heading", "First line.\n\n# Injected\nlast")])
    );
    const line = text.split("\n").find((l) => l.includes("/blog/a-"));
    expect(line).toBe(
      "- [Brackets \\[x\\] and \\\\ slash ## Not a heading](https://gettrafficfa.st/blog/a-%28b%29): First line. # Injected last"
    );
    expect(text.split("\n").filter((l) => l.startsWith("#"))).toEqual(["# GetTrafficFast", "## Docs", "## Product", "## Blog"]);
  });

  it("cuts a long description at a word, and leaves out an empty one", () => {
    const long = `${"word ".repeat(100)}end`;
    const text = buildLlmsTxt(input([post("long", "Long", long), post("bare", "Bare", "  ")]));
    const longLine = text.split("\n").find((l) => l.includes("/blog/long"))!;
    const description = longLine.split("): ")[1];
    expect(description.length).toBeLessThanOrEqual(301);
    expect(description.endsWith("word…")).toBe(true);
    expect(text).toContain("- [Bare](https://gettrafficfa.st/blog/bare)\n");
  });

  it("skips a row with no slug or no title: there is no page to point at", () => {
    const text = buildLlmsTxt(input([post("", "No slug"), post("no-title", " "), post("ok")]));
    expect(text).not.toContain("No slug");
    expect(text).not.toContain("/blog/no-title");
    expect(text).toContain("/blog/ok)");
  });

  it("still serves the site when the posts could not be read", () => {
    const text = buildLlmsTxt(input(null));
    expect(text).toContain("## Docs");
    expect(text).toContain("- [Blog](https://gettrafficfa.st/blog)");
    expect(text).not.toContain("/blog/");
  });
});
