import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EngineCitationsCell } from "@/components/results/engine-citations";
import { ArticleResults } from "@/components/results/article-results";
import { RANK_SOURCE_LABEL, summarizeCitations, type ArticleResult } from "@/lib/lifecycle/results";

/**
 * The Results table and tiles: citation rates per engine, readable without a
 * pointer, an unprobed article as words, and no second copy of the shared
 * tiles living inside the page.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = (relativePath: string) => readFileSync(path.join(root, relativePath), "utf8");

describe("EngineCitationsCell", () => {
  it("shows each engine's rate in the cell, not in a hover title", () => {
    const probes = (engine: string, cited: number, total: number) =>
      Array.from({ length: total }, (_, i) => ({ checkedOn: "2026-11-01", engine, cited: i < cited }));
    const citations = summarizeCitations([...probes("gemini", 6, 12), ...probes("perplexity", 0, 10)]);
    const html = renderToStaticMarkup(<EngineCitationsCell citations={citations} />);
    expect(html).toContain("Gemini");
    expect(html).toContain("50%");
    expect(html).toContain("(6/12)");
    expect(html).toContain("Perplexity");
    expect(html).toContain("0%");
    expect(html).toContain("(0/10)");
    expect(html).not.toContain("title=");
    // The pooled 27% over both engines is not a number this cell prints.
    expect(html).not.toContain("27%");
  });

  it("shows a count, not a percent, under 10 probes on an engine", () => {
    const citations = summarizeCitations([
      { checkedOn: "2026-11-01", engine: "gemini", cited: true },
      { checkedOn: "2026-11-01", engine: "gemini", cited: false },
      { checkedOn: "2026-11-02", engine: "perplexity", cited: false },
      { checkedOn: "2026-11-03", engine: "perplexity", cited: false },
      { checkedOn: "2026-11-04", engine: "perplexity", cited: false },
    ]);
    const html = renderToStaticMarkup(<EngineCitationsCell citations={citations} />);
    expect(html).toContain("1 of 2");
    expect(html).toContain("0 of 3");
    expect(html).not.toContain("%");
    expect(html).not.toContain("(0/3)");
  });

  it("reads an article nobody probed as not probed, never 0%", () => {
    const html = renderToStaticMarkup(<EngineCitationsCell citations={summarizeCitations([])} />);
    expect(html).toContain("not probed yet");
    expect(html).not.toContain("0%");
  });
});

describe("Growth, where Results lives since 2026-11-14", () => {
  const page = source("components/growth/growth-view.tsx");

  it("uses the shared pieces instead of its own copies", () => {
    expect(page).not.toMatch(/function StatTile|function NotMeasured|function percent/);
    expect(page).toMatch(/from "@\/components\/visibility\/primitives"/);
    expect(page).toContain("formatRate(");
  });

  it("shows no citation rate for every engine together", () => {
    expect(page).not.toContain("AI citation rate");
    expect(page).not.toContain("citationRate");
  });

  it("names the position source instead of printing gsc", () => {
    expect(RANK_SOURCE_LABEL.search_console).toBe("Search Console");
    expect(page).not.toMatch(/>\s*gsc\s*</);
  });

  it("draws the articles from one component, and its positions through the shared formatter", () => {
    expect(page).toContain("<ArticleResults");
    expect(page).toContain("formatPosition(current.averagePosition)");
    expect(page).not.toMatch(/toFixed\(|<table/);
    const list = source("components/results/article-results.tsx");
    // A position or a change printed as is, without the formatter.
    expect(list).not.toMatch(/toFixed\(|>\s*\{article\.rank\.(current|delta)\}|\{Math\.abs\(delta\)\}/);
    expect(list).toContain("formatPosition(article.rank.current)");
    expect(list).toContain("positionChange(delta)");
  });
});

/** The owner's phone, 2026-11-13, in data: what the Results list was given. */
function result(over: Partial<ArticleResult> & Pick<ArticleResult, "articleId" | "keyword">): ArticleResult {
  return {
    publishedUrl: `https://acme.test/blog/${over.articleId}`,
    rank: { current: null, previous: null, delta: null, measuredOn: null, samples: 0 },
    rankSource: null,
    traffic: { impressions: null, clicks: null, windowDays: 28 },
    citations: summarizeCitations([]),
    ...over,
  };
}

const fewProbes = summarizeCitations([
  { checkedOn: "2026-11-10", engine: "gemini", cited: false },
  { checkedOn: "2026-11-10", engine: "gemini", cited: false },
  { checkedOn: "2026-11-10", engine: "gemini", cited: false },
]);

const screenshot: ArticleResult[] = [
  result({
    articleId: "one",
    keyword: "how to get cited by ai answer engines for a saas product",
    // Unrounded on purpose: a payload from before the lifecycle rounded.
    rank: { current: 51.75, previous: 66.8, delta: 15.049999999999997, measuredOn: "2026-11-10", samples: 9 },
    rankSource: "search_console",
    traffic: { impressions: 312, clicks: 0, windowDays: 28 },
    citations: fewProbes,
  }),
  result({
    articleId: "two",
    keyword: "aeo vs seo",
    rank: { current: 37.33, previous: 23.66, delta: -13.670000000000002, measuredOn: "2026-11-10", samples: 9 },
    rankSource: "search_console",
    traffic: { impressions: 80, clicks: 2, windowDays: 28 },
    citations: fewProbes,
  }),
  result({
    articleId: "three",
    keyword: "content operating system",
    rank: { current: 60.5, previous: 58.53, delta: -1.9700000000000006, measuredOn: "2026-11-10", samples: 9 },
    rankSource: "search_console",
    traffic: { impressions: 15, clicks: 0, windowDays: 28 },
  }),
];

describe("ArticleResults", () => {
  it("prints positions and changes to one decimal at most", () => {
    const html = renderToStaticMarkup(<ArticleResults articles={screenshot} connection="connected" />);
    for (const shown of ["51.8", "37.3", "60.5", ">15<", ">13.7<", ">2<"]) expect(html).toContain(shown);
    for (const raw of ["51.75", "37.33", "15.04", "13.67", "1.97"]) expect(html).not.toContain(raw);
  });

  it("says the rank source once when every row shares it", () => {
    const html = renderToStaticMarkup(<ArticleResults articles={screenshot} connection="connected" />);
    expect(html.match(/Search Console/g)).toHaveLength(1);
    expect(html).toContain("Positions are Google&#x27;s average from Search Console.");
    expect(html).not.toMatch(/\bgsc\b/);
  });

  it("marks only the rows from the other source when they mix", () => {
    const mixed = [
      ...screenshot,
      result({
        articleId: "four",
        keyword: "serp only",
        rank: { current: 8, previous: null, delta: null, measuredOn: "2026-11-04", samples: 1 },
        rankSource: "serp",
      }),
    ];
    const html = renderToStaticMarkup(<ArticleResults articles={mixed} connection="connected" />);
    // Once in the card and once in the table row of the one exception, once in the note.
    expect(html.match(/SERP snapshot/g)).toHaveLength(3);
    expect(html.match(/Search Console/g)).toHaveLength(1);
  });

  it("is a card per article below md and the table from md up, with the same honest words", () => {
    const html = renderToStaticMarkup(
      <ArticleResults
        articles={[...screenshot, result({ articleId: "new", keyword: "never measured" })]}
        connection="connected"
      />
    );
    expect(html).toMatch(/<ul class="[^"]*md:hidden/);
    expect(html).toMatch(/<div class="hidden [^"]*md:block/);
    // Each article appears in both layouts.
    expect(html.match(/how to get cited by ai answer engines/g)).toHaveLength(2);
    expect(html).toContain("not measured yet");
    expect(html).toContain(">never<");
    expect(html).toContain("0 of 3");
    expect(html).not.toContain(">0%<");
    // The open-article link is a 44px target on the phone.
    expect(html).toMatch(/class="[^"]*h-11 w-11[^"]*"[^>]*aria-label="Open the published article"/);
  });

  it("keeps not ranking apart from never measured, and says not connected without Search Console", () => {
    const html = renderToStaticMarkup(
      <ArticleResults
        articles={[
          result({
            articleId: "gone",
            keyword: "dropped out",
            rank: { current: null, previous: 40, delta: null, measuredOn: "2026-11-10", samples: 4 },
            rankSource: "serp",
          }),
        ]}
        connection="absent"
      />
    );
    expect(html).toContain("not ranking");
    expect(html).toContain("not connected");
    expect(html).not.toContain("not measured yet");
  });
});
