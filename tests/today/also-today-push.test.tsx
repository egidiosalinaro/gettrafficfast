import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AlsoToday } from "@/components/today/also-today";
import { ArticleResults } from "@/components/results/article-results";
import { summarizeCitations, type ArticleResult } from "@/lib/lifecycle/results";
import { alsoTodayItems, pushItems } from "@/lib/today/also-today";

/**
 * Push page 3 on the screens (docs/LIFECYCLE.md): a proposal is an action in
 * Today's "Also today", opening the article; Growth's By article prints the
 * push's line under the keyword, and nothing for an article never pushed.
 */

describe("Today: a push to apply", () => {
  const proposal = { id: "p1", articleId: "a1", title: "Abandoned cart emails", mainQuery: "cart email subject lines", proposedLinks: 2, newTitle: true };

  it("is one card that opens the article, after held articles, resolved by resolve_article_push", () => {
    const items = alsoTodayItems({ articles: [], today: null, replies: [], staleFacts: [], now: 0, pushes: [proposal] });
    expect(items).toEqual([
      {
        kind: "article_push",
        id: "push:p1",
        pushId: "p1",
        articleId: "a1",
        title: "Abandoned cart emails",
        mainQuery: "cart email subject lines",
        links: 2,
        newTitle: true,
        href: "/content?article=a1",
        tools: ["resolve_article_push"],
      },
    ]);
    const html = renderToStaticMarkup(
      <AlsoToday items={items} now={0} busyIds={new Set()} onConfirmFact={async () => null} onSaveLink={async () => null} onDismissArticles={async () => null} />
    );
    expect(html).toContain("Push this article");
    expect(html).toContain("Add 2 links from your best pages and a new search title, for “cart email subject lines”.");
    expect(html).toContain('href="/content?article=a1"');
  });

  it("a proposal with nothing left to do is not a card", () => {
    expect(pushItems([{ ...proposal, proposedLinks: 0, newTitle: false }])).toEqual([]);
  });
});

describe("Growth: By article", () => {
  const result = (over: Partial<ArticleResult>): ArticleResult => ({
    articleId: "a1",
    keyword: "cart emails",
    publishedUrl: "https://acme.test/a1",
    rank: { current: 29, previous: null, delta: null, measuredOn: "2026-11-30", samples: 3 },
    rankSource: "search_console",
    traffic: { impressions: 100, clicks: 2, windowDays: 28 },
    citations: summarizeCitations([]),
    ...over,
  });

  it("prints the push's line under the keyword, on the card and in the table", () => {
    const html = renderToStaticMarkup(<ArticleResults articles={[result({ push: { line: "Pushed Nov 16: 37 → 29", status: "applied" } })]} connection="connected" />);
    expect(html.match(/Pushed Nov 16: 37 → 29/g)).toHaveLength(2);
  });

  it("prints nothing for an article never pushed", () => {
    const html = renderToStaticMarkup(<ArticleResults articles={[result({})]} connection="connected" />);
    expect(html).not.toContain("Pushed");
  });
});
