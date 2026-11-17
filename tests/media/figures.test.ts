import { describe, expect, it } from "vitest";
import { renderFigure, renderHeroFigure } from "@/lib/media/figures";
import { renderHeroFigure as reExported } from "@/lib/media/embed";
import { htmlToMarkdown } from "@/lib/markdown";
import { renderFullHtml } from "@/lib/publishing/types";
import type { CanonicalArticle, CanonicalImage } from "@/lib/content/types";

const hero: CanonicalImage = {
  url: "https://storage.example.com/a/hero.png",
  alt: 'Parcels on a conveyor "belt" & more',
  caption: null,
  slot: null,
};

describe("hero figure", () => {
  it("is the same function whichever module imports it", () => {
    expect(reExported).toBe(renderHeroFigure);
  });

  it("renders eagerly with the namespaced class and escaped attributes", () => {
    const html = renderHeroFigure(hero);
    expect(html.startsWith('<figure class="gtf-hero"><img src="https://storage.example.com/a/hero.png"')).toBe(true);
    expect(html).toContain('loading="eager"');
    expect(html).toContain("&quot;belt&quot; &amp; more");
    expect(renderFigure(hero)).not.toContain("gtf-hero");
  });

  it("declares width and height when the stored size is known", () => {
    const sized = { ...hero, width: 1600, height: 900 };
    expect(renderHeroFigure(sized)).toContain('width="1600" height="900" loading="eager" fetchpriority="high"');
    expect(renderFigure(sized)).toContain('width="1600" height="900" loading="lazy"');
  });

  it("declares no size for an image stored before sizes were measured", () => {
    // No guessed 16:9: a wrong box is worse than none.
    for (const html of [renderHeroFigure(hero), renderFigure(hero)]) {
      expect(html).not.toContain("width=");
      expect(html).not.toContain("height=");
    }
    for (const broken of [
      { ...hero, width: 1600 },
      { ...hero, width: 0, height: 900 },
      { ...hero, width: null, height: null },
      { ...hero, width: 1600.5, height: 900 },
    ]) {
      expect(renderFigure(broken)).not.toContain("width=");
    }
  });

  it("inline figures are lazy, the hero is not", () => {
    expect(renderFigure(hero)).toContain('loading="lazy"');
    expect(renderHeroFigure(hero)).not.toContain('loading="lazy"');
  });

  it("survives the Copy Markdown conversion as an image", () => {
    const article = {
      title: "How sorting works",
      bodyHtml: "<p>Intro.</p>",
    } as CanonicalArticle;
    const md = htmlToMarkdown(renderFullHtml(article, { afterTitle: renderHeroFigure(hero) }));
    expect(md.startsWith("# How sorting works")).toBe(true);
    expect(md).toContain('![Parcels on a conveyor "belt" & more](https://storage.example.com/a/hero.png)');
    expect(md.indexOf("![")).toBeLessThan(md.indexOf("Intro."));
  });
});
