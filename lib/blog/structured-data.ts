import { SITE_NAME, SITE_URL } from "@/lib/site";
import type { BlogPost, BlogPostSummary } from "./posts";

/**
 * The blog's metadata and structured data: the `<title>`, and the JSON-LD a
 * search or answer engine reads (Article, FAQPage, Dataset, BreadcrumbList).
 *
 * Pure: a post in, plain objects out, so the shapes are tested without a
 * page. Every value is something the delivery carried; a field the post
 * does not have is left out, never filled in. The author and the publisher
 * are the business, because the product wrote the article: there is no
 * person to name, and none is invented.
 */

/** A search result shows about this many characters of a title. */
export const TITLE_MAX = 60;

const BRAND_SUFFIX = ` - ${SITE_NAME}`;
const LOGO_URL = `${SITE_URL}/icon.png`;

export const blogUrl = (): string => `${SITE_URL}/blog`;
export const postUrl = (slug: string): string => `${SITE_URL}/blog/${slug}`;

/** Where a headline's main clause ends: "Topic: the rest", "Topic | Site", "Topic - the rest". */
const CLAUSE_BREAKS = [": ", " | ", " - ", " – ", " — "];
/** A main clause shorter than this is not a title by itself. */
const CLAUSE_MIN = 20;

/**
 * `text` cut to at most `max` characters, never inside a word: at the end
 * of the headline's main clause when the cut would fall after one ("How to
 * X: a guide for…" becomes "How to X"), else at the last whole word, with
 * the punctuation the cut leaves dangling removed. No ellipsis: a title
 * that ends in "…" spends its last character on saying it was cut. A single
 * word longer than `max` is cut where it stands.
 */
export function truncateAtWord(text: string, max: number = TITLE_MAX): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const head = clean.slice(0, max + 1);
  const space = head.lastIndexOf(" ");
  const words = space > 0 ? head.slice(0, space) : clean.slice(0, max);
  const clause = Math.max(...CLAUSE_BREAKS.map((mark) => words.lastIndexOf(mark)));
  const cut = clause >= CLAUSE_MIN ? words.slice(0, clause) : words;
  return cut.replace(/[\s,;:.!?|/–—-]+$/u, "") || clean.slice(0, max);
}

/**
 * The page's `<title>`: the article's own meta title when the delivery had
 * one, else its headline cut at a word boundary to about 60 characters. The
 * site's name is appended only when the whole still fits.
 */
export function seoTitle(post: Pick<BlogPost, "title" | "metaTitle">): string {
  const base = post.metaTitle ?? truncateAtWord(post.title);
  return base.length + BRAND_SUFFIX.length <= TITLE_MAX ? `${base}${BRAND_SUFFIX}` : base;
}

const organization = () => ({
  "@type": "Organization",
  name: SITE_NAME,
  url: SITE_URL,
});

type JsonLd = Record<string, unknown>;

/** `Article`: what the post is, when it was published and changed, and who stands behind it. */
export function articleJsonLd(post: BlogPost): JsonLd {
  const url = postUrl(post.slug);
  return {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: post.title,
    ...(post.metaDescription ? { description: post.metaDescription } : {}),
    // A delivery with no date has none to state.
    ...(post.date ? { datePublished: post.date, dateModified: post.modified ?? post.date } : {}),
    author: organization(),
    publisher: { ...organization(), logo: { "@type": "ImageObject", url: LOGO_URL } },
    ...(post.hero ? { image: [post.hero.url] } : {}),
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
    url,
  };
}

/** `FAQPage` for the post's question and answer pairs; null when it has none. */
export function faqJsonLd(post: Pick<BlogPost, "faq">): JsonLd | null {
  if (post.faq.length === 0) return null;
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: post.faq.map((pair) => ({
      "@type": "Question",
      name: pair.question,
      acceptedAnswer: { "@type": "Answer", text: pair.answer },
    })),
  };
}

/**
 * `Dataset` for the post's own data, the "From our data" section; null when
 * it has none. Only that block: the name, what it states, the period it
 * names (left out when it names none), and the business as its creator.
 */
export function datasetJsonLd(post: Pick<BlogPost, "slug" | "dataset">): JsonLd | null {
  const dataset = post.dataset;
  if (!dataset) return null;
  const url = postUrl(post.slug);
  return {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: dataset.name,
    description: dataset.description,
    ...(dataset.temporalCoverage ? { temporalCoverage: dataset.temporalCoverage } : {}),
    creator: organization(),
    url: dataset.headingId ? `${url}#${dataset.headingId}` : url,
    isPartOf: { "@type": "Article", "@id": url },
  };
}

/** `BreadcrumbList`: Home, Blog, and the post when there is one. */
export function breadcrumbJsonLd(post?: Pick<BlogPost, "slug" | "title">): JsonLd {
  const items = [
    { name: "Home", url: SITE_URL },
    { name: "Blog", url: blogUrl() },
    ...(post ? [{ name: post.title, url: postUrl(post.slug) }] : []),
  ];
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: item.url,
    })),
  };
}

/** Every block of the post page, in order; the FAQ and the Dataset only when the post has them. */
export function postJsonLd(post: BlogPost): JsonLd[] {
  const faq = faqJsonLd(post);
  const dataset = datasetJsonLd(post);
  return [articleJsonLd(post), ...(faq ? [faq] : []), ...(dataset ? [dataset] : []), breadcrumbJsonLd(post)];
}

/** `Blog` for the index: the posts listed, each by its URL and headline. */
export function blogJsonLd(posts: readonly BlogPostSummary[]): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "Blog",
    name: `${SITE_NAME} Blog`,
    url: blogUrl(),
    publisher: organization(),
    blogPost: posts.map((post) => ({
      "@type": "BlogPosting",
      headline: post.title,
      url: postUrl(post.slug),
      ...(post.date ? { datePublished: post.date } : {}),
    })),
  };
}

/**
 * A JSON-LD object as the text of a `<script type="application/ld+json">`.
 * `<` is written as its escape so a value holding "</script>" cannot close
 * the element; the JSON a parser reads back is the same.
 */
export function jsonLdScript(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
