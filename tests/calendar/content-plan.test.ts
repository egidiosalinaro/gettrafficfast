import { describe, expect, it } from "vitest";
import {
  contentArticle,
  contentStatus,
  contentStatusLabel,
  describeWeek,
  nextTopics,
  weekDays,
  type PlanArticle,
  type PoolTopic,
} from "@/lib/calendar/content-plan";
import { REASON_NOT_RECORDED } from "@/lib/content/hold-reasons";
import type { SiteTopics } from "@/lib/keywords/overlap";
import { topicSource } from "@/lib/keywords/source";

/**
 * What the Content screen and `get_content` say, as rules: a lifecycle state
 * in the screen's words, the week Monday to Sunday in UTC days, why a held
 * article waits (never an empty reason), and the topics in the order
 * Autopilot picks them, without the ones it refuses for overlapping.
 */

const article = (over: Partial<PlanArticle>): PlanArticle => ({
  id: "a",
  scheduledDate: "2026-11-14",
  status: "queued",
  title: null,
  keyword: "ai seo",
  publishedUrl: null,
  lastError: null,
  qualityReport: null,
  ...over,
});

describe("contentStatus", () => {
  it("words every lifecycle state, and never folds an unknown one into a known one", () => {
    expect(["queued", "generating", "generated", "needs_review", "published", "failed"].map(contentStatus)).toEqual([
      "scheduled",
      "writing",
      "written",
      "waiting",
      "published",
      "skipped",
    ]);
    expect(contentStatus("archived")).toBe("other");
    expect(contentStatusLabel("other", "needs_refresh")).toBe("Needs refresh");
    expect(contentStatusLabel("waiting", "needs_review")).toBe("Waiting");
  });
});

describe("contentArticle", () => {
  it("titles an article by what was written, else by its keyword, else says it has none", () => {
    expect(contentArticle(article({ title: "AI SEO, plainly" })).title).toBe("AI SEO, plainly");
    expect(contentArticle(article({ title: null })).title).toBe("ai seo");
    expect(contentArticle(article({ title: null, keyword: "" })).title).toBeNull();
  });

  it("says why a held article waits, from the reasons the hold recorded", () => {
    const held = contentArticle(
      article({ status: "needs_review", qualityReport: { blocking: [{ message: "A figure is not in Facts for articles." }] } })
    );
    expect(held).toMatchObject({ status: "waiting", reasons: ["A figure is not in Facts for articles."] });
    const fromError = contentArticle(article({ status: "needs_review", lastError: "Invented link | Wrong date" }));
    expect(fromError.reasons).toEqual(["Invented link", "Wrong date"]);
  });

  it("never leaves a waiting article without a reason: it says none was recorded", () => {
    expect(contentArticle(article({ status: "needs_review" })).reasons).toEqual([REASON_NOT_RECORDED]);
    // Only a waiting article carries reasons, only a skipped one its error.
    expect(contentArticle(article({ status: "published", lastError: "old" }))).toMatchObject({ reasons: [], lastError: null });
    expect(contentArticle(article({ status: "failed", lastError: "timed out" }))).toMatchObject({ status: "skipped", lastError: "timed out" });
  });
});

describe("the week", () => {
  it("runs Monday to Sunday around today, in UTC days, across a month end", () => {
    // 2026-11-14 is a Saturday.
    expect(weekDays("2026-11-14")).toEqual([
      "2026-11-09",
      "2026-11-10",
      "2026-11-11",
      "2026-11-12",
      "2026-11-13",
      "2026-11-14",
      "2026-11-15",
    ]);
    expect(weekDays("2026-11-09")[0]).toBe("2026-11-09");
    expect(weekDays("2026-11-15")[0]).toBe("2026-11-09");
    expect(weekDays("2026-12-01")).toEqual([
      "2026-11-30",
      "2026-12-01",
      "2026-12-02",
      "2026-12-03",
      "2026-12-04",
      "2026-12-05",
      "2026-12-06",
    ]);
  });

  it("gives every day a row, empty days included, and marks today", () => {
    const week = describeWeek(
      [
        article({ id: "mon", scheduledDate: "2026-11-09", status: "published", publishedUrl: "https://acme.test/a" }),
        article({ id: "sat", scheduledDate: "2026-11-14", status: "needs_review" }),
        article({ id: "next", scheduledDate: "2026-11-16" }),
      ],
      "2026-11-14"
    );
    expect(week.map((d) => [d.weekday, d.article?.id ?? null, d.isToday])).toEqual([
      ["Mon", "mon", false],
      ["Tue", null, false],
      ["Wed", null, false],
      ["Thu", null, false],
      ["Fri", null, false],
      ["Sat", "sat", true],
      ["Sun", null, false],
    ]);
  });
});

describe("nextTopics", () => {
  const topics: SiteTopics = {
    keywords: [
      { id: "kw-pub", keyword: "abandoned cart emails", status: "published", articleId: "art-pub", serpUrls: null },
      { id: "kw-dup", keyword: "abandoned cart email", status: "available", articleId: null, serpUrls: null },
      { id: "kw-high", keyword: "rfm analysis", status: "available", articleId: null, serpUrls: null },
      { id: "kw-old", keyword: "web push for shops", status: "available", articleId: null, serpUrls: null },
      { id: "kw-new", keyword: "loyalty points ideas", status: "available", articleId: null, serpUrls: null },
      { id: "kw-q", keyword: "Is email marketing dead?", status: "available", articleId: null, serpUrls: null },
    ],
    articles: [
      { id: "art-pub", keywordId: "kw-pub", status: "published", title: "Abandoned cart emails", publishedUrl: "https://acme.test/x", scheduledDate: "2026-11-01" },
    ],
  };
  const pool = (over: Partial<PoolTopic> & { id: string; keyword: string }): PoolTopic => ({
    opportunity: "Medium",
    difficulty: 50,
    searchVolume: null,
    source: null,
    sourceUrl: null,
    starred: false,
    createdAt: "2026-11-01T00:00:00.000Z",
    ...over,
  });
  const free = [
    pool({ id: "kw-new", keyword: "loyalty points ideas", createdAt: "2026-11-05T00:00:00.000Z", source: "manual" }),
    pool({ id: "kw-dup", keyword: "abandoned cart email", opportunity: "High", difficulty: 10, source: "autopilot" }),
    pool({ id: "kw-old", keyword: "web push for shops", createdAt: "2026-11-02T00:00:00.000Z" }),
    pool({ id: "kw-high", keyword: "rfm analysis", opportunity: "High", difficulty: 30, source: "autopilot" }),
    pool({
      id: "kw-q",
      keyword: "Is email marketing dead?",
      opportunity: null,
      difficulty: null,
      source: "question",
      sourceUrl: "https://www.reddit.com/r/emailmarketing/1",
    }),
  ];

  it("lists what Autopilot picks first, by its own score, oldest first on a tie", () => {
    const next = nextTopics({ pool: free, topics, limit: 10 });
    // A question has no figures: it scores like any keyword with none.
    expect(next.topics.map((t) => t.id)).toEqual(["kw-high", "kw-q", "kw-old", "kw-new"]);
    expect(next.total).toBe(4);
  });

  it("leaves out a topic Autopilot refuses for overlapping one already published, and counts it", () => {
    const next = nextTopics({ pool: free, topics, limit: 10 });
    expect(next.topics.map((t) => t.id)).not.toContain("kw-dup");
    expect(next.heldBack).toBe(1);
  });

  it("says where each came from, a thread only for a question, and nothing guessed for an old row", () => {
    const next = nextTopics({ pool: free, topics, limit: 10 });
    expect(next.topics.map((t) => [t.id, t.source, t.sourceUrl])).toEqual([
      ["kw-high", "autopilot", null],
      ["kw-q", "question", "https://www.reddit.com/r/emailmarketing/1"],
      ["kw-old", "unknown", null],
      ["kw-new", "manual", null],
    ]);
    expect(topicSource(undefined)).toBe("unknown");
    expect(topicSource("something new")).toBe("unknown");
  });

  it("lists at most limit, and still counts them all", () => {
    const next = nextTopics({ pool: free, topics, limit: 2 });
    expect(next.topics).toHaveLength(2);
    expect(next.total).toBe(4);
    expect(nextTopics({ pool: [], topics, limit: 5 })).toEqual({ topics: [], total: 0, heldBack: 0 });
  });
});
