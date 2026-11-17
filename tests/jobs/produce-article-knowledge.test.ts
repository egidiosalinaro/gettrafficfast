import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { JobRow } from "@/lib/jobs/types";
import { produceArticleWorkflow } from "@/lib/jobs/workflows/produce-article";
import { setLlmProvider } from "@/lib/providers/llm/registry";
import type { LLMProvider, LlmStructuredResult, LlmTextResult } from "@/lib/providers/llm/types";
import { exportArticle } from "@/lib/content/export";
import type { CanonicalArticle } from "@/lib/content/types";
import { FakeSupabase } from "../support/fake-supabase";

/**
 * The knowledge step's links (2026-11-15): up to eight in the body from one
 * call of the links agent, then the Read next block, chosen by code, of
 * live articles only, written once into the stored document and recorded in
 * the graph, and present in what every destination receives.
 */

const repo = vi.hoisted(() => ({
  related: [] as Array<Record<string, unknown>>,
  live: [] as Array<Record<string, unknown>>,
  liveReads: 0,
  recorded: [] as Array<{ targetArticleId: string; anchor: string }>,
}));

vi.mock("@/lib/knowledge/repository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/knowledge/repository")>()),
  persistExtraction: async () => ({ entities: 2, topics: 1 }),
  findRelatedArticles: async () => repo.related,
  listLiveArticles: async () => {
    repo.liveReads += 1;
    return repo.live;
  },
  recordAppliedLinks: async (params: { links: Array<{ targetArticleId: string; anchor: string }> }) => {
    repo.recorded.push(...params.links);
  },
}));

const usage = { model: "stub", inputTokens: 50, outputTokens: 100, costUsd: 0.001 };

function model(links: Array<{ targetArticleId: string; anchor: string; reason: string }>) {
  const prompts: string[] = [];
  const provider: LLMProvider = {
    name: "stub",
    async generateText(): Promise<LlmTextResult> {
      throw new Error("no text call is expected in the knowledge step");
    },
    async generateStructured<T>(prompt: string, schema: z.ZodType<T>): Promise<LlmStructuredResult<T>> {
      prompts.push(prompt);
      const value = prompt.includes("knowledge graph")
        ? { entities: [{ name: "sourdough starter", type: "concept", role: "primary", salience: 0.9 }], topics: [{ name: "Sourdough", isPrimary: true }] }
        : { links };
      return { value: schema.parse(value), usage, raw: "" };
    },
  };
  setLlmProvider(provider);
  return prompts;
}

const BODY =
  '<p><strong>The short version:</strong> Feed it daily. Keep it warm. Discard half before feeding.</p>' +
  '<p>A starter is flour and water that ferments.</p>' +
  '<h2 id="how-often">How often do you feed a starter?</h2><p>Feed it once a day at room temperature, more in summer heat.</p>' +
  '<h2 id="why-discard">Why discard half?</h2><p>Discarding keeps the hydration of the starter stable.</p>';

function canonical(): CanonicalArticle {
  return {
    schemaVersion: 1,
    articleId: "article-1",
    title: "How to keep a sourdough starter alive",
    bodyHtml: BODY,
    headings: [
      { level: 2, id: "how-often", text: "How often do you feed a starter?" },
      { level: 2, id: "why-discard", text: "Why discard half?" },
    ],
    excerpt: "Feed it daily.",
    metaDescription: "Feed it daily.",
    wordCount: 900,
    slug: "sourdough-starter",
    keyword: "sourdough starter",
    language: "en",
    scheduledDate: null,
  };
}

const live = (id: string, keyword: string, title: string) => ({
  articleId: id,
  title,
  keyword,
  excerpt: "E.",
  publishedUrl: `https://crumb.example/blog/${id}`,
  score: 2,
});

function job(): JobRow {
  return {
    id: "job-1",
    user_id: "user-1",
    article_id: "article-1",
    type: "produce-article",
    input: { articleId: "article-1" },
    status: "running",
    current_step: "knowledge",
    attempts: 1,
    max_attempts: 3,
    last_error: null,
  };
}

const knowledge = produceArticleWorkflow.steps.find((step) => step.name === "knowledge")!;

describe("produce-article knowledge: in-body links and Read next", () => {
  let db: FakeSupabase;

  beforeEach(() => {
    repo.related = [];
    repo.live = [];
    repo.liveReads = 0;
    repo.recorded = [];
    db = new FakeSupabase({
      articles: [
        {
          id: "article-1",
          user_id: "user-1",
          business_id: "biz-1",
          keyword_id: "kw-1",
          scheduled_date: "2026-11-16",
          status: "generated",
          keywords: { keyword: "sourdough starter" },
          canonical: canonical(),
        },
      ],
      businesses: [{ id: "biz-1", name: "Crumb", website_url: "https://crumb.example", content_language: "en", media_settings: null }],
    });
  });

  afterEach(() => setLlmProvider(null));

  const run = () =>
    knowledge.run({ job: job(), supabase: db as unknown as SupabaseClient, input: { articleId: "article-1" }, outputs: {} }) as Promise<
      Record<string, unknown>
    >;
  const stored = () => db.tables.articles[0].canonical as CanonicalArticle;

  it("links in the body, then lists three other related live articles under Read next, recorded in the graph", async () => {
    repo.related = [
      live("hydration", "starter hydration", "Starter hydration, explained"),
      live("flour", "best flour for a starter", "Which flour feeds a starter best?"),
      live("discard", "sourdough discard recipes", "What to bake with sourdough discard"),
      live("scoring", "scoring sourdough", "How to score a loaf"),
    ];
    const prompts = model([
      { targetArticleId: "hydration", anchor: "hydration of the starter", reason: "Deeper on hydration." },
      { targetArticleId: "nowhere", anchor: "room temperature", reason: "Not offered: dropped." },
    ]);

    const output = await run();

    expect(prompts.find((p) => p.includes("A new article is being published"))).toContain("Select AT MOST 4 link(s), and aim for 4");
    expect(output).toMatchObject({ links: 1, readNext: 3 });
    const body = stored().bodyHtml;
    expect(body).toContain('<a href="https://crumb.example/blog/hydration">hydration of the starter</a>');
    expect(body.endsWith(
      '<h2 id="read-next">Read next</h2>\n<ul><li><a href="https://crumb.example/blog/flour">Which flour feeds a starter best?</a></li><li><a href="https://crumb.example/blog/discard">What to bake with sourdough discard</a></li><li><a href="https://crumb.example/blog/scoring">How to score a loaf</a></li></ul>'
    )).toBe(true);
    expect(stored().headings.at(-1)).toEqual({ level: 2, id: "read-next", text: "Read next" });
    expect(String(db.tables.articles[0].content)).toContain('<h2 id="read-next">Read next</h2>');
    // The graph relates enough: the site's other articles are not read.
    expect(repo.liveReads).toBe(0);
    expect(repo.recorded).toEqual([
      { targetArticleId: "hydration", anchor: "hydration of the starter" },
      { targetArticleId: "flour", anchor: "Which flour feeds a starter best?" },
      { targetArticleId: "discard", anchor: "What to bake with sourdough discard" },
      { targetArticleId: "scoring", anchor: "How to score a loaf" },
    ]);

    // Every destination gets it: the export a person copies, as HTML and Markdown.
    expect(exportArticle({ canonical: stored() }, "html")).toContain('<h2 id="read-next">Read next</h2>');
    const markdown = exportArticle({ canonical: stored() }, "markdown");
    expect(markdown).toContain("**The short version:** Feed it daily.");
    expect(markdown).toContain("## Read next");
    expect(markdown).toContain("- [How to score a loaf](https://crumb.example/blog/scoring)");
  });

  it("writes one block on a retry, not two", async () => {
    repo.related = [live("flour", "best flour for a starter", "Which flour feeds a starter best?")];
    model([]);
    await run();
    await run();
    expect(stored().bodyHtml.match(/id="read-next"/g)).toHaveLength(1);
    expect(stored().headings.filter((h) => h.id === "read-next")).toHaveLength(1);
  });

  it("falls back on the site's word-similar live articles when the graph relates none, with no model call", async () => {
    repo.live = [
      { articleId: "feeding", title: "Feeding a sourdough starter: how often", keyword: "feeding a sourdough starter", publishedUrl: "https://crumb.example/blog/feeding" },
      { articleId: "knives", title: "The best bread knives", keyword: "bread knives", publishedUrl: "https://crumb.example/blog/knives" },
    ];
    const prompts = model([]);
    const output = await run();
    expect(prompts.some((p) => p.includes("A new article is being published"))).toBe(false);
    expect(output).toMatchObject({ links: 0, readNext: 1 });
    expect(stored().bodyHtml).toContain('<li><a href="https://crumb.example/blog/feeding">Feeding a sourdough starter: how often</a></li>');
    expect(stored().bodyHtml).not.toContain("knives");
  });

  it("leaves the article as it was when the site has nothing related", async () => {
    model([]);
    const output = await run();
    expect(output).toMatchObject({ links: 0, readNext: 0 });
    expect(stored().bodyHtml).toBe(BODY);
    expect(repo.recorded).toEqual([]);
  });
});
