import { htmlToMarkdown } from "@/lib/markdown";
import { renderHeroFigure } from "@/lib/media/figures";
import { renderFullHtml } from "@/lib/publishing/types";
import type { CanonicalArticle } from "./types";

/**
 * An article as a person copies it out of the product: the HTML and the
 * Markdown behind "Copy HTML" and "Copy Markdown" in the article view, and
 * what `get_article` answers for `format: "html" | "markdown"`. One function
 * for both, so the export an agent reads is the one a person copies.
 *
 * Built from the Canonical Article, the very document the publisher
 * adapters receive, so neither can drift from what a customer's site gets.
 * The hero is not in canonical `bodyHtml` (destinations place it), so it is
 * put under the title with the same function the webhook uses. A legacy row
 * written before the canonical pipeline has only its stored HTML, which is
 * exported as it is.
 */

export const ARTICLE_EXPORT_FORMATS = ["html", "markdown"] as const;
export type ArticleExportFormat = (typeof ARTICLE_EXPORT_FORMATS)[number];

export interface ExportableArticle {
  canonical?: CanonicalArticle | null;
  /** The stored HTML of a legacy row; ignored once there is a canonical document. */
  content?: string | null;
}

export interface ArticleDocuments {
  /** What the article view shows: the hero, then the body, no title. */
  previewHtml: string;
  /** The whole article as HTML: title, hero, body. What "Copy HTML" copies. */
  exportHtml: string;
}

export function articleDocuments(article: ExportableArticle): ArticleDocuments {
  const view = article.canonical ?? null;
  const heroFigure = view?.media?.hero ? renderHeroFigure(view.media.hero) : "";
  return {
    previewHtml: view ? `${heroFigure}${view.bodyHtml}` : (article.content ?? ""),
    exportHtml: view ? renderFullHtml(view, { afterTitle: heroFigure }) : (article.content ?? ""),
  };
}

/** The article as "Copy HTML" or "Copy Markdown" gives it. */
export function exportArticle(article: ExportableArticle, format: ArticleExportFormat): string {
  const { exportHtml } = articleDocuments(article);
  return format === "html" ? exportHtml : htmlToMarkdown(exportHtml);
}
