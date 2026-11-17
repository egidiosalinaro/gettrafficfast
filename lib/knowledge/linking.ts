import { HTMLElement, Node, TextNode, parse } from "node-html-parser";

/**
 * Internal-link placement — pure functions, tree operations only.
 *
 * The agent proposes an anchor; this module is the part that is allowed to
 * touch the article, and it trusts nothing. A link is applied only when the
 * anchor text exists verbatim, exactly once, inside a single text node of a
 * linkable region. Anything else is dropped with a reason — a wrong or
 * ambiguous anchor can never alter the article. Idempotent: a target already
 * linked in the document is never linked twice.
 */

export interface LinkPlacement {
  targetArticleId: string;
  /** Exact raw-text span to wrap. */
  anchor: string;
  href: string;
}

export interface SkippedLink extends LinkPlacement {
  reason: string;
}

export interface ApplyLinksResult {
  bodyHtml: string;
  applied: LinkPlacement[];
  skipped: SkippedLink[];
}

/**
 * Regions where a link must never be inserted: inside another link, headings
 * (their text is an anchor id contract), code, and figure furniture.
 */
const NON_LINKABLE = new Set([
  "A", "H1", "H2", "H3", "H4", "H5", "H6",
  "CODE", "PRE", "FIGURE", "FIGCAPTION",
]);

function isElement(node: Node): node is HTMLElement {
  return node instanceof HTMLElement;
}

/** Depth-first text nodes, excluding subtrees rooted at non-linkable tags. */
function linkableTextNodes(node: Node, out: TextNode[]): void {
  if (isElement(node)) {
    const tag = node.tagName?.toUpperCase();
    if (tag && NON_LINKABLE.has(tag)) return;
    for (const child of node.childNodes) linkableTextNodes(child, out);
    return;
  }
  if (node instanceof TextNode) out.push(node);
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Replaces a text node with the parsed children of `html`, in place. */
function replaceTextNode(node: TextNode, html: string): void {
  const parent = node.parentNode;
  if (!parent) return;
  const index = parent.childNodes.indexOf(node);
  if (index === -1) return;
  const replacement = parse(html, { comment: false }).childNodes;
  for (const child of replacement) child.parentNode = parent;
  parent.childNodes.splice(index, 1, ...replacement);
}

/**
 * Applies verified internal links to the body. Matching happens on the RAW
 * text of a node (entities still encoded), which is the same form the agent
 * saw — the tag-stripped body — so a verbatim copy round-trips exactly.
 */
export function applyInternalLinks(
  bodyHtml: string,
  placements: LinkPlacement[]
): ApplyLinksResult {
  if (placements.length === 0) {
    return { bodyHtml, applied: [], skipped: [] };
  }

  const root = parse(bodyHtml, { comment: false });
  const applied: LinkPlacement[] = [];
  const skipped: SkippedLink[] = [];

  for (const placement of placements) {
    const anchor = placement.anchor;

    // Attribute compared directly — an href is data, never selector syntax.
    const alreadyLinked = root
      .querySelectorAll("a")
      .some((a) => a.getAttribute("href") === placement.href);
    if (alreadyLinked) {
      skipped.push({ ...placement, reason: "target already linked in this article" });
      continue;
    }

    // Recollected per placement: an earlier insertion reshapes the tree.
    const nodes: TextNode[] = [];
    linkableTextNodes(root, nodes);

    const matches = nodes
      .map((node) => ({ node, count: countOccurrences(node.rawText, anchor) }))
      .filter((m) => m.count > 0);
    const total = matches.reduce((sum, m) => sum + m.count, 0);

    if (total === 0) {
      skipped.push({
        ...placement,
        reason: "anchor not found verbatim in a linkable text node",
      });
      continue;
    }
    if (total > 1) {
      skipped.push({ ...placement, reason: `anchor is ambiguous (${total} occurrences)` });
      continue;
    }

    const { node } = matches[0];
    const at = node.rawText.indexOf(anchor);
    const html =
      node.rawText.slice(0, at) +
      `<a href="${escapeAttribute(placement.href)}">` +
      anchor +
      `</a>` +
      node.rawText.slice(at + anchor.length);
    replaceTextNode(node, html);
    applied.push(placement);
  }

  return { bodyHtml: root.toString(), applied, skipped };
}

/**
 * The body text the link agent reasons about: tags become spaces, entities
 * stay encoded. This exact form is what anchors are verified against, so it
 * lives here — next to the verifier — rather than at call sites.
 */
export function linkableBodyText(bodyHtml: string): string {
  return bodyHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/** Every href the body links to. */
export function linkedHrefs(bodyHtml: string): Set<string> {
  return new Set(
    parse(bodyHtml, { comment: false })
      .querySelectorAll("a")
      .map((a) => a.getAttribute("href") ?? "")
      .filter(Boolean)
  );
}

/** Whether the body already links to `href` (compared as data, never as a selector). */
export function linksTo(bodyHtml: string, href: string): boolean {
  return parse(bodyHtml, { comment: false })
    .querySelectorAll("a")
    .some((a) => a.getAttribute("href") === href);
}

/** A phrase shorter than this is a word, not what an article is about: never an anchor. */
const MIN_PHRASE_ANCHOR = 8;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Looks for `phrase` in the body's linkable text, in any letter case, as
 * whole words, and returns the span exactly as the body writes it: an
 * anchor `applyInternalLinks` can verify character for character. Null
 * when the body does not write it, or writes every spelling of it more than
 * once: nothing is guessed, and the verifier still has the last word (a
 * span that also occurs inside a longer word is ambiguous to it). No model
 * is asked.
 *
 * The phrase is matched on the node's raw text (entities still encoded),
 * so a phrase holding `&`, `<` or `>` is looked up in its encoded form.
 */
export function findPhraseAnchor(bodyHtml: string, phrase: string): string | null {
  const wanted = phrase.replace(/\s+/g, " ").trim();
  if (wanted.length < MIN_PHRASE_ANCHOR) return null;
  const encoded = wanted.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // Whole words only: "cart email" is not found inside "cart emails".
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(encoded).replace(/ /g, "\\s+")}(?![\\p{L}\\p{N}])`, "giu");

  const nodes: TextNode[] = [];
  linkableTextNodes(parse(bodyHtml, { comment: false }), nodes);
  const spans: string[] = [];
  for (const node of nodes) {
    for (const match of node.rawText.matchAll(pattern)) spans.push(match[0]);
  }
  // The first spelling the body writes exactly once ("Cart email" opening a
  // sentence, "cart email" inside one): the verifier compares case too.
  return spans.find((span) => spans.filter((other) => other === span).length === 1) ?? null;
}
