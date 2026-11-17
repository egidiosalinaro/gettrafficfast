import { CanonicalImage } from "@/lib/content/types";

/**
 * The `<figure>` markup for article images. Pure string rendering, with no
 * parser dependency, so the dashboard preview can import it without pulling
 * the HTML parser into the browser bundle. The webhook adapter and the
 * preview use these same functions: what the customer sees in GetTrafficFast
 * is what their site receives.
 */

/**
 * An article image with the pixel size of its stored file. The size is
 * written by the storage step; images stored before 2026-11-10 do not have
 * it, and their markup simply carries no `width`/`height`.
 */
export type ArticleImage = CanonicalImage & {
  width?: number | null;
  height?: number | null;
};

/**
 * ` width="…" height="…"` when both are known, nothing otherwise. With them a
 * browser reserves the image's box before the file arrives, so the text does
 * not jump; a guessed size would reserve the wrong box, so there is no
 * fallback.
 */
function sizeAttributes(image: ArticleImage): string {
  const { width, height } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height)) return "";
  if ((width as number) <= 0 || (height as number) <= 0) return "";
  return ` width="${width}" height="${height}"`;
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderFigure(image: ArticleImage): string {
  const caption = image.caption
    ? `<figcaption>${escapeText(image.caption)}</figcaption>`
    : "";
  return `<figure><img src="${escapeAttribute(image.url)}" alt="${escapeAttribute(image.alt)}"${sizeAttributes(image)} loading="lazy" />${caption}</figure>`;
}

/**
 * The hero as a `<figure>`. It always travels in html/body_html so a receiver
 * that only renders the body still shows the photo.
 *
 * Not `renderFigure`: the hero is the one image guaranteed to be above the
 * fold, so lazy-loading it delays the largest contentful paint instead of
 * saving anything. It also carries a namespaced class, because a receiver
 * needs some way to style it differently from the illustrations.
 */
export function renderHeroFigure(image: ArticleImage): string {
  const caption = image.caption
    ? `<figcaption>${escapeText(image.caption)}</figcaption>`
    : "";
  return `<figure class="gtf-hero"><img src="${escapeAttribute(image.url)}" alt="${escapeAttribute(image.alt)}"${sizeAttributes(image)} loading="eager" fetchpriority="high" />${caption}</figure>`;
}
