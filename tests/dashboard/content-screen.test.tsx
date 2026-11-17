import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The Content screen (`/content`) as it renders, and where the old Articles
 * and Keywords addresses go. Pinned: a held article says why and links to
 * Today; every day of the week has a row; a topic says where it came from
 * (an old one says it was not recorded, never a guess) and shows no number;
 * the notices appear only with something in them; every control is 44px on
 * a phone; the old addresses redirect with their query string.
 */

const nav = vi.hoisted(() => ({ to: null as string | null }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    nav.to = to;
    throw new Error("NEXT_REDIRECT");
  },
}));

import {
  AllArticlesLink,
  ContentHeader,
  NextTopicsList,
  TodayCard,
  TopicNotices,
  WeekList,
  todayLine,
} from "@/components/content/content-parts";
import { contentArticle, describeWeek, type PlanArticle } from "@/lib/calendar/content-plan";
import { CONTENT_PATHS, withQuery } from "@/lib/content-paths";
import LegacyCalendarPage from "@/app/(app)/dashboard/calendar/page";
import LegacyKeywordsPage from "@/app/(app)/keywords/page";
import LegacyDashboardKeywordsPage from "@/app/(app)/dashboard/keywords/page";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const noop = () => {};

const article = (over: Partial<PlanArticle>): PlanArticle => ({
  id: "art-1",
  scheduledDate: "2026-11-14",
  status: "queued",
  title: "How answer engines pick their sources",
  keyword: "answer engine sources",
  publishedUrl: null,
  lastError: null,
  qualityReport: null,
  ...over,
});

describe("the old addresses", () => {
  const go = async (page: (p: { searchParams: Promise<Record<string, string | string[] | undefined>> }) => Promise<void>, params: Record<string, string | string[] | undefined>) => {
    nav.to = null;
    await expect(page({ searchParams: Promise.resolve(params) })).rejects.toThrow("NEXT_REDIRECT");
    return nav.to;
  };

  it("send Articles to All articles and Keywords to the topics, query string kept", async () => {
    expect(await go(LegacyCalendarPage, {})).toBe("/content/articles");
    expect(await go(LegacyCalendarPage, { view: "list" })).toBe("/content/articles?view=list");
    expect(await go(LegacyKeywordsPage, { search: "seo", tag: ["a", "b"] })).toBe("/content/topics?search=seo&tag=a&tag=b");
    expect(await go(LegacyDashboardKeywordsPage, { search: "ai seo" })).toBe("/content/topics?search=ai+seo");
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
});

describe("today's article", () => {
  it("says why it waits, and links to Today, where it is dealt with", () => {
    const held = contentArticle(
      article({ status: "needs_review", qualityReport: { blocking: [{ message: "One figure is not in Facts for articles." }] } })
    );
    const html = renderToStaticMarkup(<TodayCard article={held} opening={null} onOpen={noop} />);
    expect(text(html)).toContain("How answer engines pick their sources");
    expect(text(html)).toContain("Waiting for you: One figure is not in Facts for articles.");
    expect(html).toContain('href="/today"');
    expect(text(html)).toContain("Fix it in Today");
  });

  it("links a published article to its live page, and says an empty day is empty", () => {
    const live = contentArticle(article({ status: "published", publishedUrl: "https://acme.test/blog/sources" }));
    const html = renderToStaticMarkup(<TodayCard article={live} opening={null} onOpen={noop} />);
    expect(html).toContain('href="https://acme.test/blog/sources"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(text(renderToStaticMarkup(<TodayCard article={null} opening={null} onOpen={noop} />))).toBe(
      "Today Nothing is scheduled today."
    );
  });

  it("words every state", () => {
    const line = (status: string, over: Partial<PlanArticle> = {}) => todayLine(contentArticle(article({ status, ...over })));
    expect(line("queued")).toBe("Scheduled");
    expect(line("generating")).toBe("Writing now");
    expect(line("generated")).toBe("Written, not on your site yet");
    expect(line("failed", { lastError: "timed out" })).toBe("Skipped: writing failed");
    expect(line("needs_review")).toBe("Waiting for you: The reason was not recorded.");
  });
});

describe("this week", () => {
  const week = describeWeek(
    [
      article({ id: "mon", scheduledDate: "2026-11-09", status: "published" }),
      article({ id: "fri", scheduledDate: "2026-11-13", status: "needs_review" }),
      article({ id: "sat", scheduledDate: "2026-11-14", status: "generating" }),
      article({ id: "sun", scheduledDate: "2026-11-15", status: "failed" }),
    ],
    "2026-11-14"
  );
  const html = renderToStaticMarkup(<WeekList week={week} opening={null} onOpen={noop} />);

  it("has a row a day, Monday first, with the status in words and empty days said", () => {
    expect((html.match(/<li/g) ?? []).length).toBe(7);
    const shown = text(html);
    expect(shown).toMatch(/^This week Mon .+ Published Tue No article Wed No article Thu No article Fri .+ Waiting Sat .+ Writing Sun .+ Skipped$/);
  });

  it("opens an article from its row, a 56px target, and marks today", () => {
    expect((html.match(/<button/g) ?? []).length).toBe(4);
    expect(html).toContain("min-h-14");
    expect(html).toContain('aria-current="date"');
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

describe("the notices and the board link", () => {
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

  it("counts every article on the way to the board", () => {
    const html = renderToStaticMarkup(<AllArticlesLink total={41} />);
    expect(text(html)).toBe("All articles · 41");
    expect(html).toContain('href="/content/articles"');
  });
});
