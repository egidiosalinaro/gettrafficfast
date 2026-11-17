import { describe, expect, it } from "vitest";
import { pickReadNext } from "@/lib/knowledge/read-next";

/**
 * Which published articles "Read next" lists (2026-11-15): related through
 * the graph first, a new path before a link the body already has, the
 * site's word-similar articles when the graph found too few, never the
 * article itself, never an unrelated one to fill the block.
 */

const live = (id: string, keyword: string, title = keyword) => ({
  articleId: id,
  title,
  keyword,
  publishedUrl: `https://crumb.example/blog/${id}`,
});

const source = { articleId: "new", keyword: "sourdough starter", title: "How to keep a sourdough starter alive" };

describe("Read next", () => {
  it("lists three related articles, closest first, the ones the body already links to last", () => {
    const related = [live("a", "sourdough hydration"), live("b", "sourdough scoring"), live("c", "sourdough flour"), live("d", "sourdough discard")];
    const picked = pickReadNext({ source, related, linkedInBody: ["https://crumb.example/blog/a"] });
    expect(picked.map((p) => p.articleId)).toEqual(["b", "c", "d"]);
    expect(picked[0]).toEqual({ articleId: "b", title: "sourdough scoring", href: "https://crumb.example/blog/b" });
  });

  it("goes back to an article the body links to when nothing else is related", () => {
    const related = [live("a", "sourdough hydration"), live("b", "sourdough scoring")];
    const picked = pickReadNext({ source, related, linkedInBody: ["https://crumb.example/blog/a"] });
    expect(picked.map((p) => p.articleId)).toEqual(["b", "a"]);
  });

  it("falls back on the site's word-similar articles, and never lists an unrelated one", () => {
    const others = [
      live("x", "croissant lamination"),
      live("y", "feeding a sourdough starter", "Feeding a sourdough starter: how often"),
      live("z", "best bread knives"),
      live("w", "sourdough starter smells like acetone"),
    ];
    const picked = pickReadNext({ source, related: [], others });
    expect(picked.map((p) => p.articleId)).toEqual(["y", "w"]);
  });

  it("never lists the article itself or the same page twice", () => {
    const twin = { ...live("b", "sourdough scoring"), publishedUrl: "https://crumb.example/blog/a" };
    const picked = pickReadNext({
      source,
      related: [live("new", "sourdough starter"), live("a", "sourdough hydration"), twin, live("a", "sourdough hydration")],
    });
    expect(picked.map((p) => p.articleId)).toEqual(["a"]);
  });

  it("is empty when the site has nothing related: no block", () => {
    expect(pickReadNext({ source, related: [], others: [live("z", "best bread knives")] })).toEqual([]);
  });
});
