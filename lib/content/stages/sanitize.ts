import { HTMLElement, parse } from "node-html-parser";
import { IssueCode, PipelineIssue } from "../types";

/**
 * Stage 4 — Sanitization.
 *
 * Parses the HTML into a real document tree and reduces it to a semantic
 * allowlist. Working on the tree (never on the source string) is what makes
 * this safe: an unbalanced or mentioned tag can't make a transformation "run
 * past" its element, which is precisely how the previous regex-based helpers
 * corrupted documents.
 *
 * Two disposal rules, chosen so text is never silently lost:
 *  - elements that carry no article content (script, style, embeds, forms) are
 *    removed with their subtree;
 *  - any other element outside the allowlist is *unwrapped* — the element goes,
 *    its children stay.
 */

/** Tags a published article may contain. */
export const ALLOWED_TAGS = new Set([
  "H1", "H2", "H3", "H4", "H5", "H6",
  "P", "BR", "HR",
  "UL", "OL", "LI",
  "STRONG", "EM", "B", "I", "U", "S", "SUP", "SUB",
  "A", "IMG",
  "BLOCKQUOTE", "PRE", "CODE",
  "TABLE", "THEAD", "TBODY", "TFOOT", "TR", "TH", "TD",
  "FIGURE", "FIGCAPTION",
]);

/** Tags whose content is never article content. */
const DROP_WITH_SUBTREE = new Set([
  "SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "NOSCRIPT",
  "FORM", "INPUT", "BUTTON", "SELECT", "TEXTAREA", "SVG", "CANVAS", "LINK", "META",
]);

/** Attributes kept per tag; everything else is dropped. */
const ALLOWED_ATTRIBUTES: Record<string, Set<string>> = {
  A: new Set(["href", "title", "rel", "target"]),
  IMG: new Set(["src", "alt", "title", "width", "height", "loading"]),
  H2: new Set(["id"]),
  H3: new Set(["id"]),
  H4: new Set(["id"]),
  TD: new Set(["colspan", "rowspan"]),
  TH: new Set(["colspan", "rowspan", "scope"]),
  CODE: new Set(["class"]),
};

const UNSAFE_URL = /^(javascript|vbscript|file|data):/i;

/**
 * Browsers ignore ASCII whitespace and control characters inside a URL's
 * scheme ("java\tscript:" runs), so they are removed before the scheme is
 * compared; testing the raw string would let that spelling through.
 */
function isSafeUrl(value: string): boolean {
  return !UNSAFE_URL.test(value.replace(/[\u0000-\u0020\u007f]+/g, ""));
}

export interface SanitizeResult {
  html: string;
  issues: PipelineIssue[];
}

export interface SanitizeOptions {
  /**
   * Attributes allowed on top of ALLOWED_ATTRIBUTES, per tag (upper case).
   * For a consumer that renders markup the pipeline itself adds after this
   * stage, such as the hero's `figure.gtf-hero`.
   */
  extraAttributes?: Record<string, readonly string[]>;
}

export function sanitizeHtml(input: string, options: SanitizeOptions = {}): SanitizeResult {
  const root = parse(input, { comment: false });
  const removed: string[] = [];

  for (const element of root.querySelectorAll("*")) {
    const tag = element.tagName?.toUpperCase();
    if (!tag) continue;

    if (DROP_WITH_SUBTREE.has(tag)) {
      removed.push(`<${tag.toLowerCase()}>`);
      element.remove();
      continue;
    }

    if (!ALLOWED_TAGS.has(tag)) {
      // Keep the words, drop the wrapper.
      element.replaceWith(...element.childNodes);
      continue;
    }

    const allowed = new Set<string>(ALLOWED_ATTRIBUTES[tag] ?? []);
    for (const name of options.extraAttributes?.[tag] ?? []) allowed.add(name);
    for (const name of Object.keys(element.attributes)) {
      const value = element.getAttribute(name) ?? "";
      const keep =
        allowed.has(name.toLowerCase()) &&
        !(
          (name.toLowerCase() === "href" || name.toLowerCase() === "src") &&
          !isSafeUrl(value)
        );
      if (!keep) {
        if (!allowed.has(name.toLowerCase()) && /^on/i.test(name)) {
          removed.push(`${tag.toLowerCase()}[${name}]`);
        } else if (allowed.has(name.toLowerCase())) {
          removed.push(`${tag.toLowerCase()}[${name}] (unsafe url)`);
        }
        element.removeAttribute(name);
      }
    }
  }

  const issues: PipelineIssue[] = [];
  if (removed.length > 0) {
    issues.push({
      code: IssueCode.UNSAFE_MARKUP_REMOVED,
      stage: "sanitize",
      action: "warn",
      message: `Removed ${removed.length} disallowed element(s)/attribute(s) while sanitising.`,
      evidence: Array.from(new Set(removed)).slice(0, 8).join(", "),
    });
  }

  return { html: root.toString().trim(), issues };
}

/** Parses sanitised HTML back into a tree (used by the canonicalizer). */
export function parseFragment(html: string): HTMLElement {
  return parse(html, { comment: false });
}
