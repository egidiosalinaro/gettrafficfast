import { describe, expect, it } from "vitest";
import { MAX_WORDS, runQualityGates } from "@/lib/content/quality/gates";
import {
  lookalikeHosts,
  numberClaims,
  privateFigures,
  productMentionProblems,
  readStructure,
  undeliveredTitlePromise,
  unsupportedNumbers,
} from "@/lib/content/quality/claims";
import { articleTells, bannedTitleWord } from "@/lib/content/quality/tells";
import { CANONICAL_SCHEMA_VERSION, CanonicalArticle, REVISABLE_ISSUES, decisionFor } from "@/lib/content/types";

/**
 * The editorial gates, against the sentences production published before
 * 2026-11-10. Each fixture is quoted from an article that went out.
 */

const p = (text: string) => `<p>${text}</p>`;
const filler = (words: number) => Array.from({ length: words }, () => "word").join(" ");

function article(overrides: Partial<CanonicalArticle> = {}): CanonicalArticle {
  return {
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    articleId: "id",
    title: "How to plan a content calendar",
    bodyHtml:
      p("A content calendar says what is published, where and when.") +
      '<h2 id="one">One</h2>' +
      p("Body.") +
      '<h2 id="two">Two</h2>' +
      p("Body."),
    headings: [
      { level: 2, id: "one", text: "One" },
      { level: 2, id: "two", text: "Two" },
    ],
    excerpt: "A content calendar says what is published, where and when.",
    metaDescription: "A content calendar says what is published, where and when.",
    wordCount: 1200,
    slug: "slug",
    keyword: "content calendar",
    language: "en",
    scheduledDate: null,
    ...overrides,
  };
}

const withBody = (html: string, more: Partial<CanonicalArticle> = {}) =>
  article({ bodyHtml: `${html}<h2 id="one">One</h2>${p("Body.")}<h2 id="two">Two</h2>${p("Body.")}`, ...more });

const codes = (a: CanonicalArticle, context = {}) => runQualityGates(a, context).map((i) => i.code);

describe("stock phrases", () => {
  it.each([
    "The landscape of content creation is rapidly evolving, and automation is no longer a luxury but a strategic necessity.",
    "In today's competitive digital landscape, visibility is everything.",
    "GetTrafficFast offers an unparalleled solution for teams that want to grow.",
    "Nel panorama digitale di oggi, la visibilità è tutto.",
  ])("flags %s", (sentence) => {
    expect(articleTells(sentence).length).toBeGreaterThan(0);
    expect(codes(withBody(p(sentence)))).toContain("STOCK_PHRASE");
  });

  it("names the words it found, for the revision", () => {
    const issue = runQualityGates(withBody(p("In today's competitive digital landscape, visibility is everything."))).find(
      (i) => i.code === "STOCK_PHRASE"
    );
    expect(issue?.message).toContain("In today's competitive digital landscape");
    expect(issue?.action).toBe("warn");
    expect(REVISABLE_ISSUES.has("STOCK_PHRASE")).toBe(true);
  });

  it("stays quiet on plain sentences about the same subject", () => {
    expect(articleTells("A content calendar lists what you publish this week. Today's post is about email.")).toEqual([]);
    expect(articleTells("The market changed in 2024 when the pricing moved to per-seat.")).toEqual([]);
  });
});

describe("titles", () => {
  it.each(["Mastering SEO Content", "Unlock Organic Growth", "The Ultimate Checklist", "A Definitive Guide", "The AEO Blueprint", "Unleash Your Blog"])(
    "refuses the word in %s",
    (title) => {
      expect(bannedTitleWord(title)).not.toBeNull();
      expect(codes(article({ title }))).toContain("TITLE_STYLE");
    }
  );

  it("refuses a title over 60 characters, as production wrote them (118)", () => {
    const title =
      "Mastering AI Content Automation: The Definitive Blueprint for Scaling Organic Traffic and Revenue Outcomes in 2026 Now";
    const issue = runQualityGates(article({ title })).find((i) => i.code === "TITLE_STYLE");
    expect(issue?.message).toContain("118 characters");
    expect(issue?.message).toContain("Mastering");
  });

  it("accepts a plain title of 60 characters or fewer", () => {
    expect(codes(article({ title: "How to build a content calendar in a spreadsheet" }))).not.toContain("TITLE_STYLE");
    expect(bannedTitleWord("How masters of the craft unlocked nothing")).toBe("unlocked");
    expect(bannedTitleWord("A master list of content ideas")).toBeNull();
  });

  it('flags "Ranked by SEO Performance & Revenue Outcomes" over a body that ranks nothing', () => {
    const title = "AI Writing Tools Ranked by SEO Performance & Revenue Outcomes";
    expect(undeliveredTitlePromise(title, p("Some tools are good."), [])).toContain("ranks nothing");
    expect(codes(article({ title }))).toContain("TITLE_UNDELIVERED");
    expect(undeliveredTitlePromise(title, "<ol><li>A</li><li>B</li></ol>", [])).toBeNull();
  });

  it("wants a table behind a comparison and N items behind a count", () => {
    expect(undeliveredTitlePromise("Postwren vs Klaviyo", p("Prose."), [])).toContain("comparison table");
    expect(undeliveredTitlePromise("Postwren vs Klaviyo", "<table><tr><td>x</td></tr></table>", [])).toBeNull();
    const seven = "<ul>" + "<li>x</li>".repeat(7) + "</ul>";
    expect(undeliveredTitlePromise("7 ways to plan content", seven, [])).toBeNull();
    expect(undeliveredTitlePromise("7 ways to plan content", "<ul><li>x</li><li>y</li></ul>", [])).toContain("7 items");
    expect(undeliveredTitlePromise("How to plan content in 2026", p("x"), [])).toBeNull();
  });
});

describe("look-alike links", () => {
  const gtf = { businessName: "GetTrafficFast", websiteUrl: "https://gettrafficfa.st" };
  const postwren = { businessName: "PostWren", websiteUrl: "https://postwren.me" };

  it("catches https://www.GetTrafficFast.com when the site is gettrafficfa.st", () => {
    const body = p('Try <a href="https://www.GetTrafficFast.com">GetTrafficFast</a> today.');
    expect(lookalikeHosts(body, gtf)).toEqual(["gettrafficfast.com"]);
    const issues = runQualityGates(withBody(body), gtf);
    expect(issues.find((i) => i.code === "LOOKALIKE_LINK")?.action).toBe("review");
    expect(decisionFor(issues)).toBe("needs_review");
  });

  it("catches https://postwren.io when the site is postwren.me, in a link or in plain text", () => {
    expect(lookalikeHosts(p('<a href="https://postwren.io/pricing">pricing</a>'), postwren)).toEqual(["postwren.io"]);
    expect(lookalikeHosts(p("See postwren.io for details."), postwren)).toEqual(["postwren.io"]);
  });

  it("accepts the real host, its subdomains and unrelated sites", () => {
    const body = p(
      '<a href="https://postwren.me/blog">a</a> <a href="https://app.postwren.me">b</a> <a href="https://www.klaviyo.com">c</a>'
    );
    expect(lookalikeHosts(body, postwren)).toEqual([]);
    expect(codes(withBody(body), postwren)).not.toContain("LOOKALIKE_LINK");
  });

  it("reports a host spelling the name when no site is on record: it cannot be verified", () => {
    expect(lookalikeHosts(p('<a href="https://postwren.io">x</a>'), { businessName: "PostWren" })).toEqual(["postwren.io"]);
  });
});

describe("the numbers gate", () => {
  const nothing = { facts: "", evidence: "" };

  it.each([
    ["PostWren earns a subjective rating of 4.2 out of 5 stars.", "rating", "4.2"],
    ["Competitors offer paid plans starting from ~$49/month.", "price", "49"],
    ["Ranking typically requires 50–200+ published articles.", "estimate", "50"],
    ["Open rates rise by 23% with segmentation.", "percentage", "23"],
    ["Il piano parte da €29 al mese e ha un voto di 4,5 su 5.", "price", "29"],
  ])("sends %s to review", (sentence, kind, value) => {
    const claims = unsupportedNumbers(p(sentence), nothing);
    expect(claims.map((c) => `${c.kind}:${c.value}`)).toContain(`${kind}:${value}`);
    const issues = runQualityGates(withBody(p(sentence)), nothing);
    const issue = issues.find((i) => i.code === "UNSUPPORTED_NUMBER");
    expect(issue?.action).toBe("review");
    expect(issue?.message).toContain(sentence.slice(0, 30));
    expect(decisionFor(issues)).toBe("needs_review");
  });

  it("lets through a figure the business itself stated", () => {
    const facts = "We publish for 14 sites. Plans start at $49 a month and 92% of drafts pass review.";
    expect(unsupportedNumbers(p("Plans start at $49 and 92% of drafts pass review."), { facts })).toEqual([]);
  });

  it("lets through a figure found in the research evidence", () => {
    const evidence = "Klaviyo pricing: plans from $45/month. Rated 4.6 out of 5 on G2.";
    expect(unsupportedNumbers(p("Klaviyo starts at $45 a month and is rated 4.6 out of 5."), { evidence })).toEqual([]);
    expect(unsupportedNumbers(p("Klaviyo starts at $60 a month."), { evidence })).toHaveLength(1);
  });

  it("does not read years, list counts or the article's own step numbers as claims", () => {
    const body =
      p("In 2026 the rules changed. Step 3 comes after step 2. Here are 7 ways to do it, in 5 minutes.") +
      "<ol><li>First, open 2 tabs.</li><li>Then pick 10 keywords.</li></ol>" +
      p("The update shipped in 2024 and typically lands in 2025 for most accounts. It is 100% free to try.");
    expect(numberClaims(body.replace(/<[^>]+>/g, " "))).toEqual([]);
    expect(codes(withBody(body), nothing)).not.toContain("UNSUPPORTED_NUMBER");
  });

  it("does not read figures inside code", () => {
    expect(unsupportedNumbers("<pre><code>discount = 0.15 * 100 # 15%</code></pre>", nothing)).toEqual([]);
  });

  it("does not run for a caller that passes neither facts nor evidence", () => {
    expect(codes(withBody(p("Open rates rise by 23%.")))).not.toContain("UNSUPPORTED_NUMBER");
  });
});

describe("length and structure", () => {
  it(`sends an article over ${MAX_WORDS} words back to be cut, without blocking it`, () => {
    const issues = runQualityGates(article({ wordCount: 3643 }));
    const issue = issues.find((i) => i.code === "ARTICLE_TOO_LONG");
    expect(issue?.action).toBe("warn");
    expect(decisionFor(issues)).toBe("publish");
    expect(codes(article({ wordCount: 1500 }))).not.toContain("ARTICLE_TOO_LONG");
  });

  it("counts subsections under 150 words, outside the FAQ", () => {
    const body =
      '<h2 id="a">A</h2><h3 id="a1">Thin one</h3>' + p(filler(40)) + '<h3 id="a2">Thin two</h3>' + p(filler(30)) +
      '<h3 id="a3">Full</h3>' + p(filler(160)) +
      '<h2 id="faq">FAQ</h2><h3 id="q1">Q1?</h3>' + p("A.") + '<h3 id="q2">Q2?</h3>' + p("A.") + '<h3 id="q3">Q3?</h3>' + p("A.");
    const reading = readStructure(body);
    expect(reading.thinSubsections).toEqual(["Thin one", "Thin two"]);
    expect(reading.faqQuestions).toBe(3);
    expect(codes(article({ bodyHtml: body, headings: [] }))).toContain("HEADING_BLOAT");
  });

  it("flags an FAQ of one question, and not one of three", () => {
    const one = '<h2 id="a">A</h2>' + p("x") + '<h2 id="faq">Frequently Asked Questions</h2><h3 id="q1">Q1?</h3>' + p("A.");
    expect(readStructure(one).faqQuestions).toBe(1);
    expect(codes(article({ bodyHtml: one }))).toContain("THIN_FAQ");
    expect(codes(article())).not.toContain("THIN_FAQ");
  });
});

describe("the product", () => {
  const context = { businessName: "GetTrafficFast" };
  const closing = '<h2 id="next">What to do next</h2>';

  it("flags a mention in the introduction, the body and the conclusion, and a superlative", () => {
    const body =
      p("GetTrafficFast makes this easy.") +
      '<h2 id="a">A</h2>' + p("With GetTrafficFast you can plan it.") +
      closing + p("GetTrafficFast offers an unparalleled solution.");
    const problems = productMentionProblems(body, "content calendar", context);
    expect(problems.join(" ")).toContain("introduction");
    expect(problems.join(" ")).toContain("outside the closing section");
    expect(problems.join(" ")).toContain("3 sentences");
    expect(problems.join(" ")).toContain("superlative");
    expect(codes(article({ bodyHtml: body }), context)).toContain("PRODUCT_MENTION");
  });

  it("accepts one plain sentence in the closing section", () => {
    const body = p("Intro.") + '<h2 id="a">A</h2>' + p("Body.") + closing + p("GetTrafficFast schedules the calendar for you.");
    expect(productMentionProblems(body, "content calendar", context)).toEqual([]);
  });

  it("does not read an article whose keyword is the business", () => {
    const body = p("GetTrafficFast is a content platform. GetTrafficFast writes articles.");
    expect(productMentionProblems(body, "gettrafficfast review", context)).toEqual([]);
  });
});

describe("figures from About you (2026-11-12)", () => {
  // The owner's About you on 12 November 2026: true, for replies, not for the blog.
  const privateFacts =
    "Since late September an AI pipeline writes and publishes my own blog: 9 impressions a week at the start, 342 in the week of Oct 26, still 0 clicks, articles sit around position 30-40.";
  const weak = p("On my own blog the articles went from 9 to 342 weekly impressions, still 0 clicks, around position 30-40.");

  it("finds them in any shape, not only prices and percentages, and quotes the sentence", () => {
    const found = privateFigures(weak, { privateFacts, facts: "" });
    expect(found.map((f) => f.value)).toEqual(["342", "30", "40"]);
    expect(found[0].sentence).toContain("342 weekly impressions");
    // The numbers gate, which reads four shapes only, never saw them.
    expect(unsupportedNumbers(weak, { facts: "" })).toEqual([]);
  });

  it("holds the article with a revisable review issue", () => {
    const issues = runQualityGates(article({ bodyHtml: article().bodyHtml + weak }), { privateFacts, facts: "" });
    const issue = issues.find((i) => i.code === "PRIVATE_FACT");
    expect(issue?.action).toBe("review");
    expect(REVISABLE_ISSUES.has("PRIVATE_FACT")).toBe(true);
    expect(decisionFor(issues)).toBe("needs_review");
  });

  it("lets them through when the owner listed them in Facts for articles, or the research has them", () => {
    expect(privateFigures(weak, { privateFacts, facts: "From 9 to 342 weekly impressions, position 30 to 40." })).toEqual([]);
    expect(privateFigures(weak, { privateFacts, evidence: "342 30 40" })).toEqual([]);
  });

  it("ignores years, figures under 10 and anything About you does not hold", () => {
    expect(privateFigures(p("In 2026 we wrote 7 drafts in 3 weeks."), { privateFacts: "2026, 7 drafts, 3 weeks" })).toEqual([]);
    expect(privateFigures(p("A post of 1,200 words."), { privateFacts })).toEqual([]);
    expect(privateFigures(weak, { facts: "" })).toEqual([]);
  });
});
