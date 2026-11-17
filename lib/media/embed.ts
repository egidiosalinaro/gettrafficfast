import { HTMLElement, parse } from "node-html-parser";
import { CanonicalVideo } from "@/lib/content/types";
import { ArticleImage, escapeText, renderFigure } from "./figures";

export { renderFigure, renderHeroFigure } from "./figures";

/**
 * Media placement in the article body — tree operations only, per the
 * platform's standing rule: structural manipulation never happens on the
 * source string.
 *
 * Inline images become `<figure>` elements at the END of their section (before
 * the next h2/h3, or at the document end), so they illustrate the section they
 * belong to without ever displacing the first paragraph — the excerpt and
 * meta description derive from it and must not change.
 */

/** The element ending `heading`'s section: the next h2/h3, or null at EOF. */
function sectionEnd(root: HTMLElement, heading: HTMLElement): HTMLElement | null {
  const blocks = root.childNodes.filter(
    (n): n is HTMLElement => n instanceof HTMLElement && Boolean(n.tagName)
  );
  const start = blocks.indexOf(heading);
  if (start === -1) return null;
  for (const block of blocks.slice(start + 1)) {
    const tag = block.tagName.toUpperCase();
    if (tag === "H2" || tag === "H3") return block;
  }
  return null;
}

/**
 * Embeds inline images into the body at their slots. Idempotent: an image
 * whose URL is already present in the document is not inserted twice, so
 * re-running enrichment can never duplicate figures.
 */
export function embedInlineImages(bodyHtml: string, images: ArticleImage[]): string {
  if (images.length === 0) return bodyHtml;
  const root = parse(bodyHtml, { comment: false });

  for (const image of images) {
    if (!image.slot) continue;
    if (root.querySelector(`img[src="${image.url}"]`)) continue;

    const heading = root.querySelector(`[id="${image.slot}"]`);
    if (!heading) continue;

    const figure = renderFigure(image);
    const boundary = sectionEnd(root, heading);
    if (boundary) boundary.insertAdjacentHTML("beforebegin", figure);
    else root.insertAdjacentHTML("beforeend", figure);
  }

  return root.toString();
}

/**
 * Renders videos as plain watch-URL paragraphs after their section's heading
 * block — the form WordPress oEmbeds into a real player. Used by adapters
 * whose destination auto-embeds URLs; receivers that render iframes use the
 * structured `media.videos` instead.
 */
export function appendVideoParagraphs(bodyHtml: string, videos: CanonicalVideo[]): string {
  if (videos.length === 0) return bodyHtml;
  const root = parse(bodyHtml, { comment: false });

  for (const video of videos) {
    if (root.text.includes(video.url)) continue;
    const heading = root.querySelector(`[id="${video.slot}"]`);
    const paragraph = `<p>${escapeText(video.url)}</p>`;

    if (!heading) {
      root.insertAdjacentHTML("beforeend", paragraph);
      continue;
    }
    const boundary = sectionEnd(root, heading);
    if (boundary) boundary.insertAdjacentHTML("beforebegin", paragraph);
    else root.insertAdjacentHTML("beforeend", paragraph);
  }

  return root.toString();
}
