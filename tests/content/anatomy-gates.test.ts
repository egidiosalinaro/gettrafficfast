import { describe, expect, it } from "vitest";
import { runContentPipeline } from "@/lib/content/pipeline";
import { runQualityGates } from "@/lib/content/quality/gates";
import { blockingReasons } from "@/lib/content/quality/blocking";
import { withReadNext } from "@/lib/content/anatomy";
import { CANONICAL_SCHEMA_VERSION, CanonicalArticle, REVISABLE_ISSUES, decisionFor } from "@/lib/content/types";

/**
 * The anatomy as gates (2026-11-15): a missing or long short version and
 * statement headings send the draft to the one revision and never hold it;
 * a "From our data" figure the owner never gave holds it, the one objective
 * problem; the Read next block is not read as the article's prose.
 */

const SHORT = "<p><strong>The short version:</strong> Plan four weeks ahead. One person owns the calendar. Each slot names a question.</p>";

function article(body: string, headings: string[], overrides: Partial<CanonicalArticle> = {}): CanonicalArticle {
  return {
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    articleId: "id",
    title: "How to build a content calendar",
    bodyHtml: body,
    headings: headings.map((text, i) => ({ level: 2, id: `h${i}`, text })),
    excerpt: "Plan four weeks ahead.",
    metaDescription: "Plan four weeks ahead.",
    wordCount: 1100,
    slug: "content-calendar",
    keyword: "content calendar",
    language: "en",
    scheduledDate: null,
    ...overrides,
  };
}

function body(headings: string[], opening = SHORT, extra = ""): string {
  return `${opening}<p>Intro.</p>${headings.map((h, i) => `<h2 id="h${i}">${h}</h2><p>Body.</p>`).join("")}${extra}`;
}

const QUESTIONS = ["What goes in it?", "How do you fill it?", "Who owns it?", "What to do next"];
const codes = (a: CanonicalArticle, facts?: string) => runQualityGates(a, facts === undefined ? {} : { facts, evidence: "" });

describe("the answer first", () => {
  it("is quiet on an article that opens with the short version under question headings", () => {
    expect(codes(article(body(QUESTIONS), QUESTIONS))).toEqual([]);
  });

  it("asks the revision for the short version when the body does not open with it, in the site's language", () => {
    const issues = codes(article(body(QUESTIONS, ""), QUESTIONS));
    expect(issues.map((i) => i.code)).toEqual(["SHORT_VERSION"]);
    expect(issues[0].action).toBe("warn");
    expect(issues[0].message).toContain('"The short version:"');
    const italian = codes(article(body(QUESTIONS, ""), QUESTIONS, { language: "it" }));
    expect(italian[0].message).toContain('"In breve:"');
    expect(REVISABLE_ISSUES.has("SHORT_VERSION")).toBe(true);
    expect(decisionFor(issues)).toBe("publish");
    expect(blockingReasons({ issues, findings: [] })).toEqual([]);
  });

  it("asks for a shorter one over the cap", () => {
    const long = `<p><strong>The short version:</strong> ${Array.from({ length: 140 }, () => "word").join(" ")}.</p>`;
    const issues = codes(article(body(QUESTIONS, long), QUESTIONS));
    expect(issues.map((i) => i.code)).toEqual(["SHORT_VERSION"]);
    expect(issues[0].message).toContain("140 words");
  });

  it("asks for question headings when fewer than half are, and never holds the article for it", () => {
    const statements = ["What goes in it", "Filling it", "Ownership", "What to do next"];
    const issues = codes(article(body(statements), statements));
    expect(issues.map((i) => i.code)).toEqual(["QUESTION_HEADINGS"]);
    expect(issues[0].message).toContain("Only 0 of 4");
    expect(issues[0].action).toBe("warn");
    expect(REVISABLE_ISSUES.has("QUESTION_HEADINGS")).toBe(true);
  });
});

describe("From our data", () => {
  const OWN = "Between September and November 2026 we tested 400 prompts across three answer engines.\nWe publish for 14 sites.";
  const withData = (section: string) => {
    const headings = [...QUESTIONS.slice(0, 3), "From our data", "What to do next"];
    const html = `${SHORT}<p>Intro.</p>${QUESTIONS.slice(0, 3)
      .map((h, i) => `<h2 id="h${i}">${h}</h2><p>Body.</p>`)
      .join("")}<h2 id="h3">From our data</h2><p>${section}</p><h2 id="h4">What to do next</h2><p>Body.</p>`;
    return article(html, headings);
  };

  it("lets the owner's own measurement through", () => {
    expect(codes(withData("Between September and November 2026 we tested 400 prompts across three engines."), OWN)).toEqual([]);
  });

  it("holds a figure the owner never gave: a number presented as the site's own data", () => {
    const issues = codes(withData("We tested 400 prompts and 37% of answers cited a blog."), OWN);
    const data = issues.filter((i) => i.code === "DATA_SECTION");
    expect(data).toHaveLength(1);
    expect(data[0].action).toBe("review");
    expect(data[0].message).toContain("37");
    expect(blockingReasons({ issues, findings: [] }).map((r) => r.code)).toContain("DATA_SECTION");
  });

  it("asks the revision to drop a weak early figure, and to drop the section when no fact may go in it", () => {
    const weak = codes(withData("We tested 400 prompts. We publish for 14 sites."), OWN).filter((i) => i.code === "DATA_SECTION");
    expect(weak.map((i) => i.action)).toEqual(["warn"]);
    expect(weak[0].message).toContain("14");
    const none = codes(withData("We publish for 14 sites."), "We publish for 14 sites.").filter((i) => i.code === "DATA_SECTION");
    expect(none.map((i) => i.action)).toEqual(["warn"]);
    expect(none[0].message).toContain("remove the section");
  });

  it("is not checked for a caller that passes no facts", () => {
    expect(codes(withData("We tested 400 prompts and 37% of answers cited a blog."))).toEqual([]);
  });
});

describe("Read next is not the article's prose", () => {
  it("does not count as the closing section, a list, or a mention of the business", () => {
    const headings = ["What goes in it?", "How do you fill it?", "What to do next"];
    const html = body(headings, SHORT).replace(
      '<h2 id="h2">What to do next</h2><p>Body.</p>',
      '<h2 id="h2">What to do next</h2><p>Body. Crumb plans calendars for bakeries.</p>'
    );
    const linked = withReadNext(article(html, headings), [
      { title: "Why Crumb ranks first for $49 loaves", href: "https://crumb.example/blog/a" },
      { title: "Crumb's 3 calendar templates", href: "https://crumb.example/blog/b" },
    ]);
    const issues = runQualityGates(linked, { businessName: "Crumb", websiteUrl: "https://crumb.example", facts: "", evidence: "" });
    expect(issues).toEqual([]);
  });
});

describe("canonicalisation", () => {
  it("builds the excerpt from the short version's answer, without its label", () => {
    const result = runContentPipeline({
      raw: `<h1>How to build a content calendar</h1>${body(QUESTIONS)}`,
      articleId: "a",
      keyword: "content calendar",
      slug: "content-calendar",
      language: "en",
      scheduledDate: null,
    });
    expect(result.article?.excerpt).toBe("Plan four weeks ahead. One person owns the calendar. Each slot names a question.");
    expect(result.article?.bodyHtml).toContain("<strong>The short version:</strong>");
  });
});
