import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "../support/fake-supabase";

/**
 * publishReadyArticles: the daily run's publishing phase, also called by the
 * worker tick so an article whose production finishes after that phase is
 * published within minutes (2026-11-10: a job that ran 08:00:39 → 08:08:10
 * was skipped as still producing and would have waited a day). Delivery is
 * claimed atomically, so two runs never deliver the same article twice.
 */

const state = vi.hoisted(() => ({
  ensureCanonical: vi.fn(),
  publishArticle: vi.fn(),
  backlinks: [] as string[],
}));

vi.mock("@sentry/nextjs", () => ({ captureException: () => {}, captureMessage: () => {} }));
vi.mock("@/lib/content/service", () => ({
  ensureCanonical: (...args: unknown[]) => state.ensureCanonical(...args),
  publishArticle: (...args: unknown[]) => state.publishArticle(...args),
}));
vi.mock("@/lib/jobs/workflows/backlink-article", () => ({
  enqueueBacklinkPass: async ({ articleId }: { articleId: string }) => {
    state.backlinks.push(articleId);
    return `backlink-${articleId}`;
  },
}));
vi.mock("@/lib/notifications/email", () => ({
  sendNotificationEmail: async () => {},
  integrationErrorEmail: () => ({ subject: "", html: "" }),
}));

import { CLAIM_LEASE_MS, publishReadyArticles } from "@/lib/articles/publish-ready";

const CANONICAL = { bodyHtml: "<p>Answer.</p>" };
const today = new Date().toISOString().slice(0, 10);
const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

function article(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    user_id: "u-1",
    business_id: "biz-1",
    keyword_id: `kw-${id}`,
    status: "generated",
    content: "<p>Answer.</p>",
    canonical: CANONICAL,
    scheduled_date: today,
    last_error: null,
    publish_claimed_at: null,
    updated_at: minutesAgo(2),
    keywords: { keyword: "ai blog writer for seo" },
    ...overrides,
  };
}

function seed(articles: Record<string, unknown>[], jobs: Record<string, unknown>[] = []) {
  return new FakeSupabase({
    articles,
    jobs,
    integrations: [{ id: "int-1", user_id: "u-1", business_id: "biz-1", type: "webhook", status: "connected", created_at: "2026-10-01" }],
  });
}

/** publishArticle's effect on the row, after a delivery that takes a moment. */
function deliverInto(db: FakeSupabase) {
  state.publishArticle.mockImplementation(async ({ articleId }: { articleId: string }) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    const row = db.tables.articles.find((a) => a.id === articleId)!;
    Object.assign(row, { status: "published", published_url: `https://acme.test/${articleId}`, last_error: null });
    return { ok: true, url: `https://acme.test/${articleId}`, externalId: "p-1" };
  });
}

const tickOptions = (limit = 3) => ({
  runId: crypto.randomUUID(),
  today,
  limit,
  freshSince: minutesAgo(24 * 60),
});

const dailyOptions = () => ({ runId: crypto.randomUUID(), today, limit: 10 });

beforeEach(() => {
  state.backlinks = [];
  state.ensureCanonical.mockReset();
  state.ensureCanonical.mockResolvedValue({ article: CANONICAL, decision: "publish", issues: [] });
  state.publishArticle.mockReset();
});

describe("publishReadyArticles from the tick", () => {
  it("publishes a generated article whose production job has just completed, and queues its back-link pass", async () => {
    const db = seed(
      [article("a-1")],
      [{ id: "job-1", article_id: "a-1", type: "produce-article", status: "completed", finished_at: minutesAgo(1) }]
    );
    deliverInto(db);

    const { counts, error } = await publishReadyArticles(db as never, tickOptions());

    expect(error).toBeNull();
    expect(counts).toMatchObject({ published: 1, still_producing: 0 });
    expect(state.publishArticle).toHaveBeenCalledTimes(1);
    expect(db.tables.articles[0]).toMatchObject({ status: "published", publish_claimed_at: null });
    expect(state.backlinks).toEqual(["a-1"]);
  });

  it("leaves an article alone while its production job is still running (enrichment comes after generated)", async () => {
    const db = seed(
      [article("a-1")],
      [{ id: "job-1", article_id: "a-1", type: "produce-article", status: "running" }]
    );
    deliverInto(db);

    const { counts } = await publishReadyArticles(db as never, tickOptions());

    expect(counts).toMatchObject({ published: 0, still_producing: 1 });
    expect(state.publishArticle).not.toHaveBeenCalled();
    expect(db.tables.articles[0]).toMatchObject({ status: "generated", publish_claimed_at: null });
  });

  it("never publishes a needs_review article", async () => {
    const db = seed([article("a-1", { status: "needs_review", last_error: "Prompt leakage" })]);
    deliverInto(db);

    const { counts } = await publishReadyArticles(db as never, tickOptions());

    expect(counts.published).toBe(0);
    expect(state.publishArticle).not.toHaveBeenCalled();
    expect(db.tables.articles[0].status).toBe("needs_review");
  });

  it("does not publish an article scheduled for a later day", async () => {
    const db = seed([article("a-1", { scheduled_date: tomorrow })]);
    deliverInto(db);

    const { counts } = await publishReadyArticles(db as never, tickOptions());

    expect(counts.published).toBe(0);
    expect(state.publishArticle).not.toHaveBeenCalled();
  });

  it("leaves a failed delivery to the daily run's retry, and does not look at articles outside its window", async () => {
    const db = seed([
      article("failed", { last_error: "publish: 503 from the site" }),
      article("stale", { updated_at: minutesAgo(25 * 60) }),
    ]);
    deliverInto(db);

    const { counts } = await publishReadyArticles(db as never, tickOptions());

    expect(state.publishArticle).not.toHaveBeenCalled();
    expect(counts).toMatchObject({ published: 0, retry_pending: 0 });

    // The daily run still retries both.
    const daily = await publishReadyArticles(db as never, dailyOptions());
    expect(daily.counts.published).toBe(2);
  });

  it("publishes the newest first and at most its limit", async () => {
    const db = seed([
      article("old", { updated_at: minutesAgo(600) }),
      article("new", { updated_at: minutesAgo(1) }),
      article("mid", { updated_at: minutesAgo(60) }),
    ]);
    deliverInto(db);

    const { counts } = await publishReadyArticles(db as never, tickOptions(2));

    expect(counts.published).toBe(2);
    expect(state.publishArticle.mock.calls.map(([p]) => (p as { articleId: string }).articleId)).toEqual(["new", "mid"]);
  });

  it("counts an article with no destination and changes nothing on it", async () => {
    const db = seed([article("a-1", { business_id: "biz-other" })]);
    deliverInto(db);

    const { counts } = await publishReadyArticles(db as never, tickOptions());

    expect(counts).toMatchObject({ published: 0, no_destination: 1 });
    expect(db.tables.articles[0]).toMatchObject({ status: "generated", publish_claimed_at: null });
  });

  it("parks an article the gates refuse in needs_review and releases its claim", async () => {
    const db = seed([article("a-1", { canonical: null })]);
    state.ensureCanonical.mockResolvedValue({
      article: null,
      decision: "needs_review",
      issues: [{ code: "PROMPT_LEAKAGE", action: "block", message: "Prompt leakage" }],
    });

    const { counts } = await publishReadyArticles(db as never, tickOptions());

    expect(counts.needs_review).toBe(1);
    expect(state.publishArticle).not.toHaveBeenCalled();
    expect(db.tables.articles[0]).toMatchObject({ status: "needs_review", last_error: "Prompt leakage", publish_claimed_at: null });
  });
});

describe("no double publish", () => {
  it("two concurrent runs (the daily run and a tick) deliver the article once", async () => {
    const db = seed([article("a-1")]);
    deliverInto(db);

    const [daily, tick] = await Promise.all([
      publishReadyArticles(db as never, dailyOptions()),
      publishReadyArticles(db as never, tickOptions()),
    ]);

    expect(state.publishArticle).toHaveBeenCalledTimes(1);
    expect(daily.counts.published + tick.counts.published).toBe(1);
    expect(daily.counts.claimed_elsewhere + tick.counts.claimed_elsewhere).toBe(1);
    expect(state.backlinks).toEqual(["a-1"]);
  });

  it("two concurrent ticks deliver each article once", async () => {
    const db = seed([article("a-1"), article("a-2", { updated_at: minutesAgo(3) })]);
    deliverInto(db);

    await Promise.all([
      publishReadyArticles(db as never, tickOptions()),
      publishReadyArticles(db as never, tickOptions()),
      publishReadyArticles(db as never, tickOptions()),
    ]);

    const delivered = state.publishArticle.mock.calls.map(([p]) => (p as { articleId: string }).articleId).sort();
    expect(delivered).toEqual(["a-1", "a-2"]);
  });

  it("does not deliver an article another live run has claimed", async () => {
    const db = seed([article("a-1", { publish_claimed_at: minutesAgo(1) })]);
    deliverInto(db);

    const { counts } = await publishReadyArticles(db as never, tickOptions());

    expect(counts.claimed_elsewhere).toBe(1);
    expect(state.publishArticle).not.toHaveBeenCalled();
  });

  it("takes over a claim left by a run that died mid-delivery, once the lease is over", async () => {
    const db = seed([article("a-1", { publish_claimed_at: new Date(Date.now() - CLAIM_LEASE_MS - 60_000).toISOString() })]);
    deliverInto(db);

    const { counts } = await publishReadyArticles(db as never, tickOptions());

    expect(counts.published).toBe(1);
    expect(db.tables.articles[0].publish_claimed_at).toBeNull();
  });

  it("keeps the article generated and releases the claim when the delivery fails, so the daily run retries it", async () => {
    const db = seed([article("a-1")]);
    state.publishArticle.mockImplementation(async ({ articleId }: { articleId: string }) => {
      const row = db.tables.articles.find((a) => a.id === articleId)!;
      row.last_error = "publish: 503 from the site";
      return { ok: false, error: "503 from the site" };
    });

    const { counts } = await publishReadyArticles(db as never, tickOptions());

    expect(counts.retry_pending).toBe(1);
    expect(db.tables.articles[0]).toMatchObject({ status: "generated", publish_claimed_at: null });
    expect(state.backlinks).toEqual([]);
  });
});
