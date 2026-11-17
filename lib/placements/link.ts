import { domainOf } from "@/lib/providers/serp/types";
import { isCompanySource } from "@/lib/domain/source-matching";
import type { PlacementVariant } from "./workflow";

/**
 * Which variants name the business and carry its link, and where the link
 * goes in those that do.
 *
 * A reply under someone else's thread names nothing and links nothing. The
 * 21 replies published between 28 September and 8 October 2026 all closed
 * on one sentence naming the product with its link ("GetTrafficFast
 * (https://gettrafficfa.st/) is what I use for that"), every one read as a
 * disguised advert, and none brought anything. A reader who wants to know
 * who wrote a useful reply opens the profile (docs/PLACEMENTS.md).
 *
 * Two variants still name the project, because naming it is their point:
 * the awesome-list entry (the line is the project) and the article the
 * writer publishes on their own account. In those the link sits on the
 * name, placed by code, as a Markdown link where Markdown renders and as
 * the bare URL in parentheses elsewhere: asking a person to type the URL
 * into the sentence, or a model to remember to, is how a draft got blocked
 * for "no link" with the link sitting in the link field.
 *
 * Reddit removes a comment that contains a URL by its own filter, not by a
 * moderator: four comments from this product, each with the same link, came
 * back "[Removed by Reddit]". No variant drafted for Reddit is a naming one,
 * and the surface rule stays as the backstop.
 */

/** The variants where naming the project is the point: the list entry it adds, and the article the writer owns. */
export const NAMING_VARIANTS: ReadonlySet<PlacementVariant> = new Set<PlacementVariant>(["github_pr_proposal", "article_draft"]);

/** True for the list entry and the article; false for every reply, which names no product. */
export function variantNamesBusiness(variant: PlacementVariant): boolean {
  return NAMING_VARIANTS.has(variant);
}

/** False on Reddit, where a URL gets the comment removed. */
export function replyCarriesUrl(surface: string): boolean {
  return surface !== "reddit";
}

/** Whether this variant on this surface carries the one link to the business's site. A reply never does. */
export function variantCarriesLink(variant: PlacementVariant, surface: string): boolean {
  return variantNamesBusiness(variant) && replyCarriesUrl(surface);
}

/** Surfaces that render Markdown, where the name itself is the link. */
export const MARKDOWN_SURFACES: ReadonlySet<string> = new Set(["reddit", "github", "stackexchange", "devto", "indiehackers"]);

export function linkStyle(surface: string): "markdown" | "bare" {
  return MARKDOWN_SURFACES.has(surface) ? "markdown" : "bare";
}

export function withScheme(value: string): string {
  return /^[a-z]+:\/\//i.test(value) ? value : `https://${value}`;
}

/** The business's site as a URL, or null when none is recorded. */
export function siteUrl(website: string | null | undefined): string | null {
  const trimmed = website?.trim() ?? "";
  return trimmed ? withScheme(trimmed) : null;
}

const URL_IN_TEXT = /https?:\/\/[^\s)>\]]+/gi;

/** The first URL in the text that points at the business's own domain, or null. */
export function ownLinkIn(body: string, ownDomain: string): string | null {
  if (!ownDomain) return null;
  return (
    (body.match(URL_IN_TEXT) ?? [])
      .map((url) => url.replace(/[.,;:!?]+$/, ""))
      .find((url) => isCompanySource(domainOf(url), ownDomain)) ?? null
  );
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Puts `url` on the first mention of one of `names`. Unchanged when the text
 * already carries the url, names nobody, or every mention is already a link.
 */
export function linkTheName(body: string, names: string[], url: string, surface: string): string {
  if (!url || body.includes(url)) return body;
  const parts = [...new Set(names.map((n) => n.trim()).filter(Boolean))]
    .sort((a, b) => b.length - a.length)
    .map(escape);
  if (parts.length === 0) return body;

  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])(${parts.join("|")})(?=[^\\p{L}\\p{N}]|$)`, "giu");
  for (const match of body.matchAll(pattern)) {
    const start = (match.index ?? 0) + match[1].length;
    const end = start + match[2].length;
    const before = body.slice(0, start);
    const after = body.slice(end);
    // Already a link of some kind: "[Name](…" or "Name (http…".
    if (before.endsWith("[") && after.startsWith("](")) continue;
    if (/^\s*\(https?:\/\//i.test(after)) continue;
    const name = match[2];
    const linked = linkStyle(surface) === "markdown" ? `[${name}](${url})` : `${name} (${url})`;
    return `${before}${linked}${after}`;
  }
  return body;
}

/**
 * The link a saved text carries, and the text with it placed: the rule the
 * edit route applies on every save (app/api/placements/drafts/[id]), here for
 * any writer of a saved text, a correction included.
 *
 * A reply carries none: null, and a URL in the text stays for the gate to
 * refuse. A variant that carries one takes `requested` (the link field, or
 * the stored link), else the site's own link already in the text, else the
 * homepage; when that link is the site's own and the text does not carry it,
 * it is put on the first mention of the name, in the form the surface renders.
 */
export function placeOwnLink(input: {
  body: string;
  variant: PlacementVariant;
  surface: string;
  requested: string | null;
  homepage: string | null;
  names: string[];
}): { body: string; linkUrl: string | null } {
  const { variant, surface, homepage, names } = input;
  if (!variantCarriesLink(variant, surface)) return { body: input.body, linkUrl: null };
  const site = homepage ? domainOf(homepage) : "";
  let body = input.body;
  const linkUrl = input.requested || (ownLinkIn(body, site) ?? homepage);
  if (linkUrl && site && isCompanySource(domainOf(linkUrl), site) && !ownLinkIn(body, site)) {
    body = linkTheName(body, names, linkUrl, surface);
  }
  return { body, linkUrl };
}
