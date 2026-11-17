import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FakeSupabase } from "../support/fake-supabase";

/**
 * "Questions people ask" end to end on the Keywords screen: GET
 * /api/keywords/questions answers the selected site's ideas, POST
 * /api/keywords/save stores one with every research figure null and the
 * thread that asks it, and the page shows "Asked in a public thread" where
 * the numbers would be. Also the migration, read as text.
 */

const m = vi.hoisted(() => ({
  db: null as unknown as FakeSupabase,
  user: { id: "user-1" } as { id: string } | null,
  businessId: "biz-1" as string | null,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => m.db.from(table),
    auth: { getUser: async () => ({ data: { user: m.user } }) },
  }),
}));
vi.mock("@/lib/tenancy", () => ({
  NO_BUSINESS_RESPONSE: { error: "No site set up yet. Add your business first.", code: "no_business" },
  selectedBusinessId: async () => m.businessId,
}));

import { GET as getQuestions } from "@/app/api/keywords/questions/route";
import { POST as saveKeywords } from "@/app/api/keywords/save/route";
import { AskedInPublicThread, QuestionIdeasList } from "@/components/keywords/question-ideas";
import type { QuestionIdea } from "@/lib/keywords/questions";

const REDDIT = "https://www.reddit.com/r/SEO/comments/1abc/is_programmatic_seo_dead/";
const QUORA = "https://www.quora.com/How-do-AI-Overviews-impact-organic-traffic";
const OTHER_SITE = "https://www.reddit.com/r/SEO/comments/9zzz/other_site/";

const target = (over: Record<string, unknown>) => ({
  user_id: "user-1",
  business_id: "biz-1",
  surface: "reddit",
  kind: "thread",
  community: "r/SEO",
  status: "qualified",
  qualified_by: "agent",
  qualify_score: 80,
  intent: "question",
  posted_at: "2026-11-01T00:00:00.000Z",
  created_at: "2026-11-02T00:00:00.000Z",
  ...over,
});

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  m.user = { id: "user-1" };
  m.businessId = "biz-1";
  m.db = new FakeSupabase({
    placement_targets: [
      target({ id: "t-1", url: REDDIT, title: "Is programmatic SEO dead in 2026? : r/SEO" }),
      target({ id: "t-2", url: QUORA, title: "How do AI Overviews impact organic traffic? - Quora", surface: "quora", community: null, posted_at: "2026-10-01T00:00:00.000Z" }),
      target({ id: "t-3", url: "https://www.reddit.com/r/SEO/comments/2/", title: "What is the best AI SEO checklist?" }),
      target({ id: "t-4", url: "https://www.reddit.com/r/SEO/comments/3/", title: "How do I rank for AEO queries quickly?" }),
      target({ id: "t-5", url: "https://www.reddit.com/r/beds/comments/4/", title: "Which mattress is best for back pain?", status: "rejected", qualified_by: "rules:no_overlap", qualify_score: 0 }),
      // The same user's other site.
      target({ id: "t-9", business_id: "biz-2", url: OTHER_SITE, title: "Should a florist start a newsletter?" }),
    ],
    keywords: [
      { id: "kw-1", user_id: "user-1", business_id: "biz-1", keyword: "ai seo checklist", status: "available" },
      { id: "kw-9", user_id: "user-1", business_id: "biz-2", keyword: "programmatic seo dead 2026", status: "available" },
    ],
    articles: [{ id: "a-1", user_id: "user-1", business_id: "biz-1", title: "How to rank for AEO queries quickly" }],
  });
});

const save = (keywords: unknown) =>
  saveKeywords(
    new Request("https://gettrafficfa.st/api/keywords/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keywords }),
    }) as never
  );
const stored = (keyword: string) => m.db.tables.keywords.find((k) => k.keyword === keyword);

describe("GET /api/keywords/questions", () => {
  it("answers the selected site's uncovered questions with their thread, and no figure of any kind", async () => {
    const res = await getQuestions();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      questions: [
        {
          question: "Is programmatic SEO dead in 2026?",
          threadCount: 1,
          sourceUrl: REDDIT,
          host: "reddit.com",
          surface: "reddit",
          community: "r/SEO",
          postedAt: "2026-11-01T00:00:00.000Z",
        },
        {
          question: "How do AI Overviews impact organic traffic?",
          threadCount: 1,
          sourceUrl: QUORA,
          host: "quora.com",
          surface: "quora",
          community: null,
          postedAt: "2026-10-01T00:00:00.000Z",
        },
      ],
    });
  });

  it("is empty without a site or without threads, 401 signed out", async () => {
    m.businessId = null;
    expect(await (await getQuestions()).json()).toEqual({ questions: [] });
    m.businessId = "biz-3";
    expect(await (await getQuestions()).json()).toEqual({ questions: [] });
    m.user = null;
    expect((await getQuestions()).status).toBe(401);
  });

  it("calls no model and writes nothing: three reads of the site's rows", async () => {
    const before = JSON.stringify(m.db.tables);
    await getQuestions();
    expect(JSON.stringify(m.db.tables)).toBe(before);
    expect([...m.db.calls].sort()).toEqual(["select:articles", "select:keywords", "select:placement_targets"]);
  });
});

describe("adding a question as a keyword", () => {
  it("stores it with volume, difficulty, CPC, competition and opportunity null, and its thread", async () => {
    const res = await save([{ keyword: "Is programmatic SEO dead in 2026?", source: "question", sourceUrl: REDDIT }]);
    expect(res.status).toBe(200);
    const row = stored("Is programmatic SEO dead in 2026?");
    expect(row).toMatchObject({
      user_id: "user-1",
      business_id: "biz-1",
      status: "available",
      is_starred: false,
      source: "question",
      source_url: REDDIT,
    });
    // Null, not zero and not the defaults a suggestion gets (Medium, 50).
    for (const column of ["search_volume", "difficulty", "cpc", "competition", "opportunity"]) {
      expect(row?.[column], column).toBeNull();
    }
    // Once it is a keyword it is covered: not offered again.
    const { questions } = await (await getQuestions()).json();
    expect(questions.map((q: QuestionIdea) => q.question)).toEqual(["How do AI Overviews impact organic traffic?"]);
  });

  it("does not store figures sent along with a question", async () => {
    await save([
      { keyword: "How do AI Overviews impact organic traffic?", source: "question", sourceUrl: QUORA, searchVolume: 5400, difficulty: 35, cpc: 2.1, competition: "Low", opportunity: "High" },
    ]);
    expect(stored("How do AI Overviews impact organic traffic?")).toMatchObject({
      search_volume: null,
      difficulty: null,
      cpc: null,
      competition: null,
      opportunity: null,
      source: "question",
    });
  });

  it("refuses a question whose thread is not one found for this site, and saves nothing", async () => {
    for (const sourceUrl of [OTHER_SITE, "https://example.com/never-found", "javascript:alert(1)", "", undefined]) {
      const res = await save([{ keyword: "Is programmatic SEO dead in 2026?", source: "question", sourceUrl }]);
      expect(res.status, String(sourceUrl)).toBe(400);
      expect((await res.json()).error).toMatch(/thread found for this site/);
    }
    expect(m.db.tables.keywords).toHaveLength(2);
  });

  it("keeps an ordinary add's estimates and records that a person added it", async () => {
    await save([{ keyword: "geo for saas", searchVolume: 1200, difficulty: 30, competition: "High", opportunity: "High" }]);
    const row = stored("geo for saas");
    expect(row).toMatchObject({ search_volume: 1200, difficulty: 30, competition: "High", opportunity: "High" });
    // The Content screen says "Added by you" from this (lib/keywords/source.ts).
    expect(row).toMatchObject({ source: "manual", source_url: null });
    expect(m.db.calls).not.toContain("select:placement_targets");
  });

  it("stores a question and a typed keyword in one batch, each as what it is", async () => {
    await save([{ keyword: "Is programmatic SEO dead in 2026?", source: "question", sourceUrl: REDDIT }, { keyword: "geo for saas" }]);
    expect(stored("Is programmatic SEO dead in 2026?")).toMatchObject({ source: "question", difficulty: null });
    expect(stored("geo for saas")).toMatchObject({ source: "manual", source_url: null, difficulty: 50 });
  });
});

describe("what the Keywords screen shows", () => {
  const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const idea: QuestionIdea = {
    question: "Is programmatic SEO dead in 2026?",
    threadCount: 3,
    sourceUrl: REDDIT,
    host: "reddit.com",
    surface: "reddit",
    community: "r/SEO",
    postedAt: null,
  };
  const list = (ideas: QuestionIdea[], selected: string[] = []) =>
    renderToStaticMarkup(
      <QuestionIdeasList ideas={ideas} selected={new Set(selected)} adding={new Set()} onToggle={() => {}} onAdd={() => {}} />
    );

  it("says a keyword from a question was asked in a public thread, linked to it, with no number", () => {
    const html = renderToStaticMarkup(<AskedInPublicThread sourceUrl={REDDIT} />);
    expect(text(html)).toBe("Asked in a public thread · reddit.com");
    expect(html).toContain(`href="${REDDIT}"`);
    expect(html).toContain('rel="noopener noreferrer"');
    expect(text(html)).not.toMatch(/\d/);
    // A link that is not a web address is never rendered as one.
    const unsafe = renderToStaticMarkup(<AskedInPublicThread sourceUrl="javascript:alert(1)" />);
    expect(text(unsafe)).toBe("Asked in a public thread");
    expect(unsafe).not.toContain("href");
    expect(text(renderToStaticMarkup(<AskedInPublicThread sourceUrl={null} />))).toBe("Asked in a public thread");
  });

  it("uses it in the keywords table in place of the four estimate cells", () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const page = readFileSync(path.join(root, "app/(app)/content/topics/page.tsx"), "utf8");
    expect(page).toMatch(/keyword\.source === QUESTION_SOURCE \? \([\s\S]{0,400}colSpan=\{4\}[\s\S]{0,120}<AskedInPublicThread/);
  });

  it("lists each question with its host, a link to the thread, an Add button and Add selected", () => {
    const html = list([idea, { ...idea, question: "How do AI Overviews impact organic traffic?", sourceUrl: QUORA, host: "quora.com", threadCount: 1 }], [QUORA]);
    const shown = text(html);
    expect(shown).toContain("Is programmatic SEO dead in 2026?");
    expect(shown).toContain("Asked in a public thread · reddit.com");
    expect(shown).toContain("asked in 3 threads we found");
    expect(shown).toContain("Asked in a public thread · quora.com");
    expect(shown).toContain("Add selected (1)");
    expect(html).toContain(`href="${REDDIT}"`);
    expect(html).toContain('aria-label="Add Is programmatic SEO dead in 2026?"');
    // 44px targets on a phone, and a list rather than a table: nothing to overflow.
    expect(html).toContain("min-h-[44px]");
    expect(html).toContain("h-11 w-11");
    expect(html).not.toContain("<table");
    expect(html).toContain("break-words");
  });

  it("says where questions come from when there are none", () => {
    const html = list([]);
    expect(text(html)).toBe("No questions found yet. Run discovery in Today to find conversations.");
    expect(html).toContain('href="/today"');
  });
});

describe("20261110171500_keyword_source.sql", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const sql = readFileSync(path.join(root, "supabase/migrations/20261110171500_keyword_source.sql"), "utf8");
  const code = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .replace(/\s+/g, " ");

  it("adds the two nullable columns, and only adds", () => {
    expect(code).toContain("alter table public.keywords add column if not exists source text, add column if not exists source_url text;");
    expect(code).not.toMatch(/not null|default/i);
  });

  it("holds no statement that would stop the automatic apply for a confirmation", () => {
    expect(code).not.toMatch(/\b(drop|truncate|delete|update)\b/i);
  });
});
