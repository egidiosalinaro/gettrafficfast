import { HTMLElement, Node, parse } from "node-html-parser";
import type { CanonicalArticle } from "@/lib/content/types";
import { measurementFigures, readDataSection, temporalCoverage } from "@/lib/content/anatomy";

/**
 * What a destination needs to render an article's SEO and structured data,
 * read from the Canonical Article: its meta title and description, when it
 * was last modified, and its FAQ as question and answer pairs.
 *
 * Reads only. Nothing here changes a document's body; the pairs come from
 * the parsed tree of `bodyHtml`, never from a pattern over the HTML string
 * (AGENTS §16).
 */

export interface FaqPair {
  question: string;
  answer: string;
}

/** At most this many pairs leave the platform as structured data. */
export const MAX_FAQ_PAIRS = 12;

type Loose = Record<string, unknown>;
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);

/**
 * Optional fields the canonical type is gaining (`seo.metaTitle`, or flat
 * `metaTitle`; `dateModified`). Documents stored before they existed do not
 * have them, so every read here answers null rather than assuming a shape.
 */
function loose(article: CanonicalArticle): { flat: Loose; seo: Loose } {
  const flat = article as unknown as Loose;
  const seo = flat.seo && typeof flat.seo === "object" ? (flat.seo as Loose) : {};
  return { flat, seo };
}

/** The article's meta title, when its document carries one; null otherwise (never the headline cut short). */
export function canonicalMetaTitle(article: CanonicalArticle): string | null {
  const { flat, seo } = loose(article);
  return text(seo.metaTitle) ?? text(flat.metaTitle);
}

/** The article's meta description: the document's own, else its excerpt, else null. */
export function canonicalMetaDescription(article: CanonicalArticle): string | null {
  const { seo } = loose(article);
  return text(seo.metaDescription) ?? text(article.metaDescription) ?? text(article.excerpt);
}

/**
 * When the published document last changed, as an ISO instant; null when
 * nothing recorded a change. Set by `withDateModified` wherever a published
 * article is rewritten (a refresh, a back-link added). Never derived from a
 * delivery time: a retried delivery is not a modification.
 */
export function canonicalDateModified(article: CanonicalArticle): string | null {
  const { flat, seo } = loose(article);
  const value = text(flat.dateModified) ?? text(seo.dateModified);
  return value && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : null;
}

/** The same document, recording that it changed at `at`. */
export function withDateModified(article: CanonicalArticle, at: Date = new Date()): CanonicalArticle {
  return { ...article, dateModified: at.toISOString() } as CanonicalArticle;
}

/**
 * Headings that open an FAQ section, in the languages the platform writes
 * in. A label is detected here; the section's structure is read from the
 * tree below.
 */
const FAQ_LABEL =
  /(?:^|[^\p{L}])(?:faqs?|f\.a\.q\.?|frequently asked questions?|common questions|questions? (?:and|&) answers?|domande frequenti|domande e risposte|preguntas frecuentes|perguntas frequentes|questions fréquentes|foire aux questions|häufig gestellte fragen|häufige fragen)(?:$|[^\p{L}])/iu;

function isElement(node: Node): node is HTMLElement {
  return node instanceof HTMLElement;
}

const WRAPPERS = new Set(["SECTION", "ARTICLE", "DIV", "MAIN"]);

/** The body's blocks in document order, with plain wrappers opened. */
function blocks(node: Node, out: HTMLElement[]): void {
  for (const child of node.childNodes) {
    if (!isElement(child)) continue;
    const tag = child.tagName?.toUpperCase();
    if (tag && WRAPPERS.has(tag)) blocks(child, out);
    else out.push(child);
  }
}

/** A block's text with its own blocks (list items) kept apart, entities decoded. */
const plain = (node: HTMLElement): string => node.structuredText.replace(/\s+/g, " ").trim();

interface Section {
  heading: string;
  /** The h3s of the section, each with the text of the blocks under it. */
  items: FaqPair[];
}

/**
 * The FAQ of an article as question and answer pairs, read from the parsed
 * body: the `<h2>` section labelled as an FAQ (in any supported language),
 * or, when no section is labelled, a section whose every `<h3>` is a
 * question (at least two, each ending in "?"). Each `<h3>` is a question;
 * its answer is the text of the blocks between it and the next heading.
 * Figures are not part of an answer. A question with no answer is left out:
 * a pair is never completed.
 */
export function extractFaq(bodyHtml: string): FaqPair[] {
  if (!bodyHtml.trim()) return [];
  const all: HTMLElement[] = [];
  blocks(parse(bodyHtml, { comment: false }), all);

  const sections: Section[] = [];
  let section: Section | null = null;
  let item: FaqPair | null = null;
  for (const block of all) {
    const tag = block.tagName?.toUpperCase();
    if (tag === "H2") {
      section = { heading: plain(block), items: [] };
      sections.push(section);
      item = null;
      continue;
    }
    if (!section) continue;
    if (tag === "H3") {
      item = { question: plain(block), answer: "" };
      section.items.push(item);
      continue;
    }
    if (!item || tag === "FIGURE" || tag === "H4" || tag === "H5" || tag === "H6") continue;
    const piece = plain(block);
    if (piece) item.answer = item.answer ? `${item.answer} ${piece}` : piece;
  }

  const complete = (s: Section) => s.items.filter((pair) => pair.question && pair.answer);
  const labelled = sections.find((s) => FAQ_LABEL.test(s.heading) && complete(s).length > 0);
  const questions = (s: Section) => s.items.length >= 2 && s.items.every((pair) => pair.question.endsWith("?"));
  const chosen = labelled ?? sections.find((s) => questions(s) && complete(s).length >= 2);
  return chosen ? complete(chosen).slice(0, MAX_FAQ_PAIRS) : [];
}

/**
 * The article's own data, as a `Dataset` names it: read from its "From our
 * data" section (lib/content/anatomy.ts), which the writer adds only when
 * the owner's Facts for articles hold a measurement that may be published.
 * Null when there is no such section, when it states no figure, or when its
 * text is too short to describe anything (a Dataset description is 50 to
 * 5,000 characters). The period is the one the section writes, never a
 * guess: `temporalCoverage` is null when it writes none.
 */
export interface ArticleDataset {
  name: string;
  description: string;
  /** ISO 8601: "2026-09/2026-11", "2026-10-12", "2025". */
  temporalCoverage: string | null;
  /** The section's heading id, for a link to it. */
  headingId: string | null;
}

export const DATASET_DESCRIPTION_MIN = 50;
export const DATASET_DESCRIPTION_MAX = 5000;

export function extractDataset(bodyHtml: string, title: string): ArticleDataset | null {
  if (!bodyHtml.trim()) return null;
  const section = readDataSection(bodyHtml);
  if (!section || measurementFigures(section.text).length === 0) return null;
  if (section.text.length < DATASET_DESCRIPTION_MIN) return null;
  return {
    name: `${title.trim()}: ${section.heading}`,
    description: section.text.slice(0, DATASET_DESCRIPTION_MAX),
    temporalCoverage: temporalCoverage(section.text),
    headingId: section.headingId,
  };
}
