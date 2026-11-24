import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The Content screen (`/content`) as it renders, and where the old Articles
 * and Keywords addresses go. Pinned: the calendar is the page, under the
 * Autopilot state and the links to the topics; a topic says where it came
 * from (an old one says it was not recorded, never a guess) and shows no
 * number; the notices appear only with something in them; every control is
 * 44px on a phone; the old addresses, All articles included, redirect with
 * their query string, so `?article=<id>` still opens that article.
 */

const nav = vi.hoisted(() => ({ to: null as string | null }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    nav.to = to;
    throw new Error("NEXT_REDIRECT");
  },
}));
// The board reads the articles itself: here it only has to be on the page.
vi.mock("@/components/dashboard/calendar-view", () => ({
  CalendarView: () => <div data-testid="calendar-view" />,
}));

import { ContentHeader, ContentTop, NextTopicsList, TopicLinks, TopicNotices } from "@/components/content/content-parts";
import ContentPage from "@/app/(app)/content/page";
import ContentArticlesPage from "@/app/(app)/content/articles/page";
import type { ContentView } from "@/lib/calendar/content";
import { IMAGE_STYLE_PATH, NO_IMAGE_STYLE_LINE } from "@/lib/media/settings";
import { articlePath, CONTENT_PATHS, withQuery } from "@/lib/content-paths";
import LegacyCalendarPage from "@/app/(app)/dashboard/calendar/page";
import LegacyKeywordsPage from "@/app/(app)/keywords/page";
import LegacyDashboardKeywordsPage from "@/app/(app)/dashboard/keywords/page";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const noop = () => {};

const VIEW: ContentView = {
  today: "2026-11-14",
  site: { name: "Acme", host: "acme.test" },
  autopilot: true,
  autopilotRun: { state: "stalled", message: "5 days of the next 14 have no article: no topic was left to schedule.", lastRun: null },
  imageStyle: { chosen: true, message: null, href: "/settings/automation#images" },
  todayArticle: null,
  week: [],
  nextTopics: [],
  topicsTotal: 12,
  topicsHeldBack: 0,
  overlapGroups: 2,
  questionsWaiting: null,
  articlesTotal: 41,
};

describe("the old addresses", () => {
  const go = async (page: (p: { searchParams: Promise<Record<string, string | string[] | undefined>> }) => Promise<void>, params: Record<string, string | string[] | undefined>) => {
    nav.to = null;
    await expect(page({ searchParams: Promise.resolve(params) })).rejects.toThrow("NEXT_REDIRECT");
    return nav.to;
  };

  it("send Articles to the calendar and Keywords to the topics, query string kept", async () => {
    expect(await go(LegacyCalendarPage, {})).toBe("/content");
    expect(await go(LegacyCalendarPage, { view: "list" })).toBe("/content?view=list");
    expect(await go(LegacyKeywordsPage, { search: "seo", tag: ["a", "b"] })).toBe("/content/topics?search=seo&tag=a&tag=b");
    expect(await go(LegacyDashboardKeywordsPage, { search: "ai seo" })).toBe("/content/topics?search=ai+seo");
  });

  it("send All articles to the calendar, keeping the article to open", async () => {
    expect(await go(ContentArticlesPage, {})).toBe("/content");
    expect(await go(ContentArticlesPage, { article: "art-1" })).toBe("/content?article=art-1");
    expect(await go(ContentArticlesPage, { article: "art-1", view: "list" })).toBe("/content?article=art-1&view=list");
    expect(await go(LegacyCalendarPage, { article: "art-1" })).toBe("/content?article=art-1");
  });

  it("link one article to the calendar with its modal open", () => {
    expect(articlePath("art-1")).toBe("/content?article=art-1");
    expect(articlePath("a b&c")).toBe("/content?article=a%20b%26c");
    expect(CONTENT_PATHS.home).toBe("/content");
  });

  it("builds the target with every value of the query, and nothing when there is none", () => {
    expect(withQuery("/content", undefined)).toBe("/content");
    expect(withQuery("/content", { a: undefined })).toBe("/content");
    expect(withQuery("/content", { q: "a&b" })).toBe("/content?q=a%26b");
  });
});

describe("the top line", () => {
  it("says whether Autopilot is on and links to its settings", () => {
    const on = renderToStaticMarkup(<ContentHeader view={{ autopilot: true, site: { name: "Acme", host: "acme.test" } }} />);
    expect(text(on)).toBe("Content One article a day for acme.test. Autopilot on");
    expect(on).toContain('href="/settings/automation"');
    const off = renderToStaticMarkup(<ContentHeader view={{ autopilot: false, site: { name: "Acme", host: "acme.test" } }} />);
    expect(text(off)).toBe("Content Autopilot off");
  });

  it("says what the last run did, and why it left days empty when it did", () => {
    const stalled = renderToStaticMarkup(
      <ContentHeader
        view={{
          autopilot: true,
          site: { name: "Acme", host: "acme.test" },
          autopilotRun: { state: "stalled", message: "5 days of the next 14 have no article: no topic was left to schedule.", lastRun: null },
        }}
      />
    );
    expect(text(stalled)).toContain("Autopilot: 5 days of the next 14 have no article: no topic was left to schedule.");
    expect(stalled).toContain('role="status"');
    const working = renderToStaticMarkup(
      <ContentHeader
        view={{ autopilot: true, site: { name: "Acme", host: "acme.test" }, autopilotRun: { state: "working", message: "Last run scheduled 1 article.", lastRun: null } }}
      />
    );
    expect(text(working)).toContain("Last run scheduled 1 article.");
    expect(working).not.toContain('role="status"');
  });

  it("says articles go out without images until the image style is chosen, with the link to choose it", () => {
    const waiting = renderToStaticMarkup(
      <ContentHeader
        view={{
          autopilot: true,
          site: { name: "Acme", host: "acme.test" },
          imageStyle: { chosen: false, message: NO_IMAGE_STYLE_LINE, href: IMAGE_STYLE_PATH },
        }}
      />
    );
    expect(waiting).toContain('data-testid="image-style-line"');
    expect(text(waiting)).toContain("Articles go out without images until you choose an image style.");
    expect(text(waiting)).toContain("Choose a style");
    expect(waiting).toContain('href="/settings/automation#images"');
    const chosen = renderToStaticMarkup(
      <ContentHeader view={{ autopilot: true, site: { name: "Acme", host: "acme.test" }, imageStyle: VIEW.imageStyle }} />
    );
    expect(chosen).not.toContain("image-style-line");
    expect(text(chosen)).not.toContain("without images");
  });
});

describe("the page", () => {
  it("is the calendar, under the title", () => {
    const html = renderToStaticMarkup(<ContentPage />);
    expect(html).toContain('data-testid="calendar-view"');
    expect(html.indexOf(">Content</h1>")).toBeGreaterThan(-1);
    expect(html.indexOf(">Content</h1>")).toBeLessThan(html.indexOf('data-testid="calendar-view"'));
    // Nothing of the old first view: no week strip, no today card, no board of its own.
    expect(html).not.toContain("This week");
    expect(html).not.toContain("All articles");
  });

  it("puts the Autopilot state, its last run and the way to the topics above the calendar", () => {
    const html = renderToStaticMarkup(<ContentTop view={VIEW} failed={false} onRetry={noop} />);
    const shown = text(html);
    expect(shown).toContain("Autopilot on");
    expect(shown).toContain("Autopilot: 5 days of the next 14 have no article: no topic was left to schedule.");
    expect(html).toContain('role="status"');
    expect(shown).toContain("Next topics · 12 to pick from");
    expect(html).toContain(`href="${CONTENT_PATHS.topics}"`);
    expect(shown).toContain("2 groups of topics overlap");
  });

  it("shows the title alone while loading, and a way to read again when it failed", () => {
    expect(text(renderToStaticMarkup(<ContentTop view={null} failed={false} onRetry={noop} />))).toBe("Content");
    const failed = renderToStaticMarkup(<ContentTop view={null} failed onRetry={noop} />);
    expect(failed).toContain('role="alert"');
    expect(text(failed)).toContain("Try again");
  });
});

describe("next topics", () => {
  const topics = [
    { id: "t1", keyword: "rfm analysis", source: "autopilot" as const, sourceUrl: null, starred: false, intent: "product_adjacent" as const },
    { id: "t2", keyword: "Is SMS marketing worth it?", source: "question" as const, sourceUrl: "https://www.reddit.com/r/shops/1/", starred: false, intent: "product_adjacent" as const },
    { id: "t3", keyword: "loyalty ideas", source: "manual" as const, sourceUrl: null, starred: false, intent: "product_adjacent" as const },
    { id: "t4", keyword: "web push", source: "unknown" as const, sourceUrl: null, starred: false, intent: "product_adjacent" as const },
    { id: "t5", keyword: "Klaviyo alternatives", source: "autopilot" as const, sourceUrl: null, starred: false, intent: "comparison" as const },
    { id: "t6", keyword: "why do my emails get no clicks", source: "manual" as const, sourceUrl: null, starred: false, intent: "problem" as const },
    { id: "t7", keyword: "how to connect Shopify to Klaviyo", source: "autopilot" as const, sourceUrl: null, starred: false, intent: "platform_howto" as const },
  ];
  const html = renderToStaticMarkup(<NextTopicsList topics={topics} total={12} onRemove={noop} />);

  it("says where each came from, and an old one that it was not recorded", () => {
    const shown = text(html);
    expect(shown).toContain("rfm analysis Autopilot");
    expect(shown).toContain("Is SMS marketing worth it? Asked in a public thread · reddit.com");
    expect(shown).toContain("loyalty ideas Added by you");
    expect(shown).toContain("web push Source not recorded");
  });

  it("tags each with the kind of search it answers, next to the source", () => {
    const shown = text(html);
    expect(shown).toContain("rfm analysis Autopilot Core topic");
    expect(shown).toContain("Klaviyo alternatives Autopilot Comparison");
    expect(shown).toContain("why do my emails get no clicks Added by you Problem");
    expect(shown).toContain("how to connect Shopify to Klaviyo Autopilot How-to");
  });

  it("shows no number for a topic: nothing about one is measured", () => {
    const rows = text(html).replace("All topics · 12 to pick from", "");
    expect(rows).not.toMatch(/\d/);
  });

  it("removes a topic from a 44px control, and links to every topic", () => {
    expect(html).toContain('aria-label="Remove rfm analysis"');
    expect(html).toContain("h-11 w-11");
    expect(html).toContain(`href="${CONTENT_PATHS.topics}"`);
    expect(text(renderToStaticMarkup(<NextTopicsList topics={[]} total={0} onRemove={noop} />))).toBe(
      "No topics to write about yet. All topics"
    );
  });
});

describe("the links to the topics", () => {
  it("appear only with something in them", () => {
    expect(renderToStaticMarkup(<TopicNotices view={{ overlapGroups: 0, questionsWaiting: null }} />)).toBe("");
    expect(renderToStaticMarkup(<TopicNotices view={{ overlapGroups: 0, questionsWaiting: 0 }} />)).toBe("");
    const both = renderToStaticMarkup(<TopicNotices view={{ overlapGroups: 2, questionsWaiting: 5 }} />);
    expect(text(both)).toBe("2 groups of topics overlap Questions people ask · 5");
    expect(both).toContain('href="/content/topics#overlapping-topics"');
    expect(both).toContain('href="/content/topics#questions-people-ask"');
    expect(text(renderToStaticMarkup(<TopicNotices view={{ overlapGroups: 1, questionsWaiting: null }} />))).toBe(
      "1 group of topics overlaps"
    );
  });

  it("always lead to every topic, with how many are left to pick from, 44px on a phone", () => {
    const html = renderToStaticMarkup(<TopicLinks view={{ topicsTotal: 0, overlapGroups: 0, questionsWaiting: null }} />);
    expect(text(html)).toBe("Next topics");
    expect(html).toContain(`href="${CONTENT_PATHS.topics}"`);
    expect(html).toContain("min-h-11");
    expect(text(renderToStaticMarkup(<TopicLinks view={{ topicsTotal: 7, overlapGroups: 0, questionsWaiting: 3 }} />))).toBe(
      "Next topics · 7 to pick from Questions people ask · 3"
    );
  });

});
