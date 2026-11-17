import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { articleDocuments, exportArticle } from "@/lib/content/export";
import { htmlToMarkdown } from "@/lib/markdown";
import { renderHeroFigure } from "@/lib/media/figures";
import { renderFullHtml } from "@/lib/publishing/types";
import type { CanonicalArticle } from "@/lib/content/types";

/**
 * "Copy HTML" and "Copy Markdown" moved out of the article view into
 * lib/content/export.ts, which `get_article` exports with too. Pinned: the
 * export is the document the view built before (title, hero, body; the
 * legacy HTML when there is no canonical document), and the view uses the
 * function instead of its own copy.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const hero = { url: "https://cdn.gettrafficfa.st/hero.png", alt: "A chart", caption: "Rank over time", slot: null };

const canonical: CanonicalArticle = {
  schemaVersion: 1,
  articleId: "art-1",
  title: "AI SEO & you",
  bodyHtml: '<h2 id="what">What</h2><p>It is <strong>plain</strong>.</p><ul><li>One</li></ul>',
  headings: [{ level: 2, id: "what", text: "What" }],
  excerpt: "It is.",
  metaDescription: "It is.",
  wordCount: 4,
  slug: "ai-seo",
  keyword: "ai seo",
  language: "en",
  scheduledDate: "2026-11-10",
  media: { hero, images: [], videos: [] },
};

/** What components/dashboard/article-modal.tsx computed inline before the move. */
function before(article: { canonical?: CanonicalArticle | null; content?: string | null }) {
  const view = article.canonical ?? null;
  const heroFigure = view?.media?.hero ? renderHeroFigure(view.media.hero) : "";
  const previewHtml = view ? `${heroFigure}${view.bodyHtml}` : (article.content ?? "");
  const exportHtml = view ? renderFullHtml(view, { afterTitle: heroFigure }) : (article.content ?? "");
  return { previewHtml, exportHtml, markdown: htmlToMarkdown(exportHtml) };
}

describe("exportArticle", () => {
  it("exports what the article view copied before, with the hero under the title", () => {
    for (const article of [
      { canonical, content: "<p>stale legacy</p>" },
      { canonical: { ...canonical, media: undefined } },
      { canonical: null, content: "<h1>Legacy</h1><p>Body</p>" },
      { canonical: null, content: null },
    ]) {
      const old = before(article);
      expect(articleDocuments(article)).toEqual({ previewHtml: old.previewHtml, exportHtml: old.exportHtml });
      expect(exportArticle(article, "html")).toBe(old.exportHtml);
      expect(exportArticle(article, "markdown")).toBe(old.markdown);
    }
    const html = exportArticle({ canonical }, "html");
    expect(html.startsWith("<h1>AI SEO &amp; you</h1>\n<figure")).toBe(true);
    expect(exportArticle({ canonical }, "markdown")).toContain("# AI SEO & you");
  });

  it("is what the article view copies, not a second derivation", () => {
    const modal = readFileSync(path.join(root, "components/dashboard/article-modal.tsx"), "utf8");
    expect(modal).toContain('from "@/lib/content/export"');
    expect(modal).not.toContain("renderFullHtml(");
    expect(modal).not.toContain("htmlToMarkdown(");
  });
});
