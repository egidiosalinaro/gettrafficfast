import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CANONICAL_SCHEMA_VERSION, type CanonicalArticle } from "@/lib/content/types";
import type { JobRow, StepContext } from "@/lib/jobs/types";
import { FakeSupabase } from "../support/fake-supabase";

/**
 * The back-link pass as a job: when an article is published, at most three
 * older related articles of the same site get one verified link to it, are
 * archived, stored, delivered again through the ordinary publish path and
 * recorded in article_links. Off per site with `backLinks: false`; never
 * the new article itself; never twice.
 */

const mocks = vi.hoisted(() => ({
  related: vi.fn(),
  publish: vi.fn(),
  runAgent: vi.fn(),
}));

vi.mock("@/lib/knowledge/repository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/knowledge/repository")>()),
  findRelatedArticles: (...args: unknown[]) => mocks.related(...args),
}));
vi.mock("@/lib/content/service", () => ({ publishArticle: (...args: unknown[]) => mocks.publish(...args) }));
vi.mock("@/lib/agents/runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agents/runner")>()),
  runAgent: (...args: unknown[]) => mocks.runAgent(...args),
}));

import { BACKLINK_ARTICLE, backlinkArticleWorkflow, enqueueBacklinkPass } from "@/lib/jobs/workflows/backlink-article";
import { getWorkflow, isLlmBoundJob, isPaidJob } from "@/lib/jobs/registry";

const USER = "user-1";
const SITE = "biz-1";
const NEW_URL = "https://acme.test/blog/abandoned-cart-email";

const doc = (id: string, bodyHtml: string, keyword = id): CanonicalArticle => ({
  schemaVersion: CANONICAL_SCHEMA_VERSION,
  articleId: id,
  title: `Title of ${id}`,
  bodyHtml,
  headings: [],
  excerpt: "",
  metaDescription: "",
  wordCount: 10,
  slug: id,
  keyword,
  language: "en",
  scheduledDate: "2026-10-01",
});

const WITH_KEYWORD = (n: string) => `<p>Article ${n}: an abandoned cart email recovers sales.</p>`;
const WITHOUT_KEYWORD = "<p>Stores win back shoppers who left items behind.</p>";

const row = (id: string, canonical: CanonicalArticle, over: Record<string, unknown> = {}) => ({
  id,
  user_id: USER,
  business_id: SITE,
  keyword_id: `kw-${id}`,
  status: "published",
  published_url: `https://acme.test/blog/${id}`,
  external_post_id: `ext-${id}`,
  canonical,
  ...over,
});

let db: FakeSupabase;
const job: JobRow = {
  id: "job-1",
  user_id: USER,
  article_id: "new",
  type: BACKLINK_ARTICLE,
  input: { articleId: "new" },
  status: "running",
  current_step: null,
  attempts: 1,
  max_attempts: 2,
  last_error: null,
};

async function runPass() {
  const base = { job, supabase: db as unknown as SupabaseClient, input: job.input };
  const [select, link] = backlinkArticleWorkflow.steps;
  const selected = await select.run({ ...base, outputs: {} } as StepContext);
  const linked = await link.run({ ...base, outputs: { select: selected } } as StepContext);
  return { selected: selected as Record<string, unknown>, linked: linked as { skipped?: string; linked?: number; results?: Array<Record<string, unknown>> } };
}

const related = (...ids: string[]) =>
  ids.map((id, i) => ({ articleId: id, title: id, keyword: id, excerpt: "", publishedUrl: `https://acme.test/blog/${id}`, score: 10 - i }));
const article = (id: string) => db.tables.articles.find((a) => a.id === id) as { canonical: CanonicalArticle } & Record<string, unknown>;

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mocks.related.mockReset();
  mocks.publish.mockReset();
  mocks.runAgent.mockReset();
  mocks.publish.mockImplementation(async (params: { articleId: string }) => ({ ok: true, url: `https://acme.test/blog/${params.articleId}`, externalId: `ext-${params.articleId}` }));
  db = new FakeSupabase({
    businesses: [{ id: SITE, user_id: USER, content_language: "en", automation_settings: {} }],
    integrations: [{ id: "int-1", user_id: USER, business_id: SITE, type: "webhook", config: {}, status: "connected", created_at: "2026-01-01" }],
    articles: [
      row("new", doc("new", "<p>The new article.</p>", "abandoned cart email"), { published_url: NEW_URL }),
      row("a", doc("a", WITH_KEYWORD("a"))),
      row("b", doc("b", WITH_KEYWORD("b"))),
      row("c", doc("c", WITH_KEYWORD("c"))),
      row("d", doc("d", WITH_KEYWORD("d"))),
      row("e", doc("e", WITHOUT_KEYWORD)),
    ],
    article_links: [],
    article_versions: [],
    jobs: [],
    agent_runs: [],
  });
});

describe("the back-link pass", () => {
  it("links at most three older articles, delivers each as an update, and records the links", async () => {
    mocks.related.mockResolvedValue(related("a", "b", "c", "d"));
    const { linked } = await runPass();

    expect(linked.linked).toBe(3);
    for (const id of ["a", "b", "c"]) {
      expect(article(id).canonical.bodyHtml).toBe(`<p>Article ${id}: an <a href="${NEW_URL}">abandoned cart email</a> recovers sales.</p>`);
      expect(article(id).content).toContain(`<a href="${NEW_URL}">`);
    }
    // The fourth related article is beyond the cap: untouched.
    expect(article("d").canonical.bodyHtml).toBe(WITH_KEYWORD("d"));
    // The new article itself is never changed.
    expect(article("new").canonical.bodyHtml).toBe("<p>The new article.</p>");

    // Delivered through the publish path as an update of the existing post.
    expect(mocks.publish).toHaveBeenCalledTimes(3);
    expect(mocks.publish.mock.calls.map(([p]) => [p.articleId, p.externalPostId, p.businessId, p.integration.id])).toEqual([
      ["a", "ext-a", SITE, "int-1"],
      ["b", "ext-b", SITE, "int-1"],
      ["c", "ext-c", SITE, "int-1"],
    ]);
    expect(mocks.publish.mock.calls[0][0].canonical.bodyHtml).toContain(NEW_URL);

    expect(db.tables.article_links).toMatchObject([
      { from_article_id: "a", to_article_id: "new", anchor: "abandoned cart email", status: "applied", business_id: SITE },
      { from_article_id: "b", to_article_id: "new", status: "applied" },
      { from_article_id: "c", to_article_id: "new", status: "applied" },
    ]);
    // What was replaced is on record.
    expect(db.tables.article_versions).toMatchObject([
      { article_id: "a", version: 1, canonical: { bodyHtml: WITH_KEYWORD("a") } },
      { article_id: "b", version: 1 },
      { article_id: "c", version: 1 },
    ]);
    // The keyword was in every article: no model was asked.
    expect(mocks.runAgent).not.toHaveBeenCalled();
  });

  it("asks the internal-links agent only where the keyword is absent, and drops an anchor that does not verify", async () => {
    mocks.related.mockResolvedValue(related("e"));
    mocks.runAgent.mockResolvedValue({ links: [{ targetArticleId: "new", anchor: "a phrase the model made up", reason: "x" }] });
    const invented = await runPass();
    expect(invented.linked).toMatchObject({ linked: 0, results: [{ articleId: "e", status: "skipped", reason: expect.stringContaining("not found") }] });
    expect(article("e").canonical.bodyHtml).toBe(WITHOUT_KEYWORD);
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(db.tables.article_links).toEqual([]);
    expect(db.tables.article_versions).toEqual([]);

    mocks.runAgent.mockResolvedValue({ links: [{ targetArticleId: "new", anchor: "shoppers who left items behind", reason: "x" }] });
    const verified = await runPass();
    expect(verified.linked).toMatchObject({ linked: 1, results: [{ articleId: "e", status: "linked", via: "agent" }] });
    // One call per older article, on the agent that already exists, for one link.
    const [agent, input, ctx] = mocks.runAgent.mock.calls[1];
    expect(agent.name).toBe("internal-links");
    expect(input).toMatchObject({ maxLinks: 1, targets: [{ articleId: "new" }], sourceTitle: "Title of e" });
    expect(ctx.budget.maxCostUsd).toBeLessThanOrEqual(0.05);
  });

  it("never links the new article to itself, even when the graph returns it", async () => {
    mocks.related.mockResolvedValue(related("new", "a"));
    const { selected, linked } = await runPass();
    expect(selected.olderArticleIds).toEqual(["a"]);
    expect(linked.linked).toBe(1);
    expect(mocks.publish.mock.calls.map(([p]) => p.articleId)).toEqual(["a"]);
  });

  it("does nothing the second time: no duplicate link, no second delivery", async () => {
    mocks.related.mockResolvedValue(related("a", "b"));
    await runPass();
    mocks.publish.mockClear();
    const again = await runPass();
    expect(again.selected).toEqual({ skipped: "every related article already links to it" });
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(db.tables.article_links).toHaveLength(2);
    expect(article("a").canonical.bodyHtml.match(/<a /g)).toHaveLength(1);
  });

  it("is off for a site that turned it off, and on for one that never said", async () => {
    mocks.related.mockResolvedValue(related("a"));
    db.tables.businesses[0].automation_settings = { backLinks: false };
    const off = await runPass();
    expect(off.selected).toEqual({ skipped: "back-links are off for this site" });
    expect(mocks.related).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();

    db.tables.businesses[0].automation_settings = null;
    expect((await runPass()).linked.linked).toBe(1);
  });

  it("skips an article that is not live, one being refreshed, and another site's", async () => {
    mocks.related.mockResolvedValue(related("a", "b", "c"));
    Object.assign(article("a"), { status: "needs_review" });
    db.tables.jobs.push({ id: "j-r", article_id: "b", type: "refresh-article", status: "running" });
    Object.assign(article("c"), { business_id: "biz-2" });
    const { selected, linked } = await runPass();
    expect(selected.olderArticleIds).toEqual(["b"]);
    expect(linked).toMatchObject({ linked: 0, results: [{ articleId: "b", status: "skipped", reason: "the article is being refreshed" }] });
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("records a link the site refused as suggested, not applied", async () => {
    mocks.related.mockResolvedValue(related("a"));
    mocks.publish.mockResolvedValue({ ok: false, error: "HTTP 500" });
    const { linked } = await runPass();
    expect(linked).toMatchObject({ linked: 0, results: [{ articleId: "a", status: "stored_not_delivered", reason: "HTTP 500" }] });
    expect(db.tables.article_links).toMatchObject([{ from_article_id: "a", status: "suggested" }]);
  });

  it("does nothing for an article that is not live or has no related article", async () => {
    mocks.related.mockResolvedValue([]);
    expect((await runPass()).selected).toEqual({ skipped: "no related published article" });
    Object.assign(article("new"), { status: "generated", published_url: null });
    expect((await runPass()).selected).toEqual({ skipped: "the article is not live" });
  });
});

describe("queueing the pass", () => {
  it("queues once per article, bound to the article and the site", async () => {
    const supabase = db as unknown as SupabaseClient;
    const id = await enqueueBacklinkPass({ supabase, userId: USER, businessId: SITE, articleId: "new" });
    expect(id).toEqual(expect.any(String));
    expect(db.tables.jobs).toMatchObject([{ type: BACKLINK_ARTICLE, article_id: "new", business_id: SITE, user_id: USER, input: { articleId: "new" }, max_attempts: 2 }]);
    // A republish, or a retried publish: nothing more is queued.
    expect(await enqueueBacklinkPass({ supabase, userId: USER, businessId: SITE, articleId: "new" })).toBeNull();
    expect(db.tables.jobs).toHaveLength(1);
  });

  it("queues nothing for an article with no site, and never throws", async () => {
    const supabase = db as unknown as SupabaseClient;
    expect(await enqueueBacklinkPass({ supabase, userId: USER, businessId: null, articleId: "new" })).toBeNull();
    const broken = { from: () => { throw new Error("down"); } } as unknown as SupabaseClient;
    expect(await enqueueBacklinkPass({ supabase: broken, userId: USER, businessId: SITE, articleId: "new" })).toBeNull();
  });

  it("is a registered workflow that waits out an LLM pause and runs only for a paying owner", () => {
    expect(getWorkflow(BACKLINK_ARTICLE)).toBe(backlinkArticleWorkflow);
    expect(isLlmBoundJob(BACKLINK_ARTICLE)).toBe(true);
    expect(isPaidJob(BACKLINK_ARTICLE)).toBe(true);
  });
});
