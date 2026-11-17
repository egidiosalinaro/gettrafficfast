import { HTMLElement, parse } from "node-html-parser";
import { isReadNextHeading, readShortVersion } from "@/lib/content/anatomy";
import type { CanonicalArticle } from "@/lib/content/types";
import { withDateModified } from "@/lib/publishing/seo";
import { applyInternalLinks, findPhraseAnchor, linkedHrefs } from "./linking";

/**
 * Push page 3: ONE contextual link from one of the site's best pages to the
 * article being pushed (docs/LIFECYCLE.md, "Push page 3"). The pure part;
 * reading, asking the model, storing and delivering are the workflow's
 * (lib/jobs/workflows/push-article.ts).
 *
 * Two ways in, both verified on the parsed tree, never on the source string:
 *
 * - **existing**: an anchor the page already writes, wrapped where it stands
 *   by `applyInternalLinks` (verbatim, once, one text node, outside headings,
 *   links, code and figures), the verifier every internal link goes through;
 * - **sentence**: one short sentence added at the end of one of the page's
 *   own paragraphs, holding the anchor once. Plain text, at most
 *   `MAX_ADDED_WORDS` words, no address, no markup: it is escaped, and the
 *   only element written is the link.
 *
 * Never in the short version (the paragraph an engine quotes alone), never
 * in Read next, never a second link to the same address in a page.
 */

export const MAX_ADDED_WORDS = 30;
export const MAX_ADDED_CHARS = 220;

export type PushLinkSuggestion =
  | { mode: "existing"; anchor: string }
  | { mode: "sentence"; paragraph: number; sentence: string; anchor: string };

const isElement = (node: unknown): node is HTMLElement => node instanceof HTMLElement;
const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeAttribute(text: string): string {
  return escapeText(text).replace(/"/g, "&quot;");
}

/**
 * The top-level paragraphs a sentence may be added to, numbered from 1 in
 * document order: not the short version, nothing after the Read next
 * heading, never one inside a figure. The numbers are what the model is
 * shown and answers with.
 */
function paragraphNodes(bodyHtml: string): { root: HTMLElement; paragraphs: HTMLElement[] } {
  const root = parse(bodyHtml, { comment: false });
  const shortVersion = readShortVersion(bodyHtml) !== null;
  const paragraphs: HTMLElement[] = [];
  let firstParagraphSeen = false;
  for (const node of root.childNodes) {
    if (!isElement(node)) continue;
    const tag = node.tagName?.toUpperCase();
    if (tag === "H2" && isReadNextHeading({ id: node.getAttribute("id"), text: node.text })) break;
    if (tag !== "P") continue;
    if (!firstParagraphSeen) {
      firstParagraphSeen = true;
      if (shortVersion) continue;
    }
    if (!collapse(node.text)) continue;
    paragraphs.push(node);
  }
  return { root, paragraphs };
}

/** The paragraphs as the model sees them: number and plain text. */
export function linkableParagraphs(bodyHtml: string, maxChars = 400): Array<{ index: number; text: string }> {
  return paragraphNodes(bodyHtml).paragraphs.map((p, i) => ({ index: i + 1, text: collapse(p.text).slice(0, maxChars) }));
}

/** How many links the body has to `href`. */
export function linksToCount(bodyHtml: string, href: string): number {
  return parse(bodyHtml, { comment: false })
    .querySelectorAll("a")
    .filter((a) => a.getAttribute("href") === href).length;
}

/** Whether `sentence` is one plain, short sentence holding `anchor` exactly once. */
export function checkAddedSentence(sentence: string, anchor: string): { ok: true; sentence: string } | { ok: false; reason: string } {
  const text = collapse(sentence);
  if (!text) return { ok: false, reason: "no sentence" };
  if (/[<>]/.test(text)) return { ok: false, reason: "the sentence holds markup" };
  if (/https?:\/\/|www\./i.test(text)) return { ok: false, reason: "the sentence holds an address" };
  if (text.length > MAX_ADDED_CHARS || text.split(" ").length > MAX_ADDED_WORDS) return { ok: false, reason: "the sentence is too long" };
  if (!/[.?!]$/.test(text)) return { ok: false, reason: "not a whole sentence" };
  // One sentence: no full stop followed by a capital in the middle.
  if (/[.?!]\s+\p{Lu}/u.test(text.slice(0, -1))) return { ok: false, reason: "more than one sentence" };
  const at = text.indexOf(anchor);
  if (!anchor.trim() || at === -1) return { ok: false, reason: "the anchor is not in the sentence" };
  if (text.indexOf(anchor, at + anchor.length) !== -1) return { ok: false, reason: "the anchor is twice in the sentence" };
  return { ok: true, sentence: text };
}

export type PushLinkOutcome =
  | {
      linked: true;
      canonical: CanonicalArticle;
      anchor: string;
      mode: "existing" | "sentence";
      /** The added sentence, for the record and for a proposal. */
      sentence: string | null;
      /** "query": the page wrote the main query itself (no model); "agent": the model's suggestion. */
      via: "query" | "agent";
    }
  | { linked: false; reason: string };

/**
 * Places ONE link to `target.url` in `source`, or leaves it exactly as it
 * was. The main query written verbatim by the page is used first, with no
 * model; otherwise the suggestion. `anchorOk` is the caller's rule for what
 * counts as the query or a natural variant of it.
 */
export function placePushLink(params: {
  source: CanonicalArticle;
  target: { articleId: string; url: string; mainQuery: string };
  suggestion?: PushLinkSuggestion | null;
  anchorOk: (anchor: string) => boolean;
  now?: Date;
}): PushLinkOutcome {
  const { source, target } = params;
  if (source.articleId === target.articleId) return { linked: false, reason: "an article never links to itself" };
  if (linkedHrefs(source.bodyHtml).has(target.url)) return { linked: false, reason: "already links to the article" };

  const shortVersionBefore = shortVersionLinks(source.bodyHtml);
  const finish = (bodyHtml: string, anchor: string, mode: "existing" | "sentence", sentence: string | null, via: "query" | "agent"): PushLinkOutcome => {
    if (linksToCount(bodyHtml, target.url) !== 1) return { linked: false, reason: "the link was not placed exactly once" };
    if (shortVersionLinks(bodyHtml) !== shortVersionBefore) return { linked: false, reason: "the anchor is in the short version" };
    return { linked: true, canonical: withDateModified({ ...source, bodyHtml }, params.now), anchor, mode, sentence, via };
  };

  const existing = (anchor: string, via: "query" | "agent"): PushLinkOutcome => {
    if (!params.anchorOk(anchor)) return { linked: false, reason: "the anchor is not the main query or a variant of it" };
    const result = applyInternalLinks(source.bodyHtml, [{ targetArticleId: target.articleId, anchor, href: target.url }]);
    if (result.applied.length !== 1) return { linked: false, reason: result.skipped[0]?.reason ?? "anchor not applied" };
    return finish(result.bodyHtml, anchor, "existing", null, via);
  };

  // Looked for outside the short version: a spelling found only there is no anchor.
  const fromQuery = findPhraseAnchor(withoutShortVersion(source.bodyHtml), target.mainQuery);
  if (fromQuery) {
    const outcome = existing(fromQuery, "query");
    if (outcome.linked) return outcome;
  }

  const suggestion = params.suggestion;
  if (!suggestion) return { linked: false, reason: "no natural place for the link in this page" };
  const anchor = collapse(suggestion.anchor);
  if (suggestion.mode === "existing") return existing(anchor, "agent");

  if (!params.anchorOk(anchor)) return { linked: false, reason: "the anchor is not the main query or a variant of it" };
  const checked = checkAddedSentence(suggestion.sentence, anchor);
  if (!checked.ok) return { linked: false, reason: checked.reason };
  const { root, paragraphs } = paragraphNodes(source.bodyHtml);
  const paragraph = paragraphs[suggestion.paragraph - 1];
  if (!paragraph) return { linked: false, reason: "no such paragraph" };
  const at = checked.sentence.indexOf(anchor);
  const html =
    " " +
    escapeText(checked.sentence.slice(0, at)) +
    `<a href="${escapeAttribute(target.url)}">${escapeText(anchor)}</a>` +
    escapeText(checked.sentence.slice(at + anchor.length));
  paragraph.set_content(paragraph.innerHTML.replace(/\s+$/, "") + html);
  return finish(root.toString(), anchor, "sentence", checked.sentence, "agent");
}

/** The body without its short version paragraph. */
function withoutShortVersion(bodyHtml: string): string {
  if (!readShortVersion(bodyHtml)) return bodyHtml;
  const root = parse(bodyHtml, { comment: false });
  const first = root.childNodes.find((node) => isElement(node) && node.tagName?.toUpperCase() === "P");
  first?.remove();
  return root.toString();
}

/** Links inside the short version paragraph (0 when there is none). */
function shortVersionLinks(bodyHtml: string): number {
  if (!readShortVersion(bodyHtml)) return 0;
  const root = parse(bodyHtml, { comment: false });
  const first = root.childNodes.find((node) => isElement(node) && node.tagName?.toUpperCase() === "P") as HTMLElement | undefined;
  return first ? first.querySelectorAll("a").length : 0;
}
