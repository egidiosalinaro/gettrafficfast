import { parse } from "node-html-parser";
import {
  CANONICAL_SCHEMA_VERSION,
  CanonicalArticle,
  CanonicalHeading,
  IssueCode,
  PipelineIssue,
} from "../types";
import { clampText, collapseWhitespace, countWords, slugify } from "../text";
import { withoutShortVersionLabel } from "../anatomy";

/**
 * Stage 5 — Canonicalization.
 *
 * Turns sanitised HTML into the Canonical Article: the one representation the
 * rest of the platform is allowed to see. Every derivation here reads the
 * document tree, so a heading can never "absorb" the text that follows it and
 * an id can never be built from anything but its own heading.
 */

export interface CanonicalizeContext {
  articleId: string;
  keyword: string;
  slug: string;
  language: string;
  scheduledDate: string | null;
}

export interface CanonicalizeResult {
  article: CanonicalArticle;
  issues: PipelineIssue[];
}

const EXCERPT_LENGTH = 160;
const META_DESCRIPTION_LENGTH = 155;
const MAX_TITLE_LENGTH = 200;

export function canonicalize(
  html: string,
  ctx: CanonicalizeContext
): CanonicalizeResult {
  const root = parse(html, { comment: false });
  const issues: PipelineIssue[] = [];

  const elements = () =>
    root.querySelectorAll("*").filter((el) => Boolean(el.tagName));

  // ── Title: the first <h1>, which then leaves the body ────────────────────
  const h1s = elements().filter((el) => el.tagName.toUpperCase() === "H1");
  let title = "";

  if (h1s.length === 0) {
    issues.push({
      code: IssueCode.MISSING_TITLE,
      stage: "canonicalize",
      action: "regenerate",
      message: "The article has no <h1>, so it has no title.",
    });
    title = ctx.keyword;
  } else {
    title = collapseWhitespace(h1s[0].text) || ctx.keyword;
    h1s[0].remove();

    // Any further <h1> is demoted: one document, one top-level heading.
    for (const extra of h1s.slice(1)) {
      const demoted = parse(`<h2>${extra.innerHTML}</h2>`).firstChild;
      if (demoted) extra.replaceWith(demoted);
      issues.push({
        code: IssueCode.DUPLICATE_H1,
        stage: "canonicalize",
        action: "warn",
        message: "Demoted an additional <h1> to <h2>.",
        evidence: clampText(extra.text, 80),
      });
    }
  }

  if (title.length > MAX_TITLE_LENGTH) {
    issues.push({
      code: IssueCode.TITLE_TOO_LONG,
      stage: "canonicalize",
      action: "review",
      message: `The title is ${title.length} characters long, which is never a real article title.`,
      evidence: clampText(title, 160),
    });
  }

  // ── Anchors: every h2/h3 gets a stable, unique id ────────────────────────
  const used = new Set<string>();
  for (const el of elements()) {
    const tag = el.tagName.toUpperCase();
    if (tag !== "H2" && tag !== "H3") continue;
    const existing = el.getAttribute("id");
    if (existing) {
      used.add(existing);
      continue;
    }
    const base = slugify(el.text) || "section";
    let id = base;
    let n = 2;
    while (used.has(id)) id = `${base}-${n++}`;
    used.add(id);
    el.setAttribute("id", id);
  }

  const headings: CanonicalHeading[] = elements()
    .filter((el) => {
      const tag = el.tagName.toUpperCase();
      return tag === "H2" || tag === "H3";
    })
    .map((el) => ({
      level: (el.tagName.toUpperCase() === "H2" ? 2 : 3) as 2 | 3,
      id: el.getAttribute("id") ?? "",
      text: collapseWhitespace(el.text),
    }));

  // ── Excerpt from the first paragraph ─────────────────────────────────────
  const firstParagraph = elements().find(
    (el) => el.tagName.toUpperCase() === "P" && collapseWhitespace(el.text).length > 0
  );
  // The short version opens the body with its label in bold ("The short
  // version: …"): the excerpt is its answer, without the label.
  const excerptSource = firstParagraph ? withoutShortVersionLabel(firstParagraph) : root.text;
  const excerpt = clampText(excerptSource, EXCERPT_LENGTH);

  if (!excerpt) {
    issues.push({
      code: IssueCode.MISSING_EXCERPT,
      stage: "canonicalize",
      action: "review",
      message: "The article has no paragraph text to build an excerpt from.",
    });
  }

  const bodyHtml = root.toString().trim();

  const article: CanonicalArticle = {
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    articleId: ctx.articleId,
    title,
    bodyHtml,
    headings,
    excerpt,
    metaDescription: clampText(excerptSource, META_DESCRIPTION_LENGTH),
    wordCount: countWords(root.text),
    slug: ctx.slug,
    keyword: ctx.keyword,
    language: ctx.language,
    scheduledDate: ctx.scheduledDate,
  };

  return { article, issues };
}
