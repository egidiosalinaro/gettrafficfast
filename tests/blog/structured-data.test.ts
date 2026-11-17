import { describe, expect, it } from "vitest";
import type { BlogPost } from "@/lib/blog/posts";
import {
  TITLE_MAX,
  articleJsonLd,
  blogJsonLd,
  breadcrumbJsonLd,
  datasetJsonLd,
  faqJsonLd,
  jsonLdScript,
  postJsonLd,
  seoTitle,
  truncateAtWord,
} from "@/lib/blog/structured-data";

/**
 * The blog's `<title>` and JSON-LD. Pinned: the shapes a search or answer
 * engine reads (Article, FAQPage, BreadcrumbList), that a field the post
 * does not have is left out rather than filled in, that the author is the
 * business and never a person, and that a title is cut at a word.
 */

const post: BlogPost = {
  slug: "how-answer-engines-pick-sources",
  title: "How answer engines pick sources",
  excerpt: "A short excerpt.",
  metaDescription: "How engines choose what to cite.",
  metaTitle: null,
  bodyHtml: "<p>Body.</p>",
  hero: { url: "https://cdn.gettrafficfa.st/hero.png", alt: "Hero", caption: null, embedded: true },
  date: "2026-09-10",
  modified: "2026-10-02",
  faq: [
    { question: "Do answer engines cite blogs?", answer: "Yes, when the page answers the question." },
    { question: "How often do they change?", answer: "Weekly." },
  ],
  dataset: null,
};

describe("the <title>", () => {
  it("uses the article's meta title when the delivery had one", () => {
    expect(seoTitle({ ...post, metaTitle: "How AI Engines Pick Sources" })).toBe("How AI Engines Pick Sources - GetTrafficFast");
  });

  it("falls back to the headline, with the site's name only when the whole fits", () => {
    expect(seoTitle(post)).toBe("How answer engines pick sources - GetTrafficFast");
    const long = "How to Get Cited by ChatGPT, Perplexity and Gemini: A Step-by-Step Guide for Small Software Teams in 2026";
    const title = seoTitle({ title: long, metaTitle: null });
    expect(long.length).toBeGreaterThan(100);
    expect(title).toBe("How to Get Cited by ChatGPT, Perplexity and Gemini");
    expect(title.length).toBeLessThanOrEqual(TITLE_MAX);
  });

  it("cuts at a word boundary, drops the punctuation the cut leaves, and adds no ellipsis", () => {
    expect(truncateAtWord("Abandoned cart emails with examples, timing and templates that recover sales", 40)).toBe("Abandoned cart emails with examples");
    // The headline's main clause, when the cut falls after it.
    expect(truncateAtWord("Abandoned cart emails: examples, timing and templates that recover sales", 40)).toBe("Abandoned cart emails");
    // A clause too short to stand alone is not cut to.
    expect(truncateAtWord("FAQ: how many abandoned cart emails should a small store send", 40)).toBe("FAQ: how many abandoned cart emails");
    expect(truncateAtWord("One two three, four", 14)).toBe("One two three");
    expect(truncateAtWord("  Short   title ", 60)).toBe("Short title");
    // A word that ends exactly at the limit is kept whole.
    expect(truncateAtWord("12345 789 next", 9)).toBe("12345 789");
    // One word longer than the limit is cut where it stands.
    expect(truncateAtWord("Supercalifragilisticexpialidocious", 10)).toBe("Supercalif");
  });

  it("does not cut a meta title: it was written for search", () => {
    const metaTitle = "A meta title that the article's own document says is the one to show in search";
    expect(seoTitle({ title: "Headline", metaTitle })).toBe(metaTitle);
  });
});

describe("Article", () => {
  it("has the fields an engine reads, from the delivery's own values", () => {
    expect(articleJsonLd(post)).toEqual({
      "@context": "https://schema.org",
      "@type": "Article",
      headline: "How answer engines pick sources",
      description: "How engines choose what to cite.",
      datePublished: "2026-09-10",
      dateModified: "2026-10-02",
      author: { "@type": "Organization", name: "GetTrafficFast", url: "https://gettrafficfa.st" },
      publisher: {
        "@type": "Organization",
        name: "GetTrafficFast",
        url: "https://gettrafficfa.st",
        logo: { "@type": "ImageObject", url: "https://gettrafficfa.st/icon.png" },
      },
      image: ["https://cdn.gettrafficfa.st/hero.png"],
      mainEntityOfPage: { "@type": "WebPage", "@id": "https://gettrafficfa.st/blog/how-answer-engines-pick-sources" },
      url: "https://gettrafficfa.st/blog/how-answer-engines-pick-sources",
    });
  });

  it("names the business as the author, never a person", () => {
    expect(JSON.stringify(articleJsonLd(post))).not.toContain('"Person"');
  });

  it("leaves out what the post does not have instead of filling it in", () => {
    const bare = articleJsonLd({ ...post, hero: null, date: null, modified: null, metaDescription: "" });
    expect(bare).not.toHaveProperty("image");
    expect(bare).not.toHaveProperty("datePublished");
    expect(bare).not.toHaveProperty("dateModified");
    expect(bare).not.toHaveProperty("description");
    // Never modified: the day it was published is the day it last changed.
    expect(articleJsonLd({ ...post, modified: null })).toMatchObject({ datePublished: "2026-09-10", dateModified: "2026-09-10" });
  });
});

describe("FAQPage", () => {
  it("lists each pair as a Question with its accepted Answer", () => {
    expect(faqJsonLd(post)).toEqual({
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: [
        { "@type": "Question", name: "Do answer engines cite blogs?", acceptedAnswer: { "@type": "Answer", text: "Yes, when the page answers the question." } },
        { "@type": "Question", name: "How often do they change?", acceptedAnswer: { "@type": "Answer", text: "Weekly." } },
      ],
    });
  });

  it("is absent for an article with no FAQ", () => {
    expect(faqJsonLd({ faq: [] })).toBeNull();
    expect(postJsonLd({ ...post, faq: [] }).map((block) => block["@type"])).toEqual(["Article", "BreadcrumbList"]);
    expect(postJsonLd(post).map((block) => block["@type"])).toEqual(["Article", "FAQPage", "BreadcrumbList"]);
  });
});

describe("Dataset (2026-11-15)", () => {
  const dataset = {
    name: "How answer engines pick sources: From our data",
    description: "Between September and November 2026 we asked three engines 400 questions and recorded which pages each cited.",
    temporalCoverage: "2026-09/2026-11",
    headingId: "from-our-data",
  };

  it("describes only the data block, with the business as its creator", () => {
    expect(datasetJsonLd({ ...post, dataset })).toEqual({
      "@context": "https://schema.org",
      "@type": "Dataset",
      name: "How answer engines pick sources: From our data",
      description: dataset.description,
      temporalCoverage: "2026-09/2026-11",
      creator: { "@type": "Organization", name: "GetTrafficFast", url: "https://gettrafficfa.st" },
      url: "https://gettrafficfa.st/blog/how-answer-engines-pick-sources#from-our-data",
      isPartOf: { "@type": "Article", "@id": "https://gettrafficfa.st/blog/how-answer-engines-pick-sources" },
    });
  });

  it("leaves out a period the section does not name", () => {
    expect(datasetJsonLd({ ...post, dataset: { ...dataset, temporalCoverage: null } })).not.toHaveProperty("temporalCoverage");
  });

  it("is absent without the section: no data, no schema", () => {
    expect(datasetJsonLd(post)).toBeNull();
    expect(postJsonLd({ ...post, dataset }).map((block) => block["@type"])).toEqual(["Article", "FAQPage", "Dataset", "BreadcrumbList"]);
  });
});

describe("BreadcrumbList and Blog", () => {
  it("walks Home, Blog and the post, numbered from 1", () => {
    expect(breadcrumbJsonLd(post)).toMatchObject({
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: "https://gettrafficfa.st" },
        { "@type": "ListItem", position: 2, name: "Blog", item: "https://gettrafficfa.st/blog" },
        { "@type": "ListItem", position: 3, name: "How answer engines pick sources", item: "https://gettrafficfa.st/blog/how-answer-engines-pick-sources" },
      ],
    });
    expect((breadcrumbJsonLd().itemListElement as unknown[]).length).toBe(2);
  });

  it("lists the index's posts, and an empty blog as empty", () => {
    expect(blogJsonLd([post])).toMatchObject({
      "@type": "Blog",
      blogPost: [{ "@type": "BlogPosting", headline: post.title, url: "https://gettrafficfa.st/blog/how-answer-engines-pick-sources", datePublished: "2026-09-10" }],
    });
    expect(blogJsonLd([]).blogPost).toEqual([]);
  });
});

describe("the script text", () => {
  it("is JSON a parser reads back unchanged, and cannot close its own element", () => {
    const hostile = { ...post, title: 'A </script><script>alert("x")</script> title' };
    const text = jsonLdScript(articleJsonLd(hostile));
    expect(text).not.toContain("</script>");
    expect(text).not.toContain("<");
    expect(JSON.parse(text)).toEqual(articleJsonLd(hostile));
  });
});
