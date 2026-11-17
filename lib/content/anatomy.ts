import { HTMLElement, Node, parse } from "node-html-parser";
import { datesIn, factSentences } from "@/lib/voice/staleness";
import { collapseWhitespace, countWords } from "./text";

/**
 * The anatomy every article has since 15 November 2026, the parts of it code
 * can read: the answer first ("The short version"), headings that are the
 * questions people ask, a "From our data" section only when the owner's
 * Facts for articles hold a figure that may be published, and the "Read
 * next" block the knowledge step appends.
 *
 * Why: the articles of a growth blog that reaches millions of readers share
 * that shape, and an answer engine quotes a passage that states the answer
 * at once, under the question it answers (docs/CONTENT_PIPELINE.md, "The
 * article's anatomy").
 *
 * Pure: no I/O, no model. Readers only, except `withReadNext`, which builds
 * the one block the platform itself writes into a document, on the tree.
 */

// ── Labels, per content language ────────────────────────────────────────────

export interface AnatomyLabels {
  /** The bold label that opens the first paragraph. */
  shortVersion: string;
  /** The heading of the data section. */
  fromOurData: string;
  /** The heading of the block of related articles. */
  readNext: string;
}

/** The languages a site can write in (lib/content-language.ts), each with its labels. */
export const ANATOMY_LABELS: Record<"en" | "it" | "es" | "fr" | "de", AnatomyLabels> = {
  en: { shortVersion: "The short version", fromOurData: "From our data", readNext: "Read next" },
  it: { shortVersion: "In breve", fromOurData: "Dai nostri dati", readNext: "Leggi anche" },
  es: { shortVersion: "En resumen", fromOurData: "De nuestros datos", readNext: "Sigue leyendo" },
  fr: { shortVersion: "En bref", fromOurData: "D'après nos données", readNext: "À lire ensuite" },
  de: { shortVersion: "Kurz gesagt", fromOurData: "Aus unseren Daten", readNext: "Weiterlesen" },
};

const LANGUAGE_NAMES: Record<string, keyof typeof ANATOMY_LABELS> = {
  english: "en",
  italian: "it",
  italiano: "it",
  spanish: "es",
  español: "es",
  french: "fr",
  français: "fr",
  german: "de",
  deutsch: "de",
};

/** The labels for a content language, given as a code ("it", "it-IT") or a name ("Italian"); English otherwise. */
export function anatomyLabels(language: string | null | undefined): AnatomyLabels {
  const value = (language ?? "").trim().toLowerCase();
  const code = (LANGUAGE_NAMES[value] ?? value.slice(0, 2)) as keyof typeof ANATOMY_LABELS;
  return ANATOMY_LABELS[code] ?? ANATOMY_LABELS.en;
}

const fold = (text: string): string =>
  collapseWhitespace(text)
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[\s:.\-–—]+$/u, "")
    .trim();

/** Every spelling read as the short-version label, in any supported language. */
const SHORT_VERSION_LABELS = new Set(
  [
    ...Object.values(ANATOMY_LABELS).map((labels) => labels.shortVersion),
    "The short answer",
    "Short answer",
    "Short version",
    "In short",
    "TL;DR",
    "TLDR",
    "La risposta breve",
    "In sintesi",
  ].map(fold)
);

/** Headings read as the data section: "From our data" and "How we measured this", in every supported language. */
const DATA_LABELS = new Set(
  [
    ...Object.values(ANATOMY_LABELS).map((labels) => labels.fromOurData),
    "How we measured this",
    "How we measured it",
    "Come lo abbiamo misurato",
    "Cómo lo medimos",
    "Comment nous l'avons mesuré",
    "Wie wir das gemessen haben",
  ].map(fold)
);

const READ_NEXT_LABELS = new Set(Object.values(ANATOMY_LABELS).map((labels) => fold(labels.readNext)));

/** The id of the Read next heading the knowledge step writes. */
export const READ_NEXT_ID = "read-next";

const FAQ_HEADING = /\b(?:faqs?|frequently asked|domande frequenti|common questions|preguntas frecuentes|questions fréquentes|häufig gestellte fragen)\b/i;

export const isShortVersionLabel = (text: string): boolean => SHORT_VERSION_LABELS.has(fold(text));
export const isDataHeading = (text: string): boolean => DATA_LABELS.has(fold(text));
export const isReadNextHeading = (heading: { id?: string | null; text: string }): boolean =>
  heading.id === READ_NEXT_ID || READ_NEXT_LABELS.has(fold(heading.text));

/** A heading written as a question: it ends in a question mark (or opens with "¿"). */
export function isQuestion(text: string): boolean {
  const clean = collapseWhitespace(text);
  return /[?？]$/.test(clean) || clean.startsWith("¿");
}

// ── Reading the body's blocks ───────────────────────────────────────────────

const isElement = (node: Node): node is HTMLElement => node instanceof HTMLElement;
const tagOf = (node: HTMLElement): string => node.tagName?.toUpperCase() ?? "";
const WRAPPERS = new Set(["SECTION", "ARTICLE", "DIV", "MAIN", "ASIDE", "NAV"]);

/** The body's top-level blocks in document order, plain wrappers opened. */
function blocksOf(node: Node, out: HTMLElement[] = []): HTMLElement[] {
  for (const child of node.childNodes) {
    if (!isElement(child)) continue;
    if (WRAPPERS.has(tagOf(child))) blocksOf(child, out);
    else out.push(child);
  }
  return out;
}

const plain = (node: HTMLElement): string => collapseWhitespace(node.structuredText ?? node.text);

// ── A. The short version ────────────────────────────────────────────────────

/** Over this many words the short version is no longer short: 3 to 6 sentences fit under it. */
export const SHORT_VERSION_MAX_WORDS = 120;

export interface ShortVersion {
  /** The label as the article writes it. */
  label: string;
  /** The answer, label left out. */
  text: string;
  words: number;
}

/** The leading bold label of a paragraph, when it opens with one. */
function leadingLabel(paragraph: HTMLElement): HTMLElement | null {
  for (const child of paragraph.childNodes) {
    if (isElement(child)) {
      const tag = tagOf(child);
      return tag === "STRONG" || tag === "B" ? child : null;
    }
    if (child.text.trim()) return null;
  }
  return null;
}

/**
 * The short version, read from the body: the first block (figures aside: the
 * hero sits there on a delivered body) is a paragraph opening with the label
 * in bold, "<p><strong>The short version:</strong> …</p>". A label alone in
 * its paragraph takes the next paragraph as its answer. Null when the body
 * does not open that way.
 */
export function readShortVersion(bodyHtml: string): ShortVersion | null {
  const blocks = blocksOf(parse(bodyHtml, { comment: false })).filter((block) => tagOf(block) !== "FIGURE");
  const first = blocks[0];
  if (!first || tagOf(first) !== "P") return null;
  const label = leadingLabel(first);
  if (!label || !isShortVersionLabel(label.text)) return null;
  let text = collapseWhitespace(plain(first).slice(plain(label).length)).replace(/^[:.\-–—\s]+/u, "");
  if (!text && blocks[1] && tagOf(blocks[1]) === "P") text = plain(blocks[1]);
  if (!text) return null;
  return { label: collapseWhitespace(label.text).replace(/[:\s]+$/u, ""), text, words: countWords(text) };
}

/** A paragraph's text with a leading short-version label left out: what an excerpt is built from. */
export function withoutShortVersionLabel(paragraph: HTMLElement): string {
  const label = leadingLabel(paragraph);
  const text = paragraph.text;
  if (!label || !isShortVersionLabel(label.text)) return text;
  return text.slice(text.indexOf(label.text) + label.text.length).replace(/^[\s:.\-–—]+/u, "");
}

// ── A. Headings that are questions ──────────────────────────────────────────

export interface QuestionHeadings {
  /** H2s that count: every one but the FAQ, the data section and Read next. */
  counted: number;
  questions: number;
  /** The counted H2s that are not questions. */
  statements: string[];
}

/** How many of the article's section headings are questions. */
export function questionHeadings(headings: readonly { level: number; id?: string; text: string }[]): QuestionHeadings {
  const counted = headings.filter(
    (h) => h.level === 2 && !FAQ_HEADING.test(h.text) && !isDataHeading(h.text) && !isReadNextHeading(h)
  );
  const statements = counted.filter((h) => !isQuestion(h.text)).map((h) => collapseWhitespace(h.text));
  return { counted: counted.length, questions: counted.length - statements.length, statements };
}

/** At least half of the counted H2s are questions; an article with fewer than two is not judged. */
export function enoughQuestionHeadings(reading: QuestionHeadings): boolean {
  return reading.counted < 2 || reading.questions * 2 >= reading.counted;
}

// ── B. Facts that may go into "From our data" ───────────────────────────────

/**
 * Below these, a figure about the site's own traction is a weak early
 * result: the owner keeps those off the public blog (docs/VOICE.md, 12
 * November 2026). Counts of customers, users, visits, impressions… under a
 * thousand; revenue under ten thousand in any currency.
 */
export const WEAK_COUNT_BELOW = 1_000;
export const WEAK_REVENUE_BELOW = 10_000;

/** Words of the site's own traction: revenue and the people or visits it counts. */
const TRACTION =
  /\b(?:revenue|mrr|arr|sales|income|profit|turnover|conversions?|churn|retention|paying|paid (?:users|customers|plans?)|customers?|clients?|users?|subscribers?|sign[- ]?ups?|members?|followers?|downloads?|installs?|visitors?|visits?|traffic|impressions?|clicks?|page ?views?|views?|leads?|orders?|stores?|shops?|sites?|websites?|businesses|brands?|accounts?|fatturato|ricavi|vendite|clienti|utenti|iscritti|abbonati|visite|visitatori|impression[ie]?|clic|ordini|negozi|siti|ingresos|ventas|clientes|usuarios|suscriptores|visitas|chiffre d'affaires|ventes|utilisateurs|abonnés|umsatz|kunden|nutzer|abonnenten|besucher)\b/i;

/** Verbs of a study: a sentence with one reports a measurement, not traction ("we tested 40 prompts"). */
const STUDY =
  /\b(?:analy[sz]ed|tested|checked|audited|measured|surveyed|sampled|studied|reviewed|tracked|compared|probed|queried|benchmarked|counted|ran|asked|analizzat[oaie]|testat[oaie]|misurat[oaie]|controllat[oaie]|confrontat[oaie]|analizamos|medimos|probamos|analysé|mesuré|testé|analysiert|gemessen|getestet)\b/i;

const MONEY = /[$€£]|\b(?:usd|eur|gbp|dollars?|euros?)\b|\b(?:revenue|mrr|arr|income|profit|turnover|fatturato|ricavi|ingresos|chiffre d'affaires|umsatz)\b/i;

const FIGURE = /(\d{1,3}(?:[.,]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?)\s*(k|m|mln|million|milioni|thousand|mila)?\b(\s?%)?/gi;

function figureValue(digits: string, scale: string | undefined): number {
  const plainDigits = /^\d{1,3}(?:[.,]\d{3})+$/.test(digits) ? digits.replace(/[.,]/g, "") : digits.replace(",", ".");
  const base = Number(plainDigits);
  const unit = (scale ?? "").toLowerCase();
  if (unit === "k" || unit === "thousand" || unit === "mila") return base * 1_000;
  if (unit === "m" || unit === "mln" || unit === "million" || unit === "milioni") return base * 1_000_000;
  return base;
}

export interface FactFigure {
  /** As `figuresIn` normalises it (lib/content/quality/claims.ts): "1,200" → "1200". */
  value: string;
  /** The amount, scale words applied ("2k" → 2000). */
  amount: number;
  percent: boolean;
}

/**
 * The figures of a sentence that are measurements: dates are read out first
 * (with the same reader as Settings' staleness check, lib/voice/staleness.ts)
 * so "October 26, 2026" is not a figure, and a bare year is never one.
 */
export function measurementFigures(sentence: string, now: Date = new Date()): FactFigure[] {
  let rest = sentence;
  for (const date of datesIn(sentence, now)) {
    rest = `${rest.slice(0, date.start)}${" ".repeat(date.end - date.start)}${rest.slice(date.end)}`;
  }
  const figures: FactFigure[] = [];
  for (const match of rest.matchAll(FIGURE)) {
    const digits = match[1];
    if (/^(?:19|20)\d{2}$/.test(digits)) continue;
    const value = /^\d{1,3}(?:[.,]\d{3})+$/.test(digits) ? digits.replace(/[.,]/g, "") : digits.replace(",", ".");
    figures.push({ value, amount: figureValue(digits, match[2]), percent: Boolean(match[3]) });
  }
  return figures;
}

export interface DataFact {
  /** The owner's sentence, as written. */
  sentence: string;
  figures: FactFigure[];
}

export interface WithheldFact extends DataFact {
  reason: string;
}

export interface DataFacts {
  /** Measurements a "From our data" section may state. */
  usable: DataFact[];
  /** Sentences with figures that stay out of it, and why. */
  withheld: WithheldFact[];
}

/**
 * Which of the owner's Facts for articles may go into "From our data".
 *
 * A sentence qualifies when it carries a measurement (a figure that is not a
 * date or a year). It is withheld when it reads as the site's own early
 * traction, the owner's rule of 12 November 2026: a sentence with a word of
 * traction (revenue, customers, users, sites, visits, impressions, clicks,
 * followers… in the supported languages) and no verb of a study (tested,
 * analysed, measured…) is withheld if any of its figures is a percentage,
 * zero, a revenue under `WEAK_REVENUE_BELOW` or a count under
 * `WEAK_COUNT_BELOW`. "We publish for 14 sites" and "€300 MRR" stay out;
 * "we tested 40 prompts in October 2026" and "1.2 million impressions across
 * customer sites" go in. When in doubt the sentence is withheld: leaving a
 * true figure out costs nothing, advertising a weak one costs the owner.
 */
export function articleDataFacts(facts: string | null | undefined, now: Date = new Date()): DataFacts {
  const usable: DataFact[] = [];
  const withheld: WithheldFact[] = [];
  for (const sentence of factSentences((facts ?? "").trim())) {
    const figures = measurementFigures(sentence, now);
    if (figures.length === 0) continue;
    if (TRACTION.test(sentence) && !STUDY.test(sentence)) {
      const money = MONEY.test(sentence);
      const weak = figures.find(
        (figure) =>
          figure.percent || figure.amount === 0 || figure.amount < (money ? WEAK_REVENUE_BELOW : WEAK_COUNT_BELOW)
      );
      if (weak) {
        withheld.push({
          sentence,
          figures,
          reason: `reads as the site's own early traction (${weak.value}${weak.percent ? "%" : ""}): weak early results stay off the public blog`,
        });
        continue;
      }
    }
    usable.push({ sentence, figures });
  }
  return { usable, withheld };
}

// ── B. The data section, read from the body ─────────────────────────────────

export interface DataSection {
  headingId: string | null;
  heading: string;
  /** The section's text, block by block. */
  text: string;
}

/** The "From our data" section of a body: from its `<h2>` to the next one. Null when there is none. */
export function readDataSection(bodyHtml: string): DataSection | null {
  const blocks = blocksOf(parse(bodyHtml, { comment: false }));
  let section: DataSection | null = null;
  const parts: string[] = [];
  for (const block of blocks) {
    if (tagOf(block) === "H2") {
      if (section) break;
      if (isDataHeading(block.text)) {
        section = { headingId: block.getAttribute("id") ?? null, heading: collapseWhitespace(block.text), text: "" };
      }
      continue;
    }
    if (section && tagOf(block) !== "FIGURE") {
      const piece = plain(block);
      if (piece) parts.push(piece);
    }
  }
  if (!section) return null;
  return { ...section, text: parts.join(" ") };
}

/**
 * The period a text states, as an ISO 8601 interval for `temporalCoverage`:
 * the dates it writes with their year ("September to November 2026" →
 * "2026-09/2026-11", "October 12, 2026" → "2026-10-12"), else the years it
 * names ("in 2025" → "2025"). Null when it states none: a period is never
 * guessed.
 */
export function temporalCoverage(text: string, now: Date = new Date()): string | null {
  const dates = datesIn(text, now).filter((date) => !date.yearAssumed);
  // "September to November 2026": the first month takes the year that follows.
  const bareMonth = /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+(?:to|through|until|and|-|–)\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+((?:19|20)\d{2})\b/i.exec(
    text
  );
  const points: string[] = dates.map((date) => (date.precision === "month" ? date.iso.slice(0, 7) : date.iso));
  if (bareMonth) {
    const start = datesIn(`${bareMonth[1]} ${bareMonth[3]}`, now)[0];
    if (start) points.push(start.iso.slice(0, 7));
  }
  if (points.length === 0) {
    const years = [...text.matchAll(/(?<![\d.,])((?:19|20)\d{2})(?![\d.,]\d)/g)].map((m) => m[1]);
    points.push(...years);
  }
  if (points.length === 0) return null;
  const sorted = [...new Set(points)].sort();
  return sorted.length === 1 ? sorted[0] : `${sorted[0]}/${sorted[sorted.length - 1]}`;
}

// ── C. Read next ────────────────────────────────────────────────────────────

/** How many related articles the block lists. */
export const READ_NEXT_COUNT = 3;

export interface ReadNextItem {
  title: string;
  /** Where the article is live. Only http(s) addresses are written. */
  href: string;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const isHttp = (href: string): boolean => {
  try {
    const url = new URL(href);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
};

/** The body without its Read next block: what the editorial checks read. */
export function withoutReadNext(bodyHtml: string): string {
  const root = parse(bodyHtml, { comment: false });
  let removing = false;
  for (const node of [...root.childNodes]) {
    if (isElement(node) && tagOf(node) === "H2") {
      removing = isReadNextHeading({ id: node.getAttribute("id"), text: node.text });
    }
    if (removing) node.remove();
  }
  return root.toString();
}

/**
 * The article with its Read next block: an `<h2 id="read-next">` (the label
 * in the article's language) and a list of links, appended at the end of the
 * body and to `headings`. A block already there is replaced, so a retried
 * step never writes two. With no item, the block is removed. Titles and
 * addresses are escaped; an address that is not http(s) is left out.
 */
export function withReadNext<T extends { bodyHtml: string; headings: { level: 2 | 3; id: string; text: string }[]; language: string }>(
  article: T,
  items: readonly ReadNextItem[]
): T {
  const kept = items.filter((item) => item.title.trim() && isHttp(item.href));
  const body = withoutReadNext(article.bodyHtml).trim();
  const headings = article.headings.filter((h) => !isReadNextHeading(h));
  if (kept.length === 0) return { ...article, bodyHtml: body, headings };
  const label = anatomyLabels(article.language).readNext;
  const list = kept
    .map((item) => `<li><a href="${escapeHtml(item.href)}">${escapeHtml(collapseWhitespace(item.title))}</a></li>`)
    .join("");
  return {
    ...article,
    bodyHtml: `${body}\n<h2 id="${READ_NEXT_ID}">${escapeHtml(label)}</h2>\n<ul>${list}</ul>`,
    headings: [...headings, { level: 2 as const, id: READ_NEXT_ID, text: label }],
  };
}
