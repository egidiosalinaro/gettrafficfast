import { HTMLElement, parse } from "node-html-parser";
import { collapseWhitespace, countWords } from "../text";

/**
 * Checks that need to know something beyond the document: who the business
 * is, where its site lives, and what evidence the article was written from.
 *
 * They exist because of what production published before 2026-11-10: links to
 * `https://www.GetTrafficFast.com` and `https://postwren.io` (the sites are
 * gettrafficfa.st and postwren.me), "a subjective rating of 4.2 out of 5
 * stars", "paid plans starting from ~$49/month", "typically requires 50–200+
 * published articles". None of it was in anything the writer was given.
 *
 * Detectors only: every function here reads and reports.
 */

/** What the gates may check an article against. Everything is optional: an absent field checks nothing. */
export interface GateContext {
  businessName?: string;
  /** The business's real site. Any link to the business must use this host. */
  websiteUrl?: string;
  /**
   * The first-hand facts an article may state: the owner's Facts for
   * articles. Since 12 November 2026 not About you, which only replies read.
   */
  facts?: string;
  /**
   * About you: true, but not for the public blog. Read by code only, never
   * by a model: a figure from it in an article is held (`privateFigures`).
   */
  privateFacts?: string;
  /** Text of the research evidence: titles, snippets and questions of the real results. */
  evidence?: string;
  /**
   * The topic is a comparison (`keywords.intent`): the business may be one
   * of the options compared (`productMentionProblems`).
   */
  comparison?: boolean;
}

function squash(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function hostOf(url: string | undefined): string {
  if (!url) return "";
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`;
    return new URL(withScheme).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function prose(root: HTMLElement): string {
  const copy = parse(root.toString(), { comment: false });
  for (const el of copy.querySelectorAll("pre, code")) el.remove();
  return copy.structuredText ?? copy.text;
}

// ── Links ───────────────────────────────────────────────────────────────────

const URL_IN_TEXT = /\b(?:https?:\/\/)?(?:www\.)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?:\/[^\s<>"')]*)?/gi;

/**
 * Hosts that read as the business but are not its site. A host belongs to
 * the business when it is the real host or a subdomain of it. It is a
 * look-alike when it is not, and either spells the business name
 * ("gettrafficfast.com" for GetTrafficFast) or carries the real host's own
 * first label under another ending ("postwren.io" for postwren.me). With no
 * real site on record, every host spelling the name is unverifiable and
 * reported.
 */
export function lookalikeHosts(bodyHtml: string, context: GateContext): string[] {
  const realHost = hostOf(context.websiteUrl);
  const nameToken = squash(context.businessName ?? "");
  const realLabel = realHost.split(".")[0] ?? "";
  const tokens = [nameToken, squash(realLabel)].filter((token) => token.length >= 4);
  if (tokens.length === 0) return [];

  const root = parse(bodyHtml, { comment: false });
  const hosts = new Set<string>();
  for (const anchor of root.querySelectorAll("a")) {
    const host = hostOf(anchor.getAttribute("href") ?? "");
    if (host) hosts.add(host);
  }
  for (const match of prose(root).matchAll(URL_IN_TEXT)) {
    hosts.add(match[1].toLowerCase().replace(/^www\./, ""));
  }

  const own = (host: string) => Boolean(realHost) && (host === realHost || host.endsWith(`.${realHost}`));
  return [...hosts].filter((host) => {
    if (own(host)) return false;
    const label = squash(host.split(".").slice(0, -1).join("."));
    return tokens.some((token) => label.includes(token));
  });
}

// ── Numbers ─────────────────────────────────────────────────────────────────

export interface NumberClaim {
  kind: "price" | "percentage" | "rating" | "estimate";
  /** The figure as written, normalised to digits with a dot ("4.2", "49"). */
  value: string;
  /** The sentence it sits in, for the report and the revision. */
  sentence: string;
}

const NUM = String.raw`\d{1,3}(?:[.,]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?`;

const CLAIM_PATTERNS: { kind: NumberClaim["kind"]; pattern: RegExp }[] = [
  { kind: "price", pattern: new RegExp(String.raw`[$€£]\s?(${NUM})`, "g") },
  { kind: "price", pattern: new RegExp(String.raw`(${NUM})\s?(?:USD|EUR|GBP|dollars?|euros?|euro)\b`, "gi") },
  { kind: "percentage", pattern: new RegExp(String.raw`(${NUM})\s?(?:%|percent\b|per cent\b|per cento\b)`, "gi") },
  { kind: "rating", pattern: new RegExp(String.raw`(${NUM})\s*(?:out of|su|\/)\s*(?:5|10)\b(?!\s*[.,]?\d)`, "gi") },
  { kind: "rating", pattern: new RegExp(String.raw`(${NUM})[- ](?:stars?|stelle)\b`, "gi") },
  {
    kind: "estimate",
    pattern: new RegExp(
      String.raw`\b(?:typically|usually|generally|on average|approximately|roughly|tipicamente|di solito|in genere|in media|mediamente)\b[^.!?\n]{0,60}?(${NUM})`,
      "gi"
    ),
  },
];

function normalise(figure: string): string {
  // "1,200" and "1.200" are thousands; "4,2" is the Italian 4.2.
  if (/^\d{1,3}(?:[.,]\d{3})+$/.test(figure)) return figure.replace(/[.,]/g, "");
  return figure.replace(",", ".");
}

/** A four-digit year is a date, not a statistic. */
function isYear(value: string): boolean {
  return /^(?:19|20)\d{2}$/.test(value);
}

function sentenceAround(text: string, index: number): string {
  const start = Math.max(text.lastIndexOf(". ", index), text.lastIndexOf("\n", index)) + 1;
  const stops = [text.indexOf(". ", index), text.indexOf("\n", index)].filter((i) => i !== -1);
  const end = stops.length > 0 ? Math.min(...stops) + 1 : text.length;
  return collapseWhitespace(text.slice(start, end)).slice(0, 220);
}

/** Every figure the gate cares about: prices, percentages, ratings, hedged estimates. */
export function numberClaims(text: string): NumberClaim[] {
  const claims: NumberClaim[] = [];
  const seen = new Set<string>();
  for (const { kind, pattern } of CLAIM_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const value = normalise(match[1]);
      // "100%" is a figure of speech far more often than a measurement.
      if (kind === "percentage" && (value === "100" || value === "0")) continue;
      if (kind === "estimate" && isYear(value)) continue;
      const key = `${kind}:${value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      claims.push({ kind, value, sentence: sentenceAround(text, match.index ?? 0) });
    }
  }
  return claims;
}

/** Every figure in a text, normalised the way the claims are ("1,200" → "1200"). */
export function figuresIn(text: string): Set<string> {
  const figures = new Set<string>();
  for (const match of text.matchAll(new RegExp(NUM, "g"))) figures.add(normalise(match[0]));
  return figures;
}

/**
 * The figures the article states that nothing it was written from contains.
 * A figure is supported when the same number appears in the business's own
 * facts or in the research evidence. Years, list counts and step numbers are
 * never claims: only prices, percentages, ratings and hedged estimates are
 * read at all. It runs only for a caller that passes `facts` or `evidence`
 * (an empty string counts: "the business told us nothing" is an answer).
 */
export function unsupportedNumbers(bodyHtml: string, context: GateContext): NumberClaim[] {
  // A caller that says nothing about facts or evidence is not asking for
  // this check: with nothing to compare against, every figure would fail.
  if (context.facts === undefined && context.evidence === undefined) return [];
  const text = prose(parse(bodyHtml, { comment: false }));
  const supported = figuresIn(`${context.facts ?? ""}\n${context.evidence ?? ""}`);
  return numberClaims(text).filter((claim) => !supported.has(claim.value));
}

/** Under this, a figure is a list count or a step number far more often than a fact. */
const MIN_PRIVATE_FIGURE = 10;

/**
 * Figures the article states that come from About you and from nothing the
 * article may use: not the Facts for articles, not the research evidence.
 * Any shape, not only prices and percentages: "342 weekly impressions" is
 * neither, and it is exactly the kind of number the owner keeps off the blog
 * (12 November 2026). Years and figures under 10 are not read. Empty when
 * the caller passes no `privateFacts`.
 */
export function privateFigures(bodyHtml: string, context: GateContext): NumberClaim[] {
  const own = (context.privateFacts ?? "").trim();
  if (!own) return [];
  const privateSet = figuresIn(own);
  const allowed = figuresIn(`${context.facts ?? ""}\n${context.evidence ?? ""}`);
  const text = prose(parse(bodyHtml, { comment: false }));
  const claims: NumberClaim[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(new RegExp(NUM, "g"))) {
    const value = normalise(match[0]);
    if (isYear(value) || Number(value) < MIN_PRIVATE_FIGURE || seen.has(value)) continue;
    if (!privateSet.has(value) || allowed.has(value)) continue;
    seen.add(value);
    claims.push({ kind: "estimate", value, sentence: sentenceAround(text, match.index ?? 0) });
  }
  return claims;
}

// ── The title's promise ─────────────────────────────────────────────────────

const COUNT_NOUNS =
  "ways|tips|steps|tools|ideas|examples|strategies|reasons|mistakes|alternatives|tactics|methods|templates|practices|options|platforms|apps|plugins|generators|modi|consigli|passi|strumenti|idee|esempi|strategie|motivi|errori|alternative|metodi";

function listSizes(root: HTMLElement): number[] {
  return root.querySelectorAll("ol, ul").map((list) => list.querySelectorAll("li").length);
}

/**
 * What the title promises that the body does not contain; null when it keeps
 * its word. "Ranked" needs an ordered list, a table or numbered headings;
 * "compared" / "vs" needs a table; "7 ways" needs seven of something.
 */
export function undeliveredTitlePromise(
  title: string,
  bodyHtml: string,
  headings: { level: number; text: string }[]
): string | null {
  const root = parse(bodyHtml, { comment: false });
  const hasTable = root.querySelectorAll("table").length > 0;
  const hasOrderedList = root.querySelectorAll("ol").length > 0;
  const numberedHeadings = headings.filter((h) => /^\s*#?\d{1,2}[.):\s]/.test(h.text)).length;

  if (/\b(?:ranked|ranking|classifica)\b/i.test(title) && !hasTable && !hasOrderedList && numberedHeadings < 3) {
    return 'the title says "ranked" but the body ranks nothing: no ordered list, no table, no numbered entries';
  }
  if (/\b(?:compared|comparison|versus|vs\.?|a confronto|confronto)\b/i.test(title) && !hasTable) {
    return "the title promises a comparison but the body has no comparison table";
  }
  const counted = title.match(new RegExp(String.raw`\b(\d{1,2})\s+(?:[a-zà-ù-]+\s+){0,3}(?:${COUNT_NOUNS})\b`, "i"));
  if (counted) {
    const n = Number(counted[1]);
    const h2 = headings.filter((h) => h.level === 2).length;
    const h3 = headings.filter((h) => h.level === 3).length;
    // A list of N, N numbered entries, N subsections, or N sections plus the
    // usual closing and FAQ.
    const delivered =
      listSizes(root).includes(n) || numberedHeadings === n || h3 === n || (h2 >= n && h2 <= n + 2);
    if (!delivered) return `the title promises ${n} items but the body does not contain exactly ${n}`;
  }
  return null;
}

// ── Structure ───────────────────────────────────────────────────────────────

const FAQ_HEADING = /\b(?:faqs?|frequently asked|domande frequenti|common questions)\b/i;

export interface StructureReading {
  h2: number;
  /** H3s outside the FAQ whose section is under the minimum. */
  thinSubsections: string[];
  /** Questions under the FAQ heading; null when the article has no FAQ. */
  faqQuestions: number | null;
}

/** An H3 earns its place when its section has this many words. */
export const MIN_SUBSECTION_WORDS = 150;

export function readStructure(bodyHtml: string): StructureReading {
  const root = parse(bodyHtml, { comment: false });
  let h2 = 0;
  let inFaq = false;
  let faqQuestions: number | null = null;
  const thinSubsections: string[] = [];
  let open: { text: string; words: number } | null = null;

  const close = () => {
    if (open && open.words < MIN_SUBSECTION_WORDS) thinSubsections.push(open.text);
    open = null;
  };

  for (const node of root.childNodes) {
    const tag = node instanceof HTMLElement ? (node.tagName?.toUpperCase() ?? "") : "";
    if (tag === "H2") {
      close();
      h2++;
      inFaq = FAQ_HEADING.test(node.text);
      if (inFaq) faqQuestions = 0;
    } else if (tag === "H3") {
      close();
      if (inFaq) faqQuestions = (faqQuestions ?? 0) + 1;
      else open = { text: collapseWhitespace(node.text), words: 0 };
    } else if (open) {
      (open as { words: number }).words += countWords(node.text);
    }
  }
  close();
  return { h2, thinSubsections, faqQuestions };
}

// ── The product ─────────────────────────────────────────────────────────────

const SUPERLATIVE =
  /\b(?:unparalleled|unmatched|unrivall?ed|best|leading|ultimate|revolutionary|game[- ]chang\w+|world[- ]class|cutting[- ]edge|most (?:powerful|advanced|comprehensive)|number one|#1|senza pari|il migliore|la migliore)\b/i;

/**
 * How the article talks about the business that publishes it; an empty list
 * when it follows the rule (at most once, in the closing section, plainly).
 * An article whose keyword names the business is about the business, and is
 * not read here.
 *
 * A comparison page (`context.comparison`, the topic's intent) lists the
 * business as one option among the others (lib/agents/article-brief.ts,
 * `comparisonProductRule`): its row in the table and its own short section
 * are the brief, not selling. There the rule is no mention in the
 * introduction, no superlative, and at most `COMPARISON_MENTIONS` sentences.
 */
export const COMPARISON_MENTIONS = 6;

export function productMentionProblems(bodyHtml: string, keyword: string, context: GateContext): string[] {
  const name = (context.businessName ?? "").trim();
  if (name.length < 3 || squash(keyword).includes(squash(name))) return [];
  const mentions = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const comparison = context.comparison === true;

  const root = parse(bodyHtml, { comment: false });
  const sections: string[] = [""];
  for (const node of root.childNodes) {
    const tag = node instanceof HTMLElement ? (node.tagName?.toUpperCase() ?? "") : "";
    if (tag === "H2") sections.push("");
    // A comparison table lists every option alike; its "Best for" column is not a boast.
    else if (tag !== "PRE" && !(comparison && tag === "TABLE")) sections[sections.length - 1] += ` ${node.text}`;
  }

  const problems: string[] = [];
  const sentences = sections.map((text) =>
    collapseWhitespace(text)
      .split(/(?<=[.!?])\s+/)
      .filter((sentence) => mentions.test(sentence))
  );
  const total = sentences.reduce((sum, list) => sum + list.length, 0);
  if (total === 0) return [];

  if (sentences[0].length > 0) problems.push(`${name} is mentioned in the introduction`);
  if (comparison) {
    if (total > COMPARISON_MENTIONS) {
      problems.push(`${name} is mentioned in ${total} sentences; a comparison gives it ${COMPARISON_MENTIONS} at most, as one option`);
    }
  } else {
    const outsideClosing = sentences.slice(1, -1).some((list) => list.length > 0);
    if (sections.length > 2 && outsideClosing) problems.push(`${name} is mentioned outside the closing section`);
    if (total > 1) problems.push(`${name} is mentioned in ${total} sentences; one is the limit`);
  }
  const boast = sentences.flat().find((sentence) => SUPERLATIVE.test(sentence));
  if (boast) problems.push(`${name} is described with a superlative: "${boast.slice(0, 140)}"`);
  return problems;
}
