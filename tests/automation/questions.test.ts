import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "../support/fake-supabase";
import { MAX_QUESTIONS_PER_DAY, questionsToAdd } from "@/lib/automation/autopilot";
import { addAskedQuestions } from "@/lib/automation/questions";
import type { SiteTopics } from "@/lib/keywords/overlap";

/**
 * Autopilot adds "Questions people ask" to the pool on its own: at most 3 a
 * site a UTC day, counting every question added that day; never one that
 * overlaps a keyword the site has, a published article or an earlier idea;
 * stored as asked in a public thread, with no figure. Free: no model, no
 * provider, only the site's own rows.
 */

const topics = (keywords: string[], published: string[] = []): SiteTopics => ({
  keywords: keywords.map((keyword, i) => ({ id: `kw-${i}`, keyword, status: "available", articleId: null, serpUrls: null })),
  articles: published.map((title, i) => ({
    id: `art-${i}`,
    keywordId: null,
    status: "published",
    title,
    publishedUrl: `https://acme.test/${i}`,
    scheduledDate: "2026-11-01",
  })),
});

describe("questionsToAdd", () => {
  const ideas = [
    { question: "Is programmatic SEO dead in 2026?" },
    { question: "How do I warm up a new domain for email deliverability?" },
    { question: "Which CRM works best for a two person agency?" },
    { question: "What is the best headless CMS for a small blog?" },
  ];

  it("takes the ideas in their order, up to what is left of today's cap", () => {
    expect(MAX_QUESTIONS_PER_DAY).toBe(3);
    expect(questionsToAdd({ topics: topics([]), ideas, addedToday: 0 }).map((i) => i.question)).toEqual(
      ideas.slice(0, 3).map((i) => i.question)
    );
    expect(questionsToAdd({ topics: topics([]), ideas, addedToday: 2 })).toHaveLength(1);
    expect(questionsToAdd({ topics: topics([]), ideas, addedToday: 3 })).toEqual([]);
    expect(questionsToAdd({ topics: topics([]), ideas, addedToday: 7 })).toEqual([]);
  });

  it("skips one the site has, or that overlaps a keyword, a published article or an earlier idea", () => {
    const chosen = questionsToAdd({
      topics: topics(["is programmatic seo dead in 2026?", "crm best two person agency"], ["The best headless CMS for a small blog"]),
      ideas: [...ideas, { question: "How to warm up a new domain for email deliverability?" }, { question: "Do newsletters still work?" }],
      addedToday: 0,
    });
    expect(chosen.map((i) => i.question)).toEqual([
      "How do I warm up a new domain for email deliverability?",
      "Do newsletters still work?",
    ]);
  });
});

const REDDIT = "https://www.reddit.com/r/SEO/comments/1/";
const QUORA = "https://www.quora.com/How-do-AI-Overviews-impact-organic-traffic";
const thread = (id: string, url: string, title: string, over: Record<string, unknown> = {}) => ({
  id,
  user_id: "user-1",
  business_id: "biz-1",
  url,
  title,
  surface: "reddit",
  kind: "thread",
  community: null,
  status: "qualified",
  qualified_by: "agent",
  qualify_score: 80,
  intent: "question",
  posted_at: "2026-11-01T00:00:00.000Z",
  created_at: "2026-11-02T00:00:00.000Z",
  ...over,
});

let db: FakeSupabase;
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  db = new FakeSupabase({
    placement_targets: [
      thread("t-1", REDDIT, "Is programmatic SEO dead in 2026? : r/SEO"),
      thread("t-2", QUORA, "How do AI Overviews impact organic traffic? - Quora", { surface: "quora" }),
      thread("t-3", "https://www.reddit.com/r/SEO/comments/2/", "What is the best AI SEO checklist?"),
      thread("t-4", "https://www.reddit.com/r/SEO/comments/3/", "How do I rank for AEO queries quickly?"),
      thread("t-5", "https://www.reddit.com/r/SEO/comments/4/", "Which schema markup matters for answer engines?"),
      // Another site's thread never reaches this one.
      thread("t-9", "https://www.reddit.com/r/x/9/", "Should a florist start a newsletter?", { business_id: "biz-2" }),
    ],
    keywords: [{ id: "kw-1", user_id: "user-1", business_id: "biz-1", keyword: "ai seo checklist", status: "available", source: "manual" }],
    articles: [],
  });
});

const NOW = new Date("2026-11-14T06:00:00.000Z");
const run = () => addAskedQuestions({ supabase: db as never, userId: "user-1", businessId: "biz-1", now: NOW });
const added = () => db.tables.keywords.filter((k) => k.source === "question");

describe("addAskedQuestions", () => {
  it("adds up to 3 questions, stored as asked in a thread with every figure null", async () => {
    const result = await run();
    expect(result.added).toHaveLength(3);
    expect(result.addedBefore).toBe(0);
    for (const row of added()) {
      expect(row).toMatchObject({
        user_id: "user-1",
        business_id: "biz-1",
        status: "available",
        search_volume: null,
        difficulty: null,
        cpc: null,
        competition: null,
        opportunity: null,
      });
      expect(typeof row.source_url).toBe("string");
    }
    // The one a keyword already covers is not among them; another site's never is.
    expect(added().map((k) => k.keyword)).not.toContain("What is the best AI SEO checklist?");
    expect(added().map((k) => k.keyword)).not.toContain("Should a florist start a newsletter?");
  });

  it("adds nothing more on a second run the same day", async () => {
    await run();
    // The database stamps created_at; the fake does not.
    for (const row of added()) row.created_at = "2026-11-14T06:00:01.000Z";
    const again = await run();
    expect(again).toEqual({ added: [], addedBefore: 3 });
    expect(added()).toHaveLength(3);
  });

  it("counts the questions a person added today against the cap", async () => {
    db.tables.keywords.push(
      { id: "kw-p1", user_id: "user-1", business_id: "biz-1", keyword: "Q one", source: "question", created_at: "2026-11-14T05:00:00.000Z" },
      { id: "kw-p2", user_id: "user-1", business_id: "biz-1", keyword: "Q two", source: "question", created_at: "2026-11-14T05:30:00.000Z" },
      // Yesterday's does not count.
      { id: "kw-p3", user_id: "user-1", business_id: "biz-1", keyword: "Q three", source: "question", created_at: "2026-11-13T23:00:00.000Z" }
    );
    const result = await run();
    expect(result).toMatchObject({ addedBefore: 2 });
    expect(result.added).toHaveLength(1);
  });

  it("calls no model and no provider: it reads and writes the site's own rows only", async () => {
    await run();
    const allowed = new Set(["articles", "keywords", "placement_targets", "serp_snapshots"]);
    expect(db.calls.map((call) => call.split(":")[1]).filter((table) => !allowed.has(table))).toEqual([]);
    expect(db.calls.filter((call) => call.startsWith("insert:"))).toEqual(["insert:keywords"]);
  });

  it("adds nothing when discovery has found no question", async () => {
    db.tables.placement_targets = [];
    expect(await run()).toEqual({ added: [], addedBefore: 0 });
    expect(db.calls).not.toContain("insert:keywords");
  });
});
