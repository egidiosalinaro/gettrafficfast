import { describe, expect, it } from "vitest";
import { CANONICAL_SCHEMA_VERSION, type CanonicalArticle } from "@/lib/content/types";
import {
  MAX_FAQ_PAIRS,
  canonicalDateModified,
  canonicalMetaDescription,
  canonicalMetaTitle,
  extractFaq,
  withDateModified,
} from "@/lib/publishing/seo";

/**
 * What leaves the platform as SEO and structured data, read from the
 * Canonical Article: the FAQ pairs come from the parsed body, section by
 * section, and a field the document does not have reads null, never a guess.
 */

const article: CanonicalArticle = {
  schemaVersion: CANONICAL_SCHEMA_VERSION,
  articleId: "a-1",
  title: "Abandoned Cart Emails: What Works",
  bodyHtml: "<p>Intro.</p>",
  headings: [],
  excerpt: "Intro.",
  metaDescription: "",
  wordCount: 1,
  slug: "abandoned-cart-emails",
  keyword: "abandoned cart email",
  language: "en",
  scheduledDate: "2026-11-01",
};

describe("extractFaq", () => {
  it("reads the section labelled FAQ: each h3 a question, the blocks under it the answer", () => {
    const body =
      '<p>Intro.</p><h2 id="timing">Timing</h2><h3 id="when">When to send?</h3><p>Within an hour.</p>' +
      '<h2 id="faq">FAQ</h2>' +
      '<h3 id="q1">How many emails should a sequence have?</h3><p>Three is <strong>enough</strong> for most stores.</p><p>Start with one.</p>' +
      '<h3 id="q2">Do discounts help?</h3><ul><li>Sometimes.</li><li>Test it.</li></ul>' +
      '<h2 id="next">Next steps</h2><h3 id="x">Not a question</h3><p>Go.</p>';
    expect(extractFaq(body)).toEqual([
      { question: "How many emails should a sequence have?", answer: "Three is enough for most stores. Start with one." },
      { question: "Do discounts help?", answer: "Sometimes. Test it." },
    ]);
  });

  it("recognises the label in the languages the platform writes in, and inside a longer heading", () => {
    for (const heading of [
      "Frequently Asked Questions",
      "Frequently asked questions about cart emails",
      "FAQs",
      "Domande frequenti",
      "Preguntas frecuentes",
      "Questions fréquentes",
      "Häufig gestellte Fragen",
      "Perguntas frequentes",
    ]) {
      const body = `<h2 id="f">${heading}</h2><h3 id="q">Perché?</h3><p>Così.</p>`;
      expect(extractFaq(body), heading).toEqual([{ question: "Perché?", answer: "Così." }]);
    }
  });

  it("does not take a word that merely contains the label for one", () => {
    expect(extractFaq('<h2 id="f">Unfaqable topics</h2><h3 id="q">One</h3><p>Text.</p>')).toEqual([]);
  });

  it("falls back to a section whose every h3 is a question, and to nothing otherwise", () => {
    const questions = '<h2 id="a">Good to know</h2><h3 id="1">Is it free?</h3><p>No.</p><h3 id="2">Is there a trial?</h3><p>Yes.</p>';
    expect(extractFaq(questions)).toHaveLength(2);
    const mixed = '<h2 id="a">Setup</h2><h3 id="1">Is it free?</h3><p>No.</p><h3 id="2">Install the app</h3><p>Click.</p>';
    expect(extractFaq(mixed)).toEqual([]);
    expect(extractFaq('<h2 id="a">Setup</h2><h3 id="1">Is it free?</h3><p>No.</p>')).toEqual([]);
  });

  it("leaves out a question with no answer, and never an image's caption", () => {
    const body =
      '<h2 id="faq">FAQ</h2><h3 id="1">Unanswered?</h3>' +
      '<h3 id="2">Answered?</h3><figure><img src="https://cdn/x.png" alt="x"><figcaption>A caption.</figcaption></figure><p>Yes.</p>';
    expect(extractFaq(body)).toEqual([{ question: "Answered?", answer: "Yes." }]);
  });

  it("decodes entities and reads through a wrapper, because it reads the tree and not the string", () => {
    const body = '<section><h2 id="faq">FAQ</h2><div><h3 id="1">Q &amp; A &lt;here&gt;?</h3><p>R&amp;D says   yes.</p></div></section>';
    expect(extractFaq(body)).toEqual([{ question: "Q & A <here>?", answer: "R&D says yes." }]);
  });

  it("is empty for a body with no FAQ, an empty body, and caps the pairs", () => {
    expect(extractFaq("")).toEqual([]);
    expect(extractFaq('<p>Intro.</p><h2 id="a">A</h2><p>Text.</p>')).toEqual([]);
    const many = `<h2 id="faq">FAQ</h2>${Array.from({ length: 20 }, (_, i) => `<h3 id="q${i}">Q${i}?</h3><p>A${i}.</p>`).join("")}`;
    expect(extractFaq(many)).toHaveLength(MAX_FAQ_PAIRS);
  });
});

describe("the canonical document's optional SEO fields", () => {
  it("reads a meta title nested under seo or flat, and null when the document has none", () => {
    expect(canonicalMetaTitle(article)).toBeNull();
    expect(canonicalMetaTitle({ ...article, seo: { metaTitle: " Cart Emails That Work " } } as CanonicalArticle)).toBe("Cart Emails That Work");
    expect(canonicalMetaTitle({ ...article, metaTitle: "Flat title" } as CanonicalArticle)).toBe("Flat title");
    expect(canonicalMetaTitle({ ...article, seo: "nope", metaTitle: 42 } as unknown as CanonicalArticle)).toBeNull();
  });

  it("reads the meta description, then the excerpt, then null", () => {
    expect(canonicalMetaDescription(article)).toBe("Intro.");
    expect(canonicalMetaDescription({ ...article, metaDescription: "Meta." })).toBe("Meta.");
    expect(canonicalMetaDescription({ ...article, seo: { metaDescription: "From seo." } } as CanonicalArticle)).toBe("From seo.");
    expect(canonicalMetaDescription({ ...article, excerpt: "" })).toBeNull();
  });

  it("records a change with withDateModified, and reads null where nothing recorded one", () => {
    expect(canonicalDateModified(article)).toBeNull();
    const stamped = withDateModified(article, new Date("2026-11-10T08:00:00Z"));
    expect(canonicalDateModified(stamped)).toBe("2026-11-10T08:00:00.000Z");
    expect(stamped.bodyHtml).toBe(article.bodyHtml);
    expect(canonicalDateModified({ ...article, dateModified: "not a date" } as CanonicalArticle)).toBeNull();
  });
});
