import { parse } from "node-html-parser";
import { CanonicalArticle, IssueCode, PipelineIssue } from "../types";
import { clampText, collapseWhitespace } from "../text";
import {
  GateContext,
  lookalikeHosts,
  privateFigures,
  productMentionProblems,
  readStructure,
  undeliveredTitlePromise,
  unsupportedNumbers,
} from "./claims";
import { MAX_TITLE_LENGTH, articleTells, bannedTitleWord } from "./tells";
import { anatomyProblems } from "./anatomy";
import { withoutReadNext } from "../anatomy";

/**
 * Quality gates.
 *
 * Assertions about a finished Canonical Article, run immediately before it may
 * be handed to a publisher. Gates only ever *observe* — they never rewrite
 * content. A failing gate routes the article away from publication (to a human,
 * or back to generation); it does not try to repair it.
 *
 * Losing a publication is always preferable to putting corrupted content on a
 * customer's domain.
 */

/** Under this, the output is not an article at all. */
const MIN_WORDS_HARD = 300;
/** Under this, it is suspiciously thin for a 900–1500 word brief. */
const MIN_WORDS_SOFT = 600;
/** An article is expected to be sectioned. */
const MIN_H2_SECTIONS = 2;
/**
 * 900–1500 words is the ceiling for most keywords, not the floor. Above this
 * the draft goes back to be cut: 22 of 36 production articles were over
 * 1,500 on 2026-11-10, the longest 3,643.
 */
export const MAX_WORDS = 1800;
/** More H2s than this and the article is an index, not a text. */
const MAX_H2_SECTIONS = 10;

/**
 * Markdown constructs that must not survive normalization. These are
 * *detectors*: finding one means the normalizer failed and the article needs a
 * human, not that we should start substituting characters.
 */
const MARKDOWN_MARKERS: { label: string; test: RegExp }[] = [
  { label: "heading (#)", test: /^\s{0,3}#{1,6}\s+\S/m },
  { label: "bullet list", test: /^\s{0,3}[*+]\s{1,3}\S/m },
  { label: "dash list", test: /^\s{0,3}-\s{1,3}\S/m },
  { label: "ordered list", test: /^\s{0,3}\d+\.\s{1,3}\S/m },
  { label: "bold (**)", test: /\*\*[^*\n]+\*\*|__[^_\n]+__/ },
  { label: "emphasis (*)", test: /(^|\s)\*[^*\n]+\*(\s|$)/ },
  { label: "link ([]())", test: /\[[^\]\n]+\]\((?:https?:\/\/|\/|#)[^)\s]*\)/ },
  { label: "thematic break", test: /^\s{0,3}(\*{3,}|_{3,})\s*$/m },
  { label: "inline code (`)", test: /`[^`\n]+`/ },
];

/**
 * Signals that a text is *describing* an article rather than being one — the
 * fingerprint of a model that emitted its plan or its instructions. Any single
 * signal can appear in a legitimate article about SEO, so a hit requires two
 * distinct signals.
 */
const PLANNING_SIGNALS: { label: string; test: RegExp }[] = [
  { label: "markup named in prose", test: /<\/?h[1-6]>|&lt;\/?h[1-6]&gt;/i },
  { label: "word budget", test: /\b\d{3,4}\s*[–—-]\s*\d{3,4}\s+words?\b/i },
  {
    label: "outline label",
    test: /^\s*\*?\s*\*?(primary keyword|variations?\s*\/?\s*synonyms?|title idea|intro|conclusion with cta|h[23]\s*[-–—])\b/im,
  },
  {
    label: "authoring instruction",
    test: /\b(no keyword stuffing|do not invent|output (?:only|valid)|no code fences|no markdown|scannable)\b/i,
  },
];

/** Body text with code/pre removed — those may legitimately contain markers. */
function proseText(bodyHtml: string): string {
  const root = parse(bodyHtml, { comment: false });
  for (const el of root.querySelectorAll("*")) {
    const tag = el.tagName?.toUpperCase();
    if (tag === "CODE" || tag === "PRE") el.remove();
  }
  // Keep line structure: markdown detectors are line-anchored.
  return root.structuredText ?? root.text;
}

export function runQualityGates(article: CanonicalArticle, context: GateContext = {}): PipelineIssue[] {
  const issues: PipelineIssue[] = [];
  const push = (
    code: PipelineIssue["code"],
    action: PipelineIssue["action"],
    message: string,
    evidence?: string
  ) => issues.push({ code, stage: "quality", action, message, evidence });

  // ── Structure ────────────────────────────────────────────────────────────
  const body = article.bodyHtml.trim();
  if (!body) {
    push(IssueCode.EMPTY_BODY, "regenerate", "The article body is empty.");
    return issues;
  }

  if (!article.title.trim()) {
    push(IssueCode.MISSING_TITLE, "regenerate", "The article has no title.");
  }

  if (article.wordCount < MIN_WORDS_HARD) {
    push(
      IssueCode.ARTICLE_TOO_SHORT,
      "regenerate",
      `The article is ${article.wordCount} words, far below the ${MIN_WORDS_HARD}-word floor.`
    );
  } else if (article.wordCount < MIN_WORDS_SOFT) {
    push(
      IssueCode.ARTICLE_TOO_SHORT,
      "review",
      `The article is only ${article.wordCount} words (expected 900–1500).`
    );
  }

  const h2Count = article.headings.filter((h) => h.level === 2).length;
  if (h2Count < MIN_H2_SECTIONS) {
    push(
      IssueCode.INSUFFICIENT_SECTIONS,
      "review",
      `The article has ${h2Count} <h2> section(s); at least ${MIN_H2_SECTIONS} are expected.`
    );
  }

  // ── Invariants of the canonical contract ─────────────────────────────────
  const root = parse(body, { comment: false });
  const domHeadings = root
    .querySelectorAll("*")
    .filter((el) => ["H2", "H3"].includes(el.tagName?.toUpperCase() ?? ""));

  if (domHeadings.length !== article.headings.length) {
    push(
      IssueCode.HEADING_ANCHOR_MISMATCH,
      "review",
      `The outline lists ${article.headings.length} heading(s) but the body contains ${domHeadings.length}.`
    );
  }
  const missingAnchor = article.headings.find(
    (h) => !h.id || !body.includes(`id="${h.id}"`)
  );
  if (missingAnchor) {
    push(
      IssueCode.HEADING_ANCHOR_MISMATCH,
      "review",
      "A heading in the outline has no matching anchor in the body.",
      clampText(missingAnchor.text, 80)
    );
  }
  if (root.querySelectorAll("h1").length > 0) {
    push(
      IssueCode.DUPLICATE_H1,
      "review",
      "The canonical body still contains an <h1>; the title must be the only one."
    );
  }

  // ── Residue and leakage ──────────────────────────────────────────────────
  // Everything from here reads what the writer wrote: the Read next block the
  // knowledge step appends (titles of other articles, their links) is not
  // the article's prose, and would otherwise count as its closing section,
  // its lists and its figures.
  const written = withoutReadNext(body);
  const prose = proseText(written);
  const markerHits = MARKDOWN_MARKERS.filter((m) => m.test.test(prose));
  if (markerHits.length > 0) {
    push(
      IssueCode.MARKDOWN_RESIDUE,
      "review",
      "Unconverted Markdown is still present in the article text.",
      markerHits.map((m) => m.label).join(", ")
    );
  }

  const planningHits = PLANNING_SIGNALS.filter(
    (s) => s.test.test(prose) || s.test.test(article.title)
  );
  if (planningHits.length >= 2) {
    push(
      IssueCode.CHAIN_OF_THOUGHT,
      "review",
      "The text reads like a plan or a restatement of the brief rather than an article.",
      planningHits.map((s) => s.label).join(", ")
    );
  }

  // ── Metadata coherence ───────────────────────────────────────────────────
  if (!collapseWhitespace(article.excerpt)) {
    push(IssueCode.MISSING_EXCERPT, "review", "The article has no excerpt.");
  }
  if (article.title.length > 200) {
    push(
      IssueCode.TITLE_TOO_LONG,
      "review",
      `The title is ${article.title.length} characters long.`,
      clampText(article.title, 160)
    );
  }

  // ── Editorial checks ─────────────────────────────────────────────────────
  // What the article says, not whether it is a document. Each of these sends
  // the draft to the revision pass with the problem named.
  const tells = articleTells(`${article.title}\n${prose}`);
  if (tells.length > 0) {
    push(
      IssueCode.STOCK_PHRASE,
      "warn",
      `The article uses stock phrases a reader recognises as filler: ${tells.map((t) => `"${t.sample}"`).join(", ")}.`,
      tells.map((t) => t.name).join(", ")
    );
  }

  const banned = bannedTitleWord(article.title);
  if (banned || (article.title.length > MAX_TITLE_LENGTH && article.title.length <= 200)) {
    const reasons = [
      article.title.length > MAX_TITLE_LENGTH
        ? `it is ${article.title.length} characters long (the limit is ${MAX_TITLE_LENGTH})`
        : null,
      banned ? `it leans on "${banned}"` : null,
    ].filter(Boolean);
    push(IssueCode.TITLE_STYLE, "warn", `The title needs rewriting: ${reasons.join(" and ")}.`, clampText(article.title, 160));
  }

  const promise = undeliveredTitlePromise(article.title, written, article.headings);
  if (promise) {
    push(IssueCode.TITLE_UNDELIVERED, "warn", `The title is not delivered by the body: ${promise}.`, clampText(article.title, 160));
  }

  if (article.wordCount > MAX_WORDS) {
    push(
      IssueCode.ARTICLE_TOO_LONG,
      "warn",
      `The article is ${article.wordCount} words; ${MAX_WORDS} is the cap and 900–1500 the target.`
    );
  }

  const structure = readStructure(written);
  if (structure.h2 > MAX_H2_SECTIONS || structure.thinSubsections.length >= 2) {
    push(
      IssueCode.HEADING_BLOAT,
      "warn",
      `The article has too many headings for its length: ${article.headings.length} headings in ${article.wordCount} words` +
        (structure.thinSubsections.length > 0
          ? `, ${structure.thinSubsections.length} subsection(s) under 150 words.`
          : "."),
      structure.thinSubsections.slice(0, 5).join(" | ")
    );
  }
  if (structure.faqQuestions !== null && structure.faqQuestions < 3) {
    push(
      IssueCode.THIN_FAQ,
      "warn",
      `The FAQ has ${structure.faqQuestions} question(s); an FAQ is 3 to 5 real questions, or it is not there.`
    );
  }

  const product = productMentionProblems(written, article.keyword, context);
  if (product.length > 0) {
    push(IssueCode.PRODUCT_MENTION, "warn", `The article sells: ${product.join("; ")}.`);
  }

  // The two that also block: a link a reader would follow to a site that is
  // not the business's, and a figure nobody can vouch for.
  const lookalikes = lookalikeHosts(written, context);
  if (lookalikes.length > 0) {
    push(
      IssueCode.LOOKALIKE_LINK,
      "review",
      `The article points at ${lookalikes.join(", ")}, which reads like the business but is not its site` +
        (context.websiteUrl ? ` (${context.websiteUrl}).` : "."),
      lookalikes.join(", ")
    );
  }

  const numbers = unsupportedNumbers(written, context);
  if (numbers.length > 0) {
    push(
      IssueCode.UNSUPPORTED_NUMBER,
      "review",
      `The article states ${numbers.length === 1 ? "a figure" : "figures"} found neither in the business's own facts nor in the research: ${numbers
        .slice(0, 6)
        .map((n) => `"${n.sentence}"`)
        .join(" | ")}`,
      numbers.map((n) => `${n.kind} ${n.value}`).join(", ")
    );
  }

  // About you is for replies. A figure from it on the public blog is held,
  // and the revision is told to take it out (2026-11-12).
  const privates = privateFigures(written, context);
  if (privates.length > 0) {
    push(
      IssueCode.PRIVATE_FACT,
      "review",
      `The article states ${privates.length === 1 ? "a figure" : "figures"} from About you that the owner has not listed in Facts for articles, so ${privates.length === 1 ? "it does" : "they do"} not belong on the public blog: ${privates
        .slice(0, 6)
        .map((n) => `"${n.sentence}"`)
        .join(" | ")}`,
      privates.map((n) => n.value).join(", ")
    );
  }

  // The anatomy (2026-11-15): the answer first, headings that are
  // questions, a data section only with the owner's data. Each sends the
  // draft to the revision; only a figure in "From our data" that the owner
  // never gave also holds it.
  for (const problem of anatomyProblems(article, written, context)) {
    push(problem.code, problem.action, problem.message, problem.evidence);
  }

  return issues;
}
