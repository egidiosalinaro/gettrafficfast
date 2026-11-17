import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CANONICAL_SCHEMA_VERSION, type CanonicalArticle } from "@/lib/content/types";
import type { JobRow, StepContext } from "@/lib/jobs/types";
import { FakeSupabase } from "../support/fake-supabase";

/**
 * Push page 3 as a job (docs/LIFECYCLE.md): the site's best close pages get
 * one verified link each and the article a checked meta title; applied and
 * delivered where the site takes updates, stored as a proposal where it does
 * not; the sweep's push stops when the site's switch is off.
 */

const mocks = vi.hoisted(() => ({ related: vi.fn(), publish: vi.fn(), runAgent: vi.fn() }));

vi.mock("@/lib/knowledge/repository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/knowledge/repository")>()),
  findRelatedArticles: (...args: unknown[]) => mocks.related(...args),
}));
vi.mock("@/lib/content/service", () => ({ publishArticle: (...args: unknown[]) => mocks.publish(...args) }));
vi.mock("@/lib/agents/runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agents/runner")>()),
  runAgent: (...args: unknown[]) => mocks.runAgent(...args),
}));

import { canUpdate, canUpdateMeta, PUSH_ARTICLE, pushArticleWorkflow } from "@/lib/jobs/workflows/push-article";
import { isLlmBoundJob, isPaidJob } from "@/lib/jobs/registry";
import type { IntegrationRow } from "@/lib/integrations/types";

const USER = "user-1";
const SITE = "biz-1";
const QUERY = "abandoned cart email subject lines";
const T_URL = "https://acme.test/blog/t";

const doc = (id: string, bodyHtml: string, over: Partial<CanonicalArticle> = {}): CanonicalArticle => ({
  schemaVersion: CANONICAL_SCHEMA_VERSION,
  articleId: id,
  title: `Abandoned cart emails ${id}`,
  bodyHtml,
  headings: [],
  excerpt: "",
  metaDescription: "An old description of abandoned cart emails.",
  wordCount: 100,
  slug: id,
  keyword: "abandoned cart email",
  language: "en",
  scheduledDate: "2026-09-01",
  ...over,
});

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

const metrics = (articleId: string, impressions: number, clicks: number) =>
  Array.from({ length: 5 }, (_, i) => ({
    article_id: articleId,
    business_id: SITE,
    source: "search_console",
    captured_on: `2026-11-0${i + 1}`,
    impressions,
    clicks,
    position: 9,
  }));

let db: FakeSupabase;
const job: JobRow = {
  id: "job-1",
  user_id: USER,
  article_id: "t",
  type: PUSH_ARTICLE,
  input: { pushId: "push-1", articleId: "t" },
  status: "running",
  current_step: null,
  attempts: 1,
  max_attempts: 2,
  last_error: null,
};

async function runJob() {
  const base = { job, supabase: db as unknown as SupabaseClient, input: job.input };
  const outputs: Record<string, unknown> = {};
  for (const step of pushArticleWorkflow.steps) {
    outputs[step.name] = await step.run({ ...base, outputs: { ...outputs } } as StepContext);
  }
  return outputs;
}

const push = () => db.tables.article_pushes[0] as Record<string, unknown> & { links: Array<Record<string, unknown>> };
const article = (id: string) => db.tables.articles.find((a) => a.id === id) as { canonical: CanonicalArticle };

const GOOD_TITLE = "Abandoned cart email subject lines that get opened";
const GOOD_DESCRIPTION = "How to write abandoned cart email subject lines that get the email opened, with examples you can adapt to your store.";

function seed(over: { integrations?: unknown[]; origin?: string; settings?: Record<string, unknown> } = {}) {
  db = new FakeSupabase({
    businesses: [{ id: SITE, user_id: USER, content_language: "en", automation_settings: over.settings ?? { pushPage3: true } }],
    analytics_connections: [{ business_id: SITE, provider: "search_console", last_synced_on: "2026-11-12", site_url: "sc-domain:acme.test", status: "connected" }],
    integrations: (over.integrations ?? [
      { id: "int-1", user_id: USER, business_id: SITE, type: "webhook", config: {}, status: "connected", created_at: "2026-01-01" },
    ]) as Record<string, unknown>[],
    article_pushes: [
      { id: "push-1", user_id: USER, business_id: SITE, article_id: "t", origin: over.origin ?? "sweep", status: "selected", main_query: QUERY, links: [] },
    ],
    articles: [
      row("t", doc("t", "<p>Write subject lines that name the item. We tested 40 lines.</p>"), { published_url: T_URL }),
      // The best page writes the query itself: linked with no model.
      row("a", doc("a", `<p>Good ${QUERY} get the email opened.</p>`)),
      // The second needs the added sentence.
      row("b", doc("b", "<p>Timing matters more than discounts.</p>")),
      // Unrelated by graph and words: never a source.
      row("c", doc("c", "<p>Agency pricing explained.</p>", { title: "Agency pricing", keyword: "agency pricing" })),
    ],
    content_metrics: [...metrics("a", 50, 9), ...metrics("b", 40, 2), ...metrics("c", 400, 90)],
    article_links: [],
    article_versions: [],
    jobs: [],
    agent_runs: [],
  });
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mocks.related.mockReset().mockResolvedValue([]);
  mocks.publish.mockReset().mockImplementation(async (p: { articleId: string }) => ({ ok: true, url: `https://acme.test/blog/${p.articleId}`, externalId: `ext-${p.articleId}` }));
  mocks.runAgent.mockReset().mockResolvedValue({
    metaTitle: GOOD_TITLE,
    metaDescription: GOOD_DESCRIPTION,
    links: [{ sourceArticleId: "b", mode: "sentence", anchor: "subject lines for abandoned cart emails", paragraph: 1, sentence: "So do subject lines for abandoned cart emails.", }],
  });
});

describe("push-article", () => {
  it("is registered as paid and LLM-bound", () => {
    expect(isPaidJob(PUSH_ARTICLE)).toBe(true);
    expect(isLlmBoundJob(PUSH_ARTICLE)).toBe(true);
  });

  it("on a site that takes updates: links from the best close pages and a new title, delivered as updates", async () => {
    seed();
    await runJob();

    expect(mocks.runAgent).toHaveBeenCalledTimes(1);
    const input = mocks.runAgent.mock.calls[0][1] as { mainQuery: string; sources: Array<{ articleId: string }> };
    expect(input.mainQuery).toBe(QUERY);
    expect(input.sources.map((s) => s.articleId)).toEqual(["a", "b"]);

    expect(article("a").canonical.bodyHtml).toBe(`<p>Good <a href="${T_URL}">${QUERY}</a> get the email opened.</p>`);
    expect(article("b").canonical.bodyHtml).toBe(
      `<p>Timing matters more than discounts. So do <a href="${T_URL}">subject lines for abandoned cart emails</a>.</p>`
    );
    expect(article("c").canonical.bodyHtml).toBe("<p>Agency pricing explained.</p>");
    // The headline and the slug never change; the meta title does.
    expect(article("t").canonical).toMatchObject({ title: "Abandoned cart emails t", slug: "t", metaTitle: GOOD_TITLE, metaDescription: GOOD_DESCRIPTION });

    expect(mocks.publish.mock.calls.map(([p]) => [p.articleId, p.externalPostId])).toEqual([
      ["a", "ext-a"],
      ["b", "ext-b"],
      ["t", "ext-t"],
    ]);
    expect(db.tables.article_versions).toHaveLength(3);
    expect(db.tables.article_links.map((l) => [l.from_article_id, l.to_article_id, l.status])).toEqual([
      ["a", "t", "applied"],
      ["b", "t", "applied"],
    ]);
    expect(push()).toMatchObject({ status: "applied", applied_by: "platform", new_title: GOOD_TITLE, old_title: "Abandoned cart emails t" });
    expect(push().applied_at).toEqual(expect.any(String));
    expect(push().links.map((l) => [l.fromArticleId, l.mode, l.status])).toEqual([
      ["a", "existing", "applied"],
      ["b", "sentence", "applied"],
    ]);
  });

  it("without a destination that takes updates: nothing changes on the site or in the documents, a proposal is stored", async () => {
    seed({ integrations: [] });
    const before = JSON.stringify(db.tables.articles);
    await runJob();
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(JSON.stringify(db.tables.articles)).toBe(before);
    expect(push()).toMatchObject({ status: "proposed", new_title: GOOD_TITLE });
    expect(push().applied_at ?? null).toBeNull();
    expect(push().links.map((l) => [l.fromArticleId, l.status, l.sentence])).toEqual([
      ["a", "proposed", null],
      ["b", "proposed", "So do subject lines for abandoned cart emails."],
    ]);
  });

  it("keeps the old title when the proposed one breaks the rules, and still links", async () => {
    seed();
    mocks.runAgent.mockResolvedValue({ metaTitle: "Shocking secrets of email", metaDescription: null, links: [] });
    await runJob();
    expect(article("t").canonical.metaTitle).toBeUndefined();
    expect(push()).toMatchObject({ status: "applied", new_title: null });
    expect(push().links.map((l) => [l.fromArticleId, l.status])).toEqual([
      ["a", "applied"],
      ["b", "skipped"],
    ]);
  });

  it("a sweep's push stops when the site's switch is off; an on-demand one does not need it", async () => {
    seed({ settings: {} });
    await runJob();
    expect(mocks.runAgent).not.toHaveBeenCalled();
    expect(push()).toMatchObject({ status: "skipped", skip_reason: "Push page 3 is off for this site." });

    seed({ settings: {}, origin: "on_demand" });
    await runJob();
    expect(mocks.runAgent).toHaveBeenCalledTimes(1);
  });

  it("updates WordPress only with the post id, a webhook always", () => {
    const integration = (type: string) => ({ type }) as IntegrationRow;
    expect(canUpdate(integration("webhook"), null)).toBe(true);
    expect(canUpdate(integration("wordpress"), "42")).toBe(true);
    expect(canUpdate(integration("wordpress"), null)).toBe(false);
    expect(canUpdate(null, "42")).toBe(false);
    // WordPress makes its <title> from the headline, which never changes: the new title is proposed there.
    expect(canUpdateMeta(integration("webhook"))).toBe(true);
    expect(canUpdateMeta(integration("wordpress"))).toBe(false);
  });

  it("on WordPress: links are delivered, the title waits for the person", async () => {
    seed({ integrations: [{ id: "int-wp", user_id: USER, business_id: SITE, type: "wordpress", config: {}, status: "connected", created_at: "2026-01-01" }] });
    await runJob();
    expect(mocks.publish.mock.calls.map(([p]) => p.articleId)).toEqual(["a", "b"]);
    expect(article("t").canonical.metaTitle).toBeUndefined();
    expect(push()).toMatchObject({ status: "proposed", new_title: GOOD_TITLE });
    expect(push().links.map((l) => l.status)).toEqual(["applied", "applied"]);
  });
});
