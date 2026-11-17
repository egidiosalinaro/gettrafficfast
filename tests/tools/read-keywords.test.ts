import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeSupabase } from "../support/fake-supabase";
import { apiCaller } from "./support";
import { A, B, KW_A1, KW_A2, KW_A3, KW_A4, readSeed } from "./read-support";

/**
 * The keyword pool tools, as an API-key caller on site A with the read
 * scope only: the screen's search, filters, sort and pages, and the best
 * picks by the screen's own rule. Site B's pool never shows.
 */

const m = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => m.db }));

import { runTool } from "@/lib/tools/runner";
import { TOOLS } from "@/lib/tools/registry";

let db: FakeSupabase;
beforeEach(() => {
  db = readSeed();
  m.db = db;
});

const call = (name: string, input: unknown = {}) => runTool(apiCaller(db, { scopes: ["read"] }), name, input);
const ids = (run: Awaited<ReturnType<typeof call>>) =>
  run.ok ? (run.output.keywords as Array<{ id: string }>).map((k) => k.id) : run;

describe("list_keywords", () => {
  it("lists the site's pool newest first, each with its article's link and the estimates labelled", async () => {
    const run = await call("list_keywords");
    expect(ids(run)).toEqual([KW_A4, KW_A3, KW_A2, KW_A1]);
    if (!run.ok) return;
    expect((run.output.keywords as Array<Record<string, unknown>>)[3]).toEqual({
      id: KW_A1,
      keyword: "ai seo",
      searchVolume: 900,
      competition: "Medium",
      difficulty: 40,
      cpc: 2.5,
      opportunity: "High",
      status: "published",
      starred: true,
      articleId: expect.any(String),
      publishedUrl: "https://acme.test/ai-seo",
      bestPick: false,
      source: null,
      sourceUrl: null,
      intent: "product_adjacent",
      createdAt: "2026-10-01T00:00:00.000Z",
    });
    expect(run.output).toMatchObject({ total: 4, nextCursor: null });
    expect(run.output.estimatesNote).toMatch(/estimates, not measured/);
  });

  it("searches, filters by status and star, and sorts like the table", async () => {
    expect(ids(await call("list_keywords", { search: "SEO" }))).toEqual([KW_A4, KW_A3, KW_A1]);
    expect(ids(await call("list_keywords", { status: "available" }))).toEqual([KW_A4, KW_A3]);
    expect(ids(await call("list_keywords", { starred: true }))).toEqual([KW_A4, KW_A1]);
    expect(ids(await call("list_keywords", { sort: "search_volume" }))).toEqual([KW_A4, KW_A1, KW_A3, KW_A2]);
    expect(ids(await call("list_keywords", { sort: "cpc", direction: "asc" }))).toEqual([KW_A3, KW_A1, KW_A4, KW_A2]);
    expect(ids(await call("list_keywords", { direction: "asc" }))).toEqual([KW_A1, KW_A2, KW_A3, KW_A4]);
  });

  it("pages with a cursor", async () => {
    const first = await call("list_keywords", { limit: 3 });
    expect(ids(first)).toEqual([KW_A4, KW_A3, KW_A2]);
    expect(first.ok && first.output.nextCursor).toBe("3");
    const second = await call("list_keywords", { limit: 3, cursor: "3" });
    expect(ids(second)).toEqual([KW_A1]);
    expect(second.ok && second.output.nextCursor).toBeNull();
    expect(await call("list_keywords", { cursor: "abc" })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });
});

describe("recommend_keywords", () => {
  it("answers the best picks by the Keywords screen's rule, never a keyword already on the calendar", async () => {
    const run = await call("recommend_keywords");
    // KW_A1 and KW_A2 are on the calendar; KW_A4 is too hard (85); site B's pick never shows.
    expect(ids(run)).toEqual([KW_A3]);
    expect(run.ok && run.output).toMatchObject({ total: 1, rule: expect.stringContaining("difficulty 60 or less") });
    expect(run.ok && (run.output.keywords as Array<{ bestPick: boolean }>)[0].bestPick).toBe(true);
  });
});

describe("list_question_ideas", () => {
  const thread = (n: number, title: string, over: Record<string, unknown> = {}) => ({
    id: `q-thread-${n}`,
    ...A,
    surface: "reddit",
    kind: "thread",
    community: "r/SEO",
    url: `https://www.reddit.com/r/SEO/comments/${n}/`,
    title,
    status: "qualified",
    qualified_by: "agent",
    qualify_score: 80,
    intent: "question",
    posted_at: `2026-11-0${n}T00:00:00.000Z`,
    created_at: `2026-11-0${n}T00:00:00.000Z`,
    ...over,
  });
  const seedThreads = () =>
    db.tables.placement_targets.push(
      thread(1, "Is programmatic SEO dead in 2026? : r/SEO"),
      thread(2, "Is programmatic SEO dead in 2026?"),
      thread(3, "How do AI Overviews impact organic traffic? - Quora", { surface: "quora", community: null, url: "https://www.quora.com/How-do-AI-Overviews-impact-organic-traffic" }),
      // Covered by site A's keyword "llm seo checklist".
      thread(4, "What is a good LLM SEO checklist?"),
      thread(5, "Which mattress is best for back pain?", { status: "rejected", qualified_by: "rules:no_overlap", qualify_score: 0 }),
      // Site B's thread never shows on A.
      thread(6, "Should a florist start a newsletter?", B)
    );

  it("answers the site's questions with their thread and no figure, with the read scope, free", async () => {
    seedThreads();
    const before = JSON.stringify(Object.entries(db.tables).filter(([table]) => table !== "tool_calls"));
    const run = await call("list_question_ideas");
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.output.questions).toEqual([
      {
        question: "Is programmatic SEO dead in 2026?",
        threadCount: 2,
        sourceUrl: "https://www.reddit.com/r/SEO/comments/2/",
        host: "reddit.com",
        surface: "reddit",
        community: "r/SEO",
        postedAt: "2026-11-02T00:00:00.000Z",
        basis: "Asked in a public thread",
      },
      {
        question: "How do AI Overviews impact organic traffic?",
        threadCount: 1,
        sourceUrl: "https://www.quora.com/How-do-AI-Overviews-impact-organic-traffic",
        host: "quora.com",
        surface: "quora",
        community: null,
        postedAt: "2026-11-03T00:00:00.000Z",
        basis: "Asked in a public thread",
      },
    ]);
    expect(run.output.note).toMatch(/not search volume/);
    // Nothing is saved, and the tool is a free read: no spend scope, no paywall.
    expect(JSON.stringify(Object.entries(db.tables).filter(([table]) => table !== "tool_calls"))).toBe(before);
    expect(TOOLS.get("list_question_ideas")).toMatchObject({ scope: "read", paid: false });
  });

  it("honours limit, and is empty when discovery found no question", async () => {
    const none = await call("list_question_ideas");
    expect(none.ok && none.output.questions).toEqual([]);
    seedThreads();
    const one = await call("list_question_ideas", { limit: 1 });
    expect(one.ok && (one.output.questions as unknown[]).length).toBe(1);
    expect(await call("list_question_ideas", { limit: 51 })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });
});

describe("list_duplicate_keywords", () => {
  const ART_DUP = "11111111-1111-4111-8111-000000000007";
  const KW_DUP = "22222222-2222-4222-8222-000000000007";
  const KW_POOL = "22222222-2222-4222-8222-000000000008";

  function seedOverlap() {
    // "ai seo" (KW_A1) is published with 200 impressions; a second article
    // on the same words, a pool keyword too, and the same pair on site B.
    db.tables.keywords.push(
      { id: KW_DUP, ...A, keyword: "AI SEO tools", status: "published", article_id: ART_DUP, created_at: "2026-10-06T00:00:00.000Z" },
      { id: KW_POOL, ...A, keyword: "seo ai tool", status: "available", article_id: null, created_at: "2026-10-07T00:00:00.000Z" },
      { id: "22222222-2222-4222-8222-000000000009", ...B, keyword: "bravo keywords", status: "available", article_id: null }
    );
    db.tables.articles.push({ id: ART_DUP, ...A, status: "published", scheduled_date: "2026-11-03", published_url: "https://acme.test/ai-seo-tools", keyword_id: KW_DUP, title: "AI SEO tools" });
    // The fake creates a table on first touch: named here so "nothing changed" compares like with like.
    db.tables.serp_snapshots = [];
    db.tables.content_metrics.push({ ...A, article_id: ART_DUP, captured_on: "2026-11-05", source: "search_console", position: 3.2, impressions: 50, clicks: 4 });
  }

  it("reports the site's clusters with their articles, Search Console's counts and the one to keep, and changes nothing", async () => {
    seedOverlap();
    const before = JSON.stringify(Object.entries(db.tables).filter(([table]) => table !== "tool_calls"));
    const run = await call("list_duplicate_keywords");
    if (!run.ok) throw new Error(JSON.stringify(run));
    expect(run.output.total).toBe(1);
    const [cluster] = run.output.clusters as Array<Record<string, unknown>>;
    expect(cluster).toMatchObject({
      keeperKeywordId: KW_A1,
      keeperBasis: "most_impressions",
      recommendation: expect.stringContaining("200"),
      members: [
        { keywordId: KW_A1, keyword: "ai seo", article: { publishedUrl: "https://acme.test/ai-seo" }, searchConsole: { impressions: 200, clicks: 9, position: 6.5, days: 1 } },
        { keywordId: KW_DUP, searchConsole: { impressions: 50, clicks: 4, position: 3.2, days: 1 } },
        { keywordId: KW_POOL, article: null, searchConsole: null },
      ],
    });
    expect(run.output.note).toMatch(/nothing is deleted, merged or redirected/);
    expect(JSON.stringify(Object.entries(db.tables).filter(([table]) => table !== "tool_calls"))).toBe(before);
    // A free read that deletes nothing: the read scope, no paywall, not destructive.
    expect(TOOLS.get("list_duplicate_keywords")).toMatchObject({ scope: "read", paid: false });
    expect(TOOLS.get("list_duplicate_keywords")?.destructive).toBeUndefined();
  });

  it("is empty for a site with no overlap, and never mixes two sites", async () => {
    const none = await call("list_duplicate_keywords");
    expect(none.ok && none.output).toMatchObject({ clusters: [], total: 0 });
    // Site B's "bravo keyword" and "bravo keywords" are a cluster there, not here.
    seedOverlap();
    const run = await call("list_duplicate_keywords");
    expect(JSON.stringify(run)).not.toContain("bravo");
  });
});
