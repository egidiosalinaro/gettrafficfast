import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "../support/fake-supabase";
import { OTHER, SITE_A, SITE_B, SITE_C, USER, apiCaller, businesses, uuid } from "./support";

/**
 * generate_article and publish_article, run as an API-key caller on site A
 * through the owner-scoped service role, the way a real key runs them. What
 * is pinned: each needs its scope (spend for generating; publish for
 * publishing, the one tool that writes to the customer's site); an article
 * of another site or account is refused before anything happens;
 * publishing needs confirm: true, and an article in needs_review also needs
 * acknowledgeQualityIssues: true; the happy paths call the screens' own
 * functions (the job is enqueued like Generate now's and keeps running after
 * the answer; the publish answers the live URL); and a job that finished
 * while the call waited has its model cost on the call's audit row.
 */

const mocks = vi.hoisted(() => ({
  afterTasks: [] as unknown[],
  subscribed: true,
  runJobNow: vi.fn(),
  ensureCanonical: vi.fn(),
  publishArticle: vi.fn(),
  db: null as unknown,
}));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: unknown) => {
    mocks.afterTasks.push(task);
  },
}));
vi.mock("@/lib/subscription", () => ({ hasActiveSubscription: async () => mocks.subscribed }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mocks.db }));
vi.mock("@/lib/jobs/worker", () => ({ runJobNow: (...args: unknown[]) => mocks.runJobNow(...args) }));
vi.mock("@/lib/content/service", () => ({
  ensureCanonical: (...args: unknown[]) => mocks.ensureCanonical(...args),
  publishArticle: (...args: unknown[]) => mocks.publishArticle(...args),
}));

import { runTool } from "@/lib/tools/runner";

const A_QUEUED = uuid("a", 1);
const A_GENERATED = uuid("a", 2);
const A_REVIEW = uuid("a", 3);
const A_GENERATING = uuid("a", 4);
const A_PUBLISHED = uuid("a", 5);
const A_B = uuid("b", 1);
const A_C = uuid("c", 1);

const CANONICAL = { bodyHtml: "<p>The answer first.</p>", title: "How to be cited" };

function article(id: string, userId: string, businessId: string, status: string, over: Record<string, unknown> = {}) {
  return {
    id,
    user_id: userId,
    business_id: businessId,
    keyword_id: `kw-${id}`,
    status,
    content: "<p>The answer first.</p>",
    canonical: CANONICAL,
    scheduled_date: "2026-11-09",
    last_error: null,
    keywords: { keyword: "answer engine optimization" },
    ...over,
  };
}

function seed() {
  const db = new FakeSupabase({
    businesses: businesses(),
    articles: [
      article(A_QUEUED, USER, SITE_A, "queued"),
      article(A_GENERATED, USER, SITE_A, "generated"),
      article(A_REVIEW, USER, SITE_A, "needs_review", { last_error: "The answer is not in the first paragraph | Two headings repeat" }),
      article(A_GENERATING, USER, SITE_A, "generating"),
      article(A_PUBLISHED, USER, SITE_A, "published", { published_url: "https://acme.test/blog/cited" }),
      article(A_B, USER, SITE_B, "generated"),
      article(A_C, OTHER, SITE_C, "generated"),
    ],
    integrations: [
      { id: "int-a", user_id: USER, business_id: SITE_A, type: "webhook", config: {}, status: "connected", created_at: "2026-10-01T00:00:00Z" },
    ],
    jobs: [],
    agent_runs: [],
    tool_calls: [],
  });
  mocks.db = db;
  return db;
}

const call = (db: FakeSupabase, name: string, input: unknown, scopes?: Array<"read" | "write" | "spend" | "publish">) =>
  runTool(apiCaller(db, scopes ? { scopes } : { scopes: ["read", "write", "spend", "publish"] }), name, input);

/** Every table but the audit log, which records every call. */
const customerData = (db: FakeSupabase) =>
  JSON.stringify(Object.entries(db.tables).filter(([table]) => table !== "tool_calls"));

let quiet: Array<ReturnType<typeof vi.spyOn>>;
beforeEach(() => {
  mocks.afterTasks = [];
  mocks.subscribed = true;
  mocks.runJobNow.mockReset();
  mocks.runJobNow.mockResolvedValue("yielded");
  mocks.ensureCanonical.mockReset();
  mocks.ensureCanonical.mockResolvedValue({ article: CANONICAL, decision: "publish", issues: [] });
  mocks.publishArticle.mockReset();
  mocks.publishArticle.mockResolvedValue({ ok: true, url: "https://acme.test/blog/cited", externalId: "post-1" });
  quiet = (["info", "warn", "error", "log"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
});
afterEach(() => quiet.forEach((spy) => spy.mockRestore()));

describe("scopes", () => {
  it("generate_article needs write and spend; publish_article needs publish", async () => {
    const db = seed();
    expect(await call(db, "generate_article", { articleId: A_QUEUED }, ["read", "write"])).toMatchObject({
      ok: false,
      status: 403,
      error: { code: "forbidden_scope", message: "generate_article needs a key with the spend scope." },
    });
    expect(await call(db, "publish_article", { articleId: A_GENERATED, confirm: true }, ["read", "write", "spend"])).toMatchObject({
      ok: false,
      status: 403,
      error: { code: "forbidden_scope", message: "publish_article needs a key with the publish scope." },
    });
    expect(db.tables.jobs).toEqual([]);
    expect(mocks.publishArticle).not.toHaveBeenCalled();
  });

  it("publish_article needs a subscription, as the Publish button does", async () => {
    const db = seed();
    mocks.subscribed = false;
    expect(await call(db, "publish_article", { articleId: A_GENERATED, confirm: true })).toMatchObject({
      ok: false,
      status: 402,
      error: { code: "subscription_required" },
    });
    expect(mocks.publishArticle).not.toHaveBeenCalled();
  });
});

describe("an article of another site is refused before anything happens", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["generate_article", { articleId: A_B, waitSeconds: 0 }],
    ["generate_article", { articleId: A_C, waitSeconds: 0 }],
    ["publish_article", { articleId: A_B, confirm: true }],
    ["publish_article", { articleId: A_C, confirm: true, acknowledgeQualityIssues: true }],
  ];
  it.each(cases)("%s %j", async (name, input) => {
    const db = seed();
    const before = customerData(db);
    const run = await call(db, name, input);
    expect(run).toMatchObject({
      ok: false,
      status: 404,
      error: { code: "not_found", message: "No article with that articleId on this site." },
    });
    expect(customerData(db)).toBe(before);
    expect(mocks.runJobNow).not.toHaveBeenCalled();
    expect(mocks.publishArticle).not.toHaveBeenCalled();
  });
});

describe("generate_article", () => {
  it("enqueues the production job Generate now enqueues, runs it, and answers after the wait while it keeps running", async () => {
    const db = seed();
    mocks.runJobNow.mockImplementation(() => new Promise(() => {}));

    const run = await call(db, "generate_article", { articleId: A_QUEUED, waitSeconds: 0 });

    expect(run).toMatchObject({ ok: true, output: { status: "pending", alreadyRunning: false, articleStatus: "queued" } });
    expect(db.tables.jobs).toHaveLength(1);
    const job = db.tables.jobs[0];
    expect(job).toMatchObject({
      user_id: USER,
      business_id: SITE_A,
      type: "produce-article",
      article_id: A_QUEUED,
      input: { articleId: A_QUEUED },
      priority: 10,
      max_attempts: 3,
    });
    expect(run.ok && run.output.jobId).toBe(job.id);
    expect(mocks.runJobNow).toHaveBeenCalledWith(db, job.id, 105_000);
    // The job kept alive after the answer, and the call's audit row.
    expect(mocks.afterTasks).toHaveLength(2);
  });

  it("follows the production job already queued or running instead of starting another", async () => {
    const db = seed();
    const running = uuid("e", 7);
    db.tables.jobs.push({
      id: running,
      user_id: USER,
      business_id: SITE_A,
      type: "produce-article",
      article_id: A_QUEUED,
      status: "running",
      created_at: "2026-11-09T08:00:00.000Z",
    });

    const run = await call(db, "generate_article", { articleId: A_QUEUED, waitSeconds: 0 });

    expect(run).toMatchObject({ ok: true, output: { jobId: running, status: "running", alreadyRunning: true } });
    expect(db.tables.jobs).toHaveLength(1);
    expect(mocks.runJobNow).not.toHaveBeenCalled();
  });

  it("refuses an article that is being generated, the way the route does", async () => {
    const db = seed();
    expect(await call(db, "generate_article", { articleId: A_GENERATING, waitSeconds: 0 })).toMatchObject({
      ok: false,
      status: 409,
      error: { code: "invalid_state", message: "Article is not in a generatable state" },
    });
    expect(db.tables.jobs).toEqual([]);
  });

  it("records the model cost of a job that finished while the call waited, and none for one still running", async () => {
    const db = seed();
    mocks.runJobNow.mockImplementation(async (_admin: unknown, jobId: string) => {
      Object.assign(db.tables.jobs.find((j) => j.id === jobId)!, { status: "completed", result: {} });
      db.tables.agent_runs.push({ job_id: jobId, cost_usd: 0.031 }, { job_id: jobId, cost_usd: 0.0125 });
      db.tables.articles.find((a) => a.id === A_GENERATED)!.status = "generated";
      return "completed";
    });

    const run = await call(db, "generate_article", { articleId: A_GENERATED, waitSeconds: 5 });
    expect(run).toMatchObject({ ok: true, output: { status: "completed", articleStatus: "generated" } });
    await vi.waitFor(() => expect(db.tables.tool_calls).toHaveLength(1));
    expect(db.tables.tool_calls[0]).toMatchObject({ tool: "generate_article", status: "ok", cost_usd: 0.0435, api_key_id: "key-1" });

    mocks.runJobNow.mockImplementation(() => new Promise(() => {}));
    await call(db, "generate_article", { articleId: A_QUEUED, waitSeconds: 0 });
    await vi.waitFor(() => expect(db.tables.tool_calls).toHaveLength(2));
    // Not measured is null, never 0.
    expect(db.tables.tool_calls[1]).toMatchObject({ tool: "generate_article", status: "ok", cost_usd: null });
  });
});

describe("publish_article", () => {
  it("refuses without confirm: true, before anything is read or written", async () => {
    const db = seed();
    for (const input of [{ articleId: A_GENERATED }, { articleId: A_GENERATED, confirm: false }]) {
      const run = await call(db, "publish_article", input);
      expect(run).toMatchObject({ ok: false, status: 400, error: { code: "invalid_input" } });
      expect(!run.ok && run.error.message).toBe("confirm: confirm must be true: this publishes the article on the live site.");
    }
    expect(mocks.ensureCanonical).not.toHaveBeenCalled();
    expect(mocks.publishArticle).not.toHaveBeenCalled();
  });

  it("publishes a generated article to its site's destination and answers the live URL", async () => {
    const db = seed();
    const run = await call(db, "publish_article", { articleId: A_GENERATED, confirm: true });
    expect(run).toEqual({
      ok: true,
      output: { articleId: A_GENERATED, url: "https://acme.test/blog/cited", republished: false },
    });
    expect(mocks.publishArticle).toHaveBeenCalledTimes(1);
    expect(mocks.publishArticle.mock.calls[0][0]).toMatchObject({
      articleId: A_GENERATED,
      userId: USER,
      businessId: SITE_A,
      canonical: CANONICAL,
      integration: { id: "int-a", business_id: SITE_A, user_id: USER },
    });
  });

  it("republishes a published article, updating its post", async () => {
    const db = seed();
    expect(await call(db, "publish_article", { articleId: A_PUBLISHED, confirm: true })).toMatchObject({
      ok: true,
      output: { republished: true },
    });
  });

  it("refuses an article waiting in needs_review without acknowledgeQualityIssues, naming what the checks found", async () => {
    const db = seed();
    const before = customerData(db);
    const run = await call(db, "publish_article", { articleId: A_REVIEW, confirm: true });
    expect(run).toMatchObject({ ok: false, status: 400, error: { code: "invalid_input" } });
    if (run.ok) throw new Error("expected a refusal");
    expect(run.error.message).toContain("waiting for review");
    expect(run.error.message).toContain("The answer is not in the first paragraph; Two headings repeat");
    expect(run.error.hint).toContain("acknowledgeQualityIssues: true");
    expect(customerData(db)).toBe(before);
    expect(mocks.publishArticle).not.toHaveBeenCalled();
  });

  it("publishes an article in needs_review once the issues are acknowledged, as pressing Publish does", async () => {
    const db = seed();
    mocks.ensureCanonical.mockResolvedValue({
      article: CANONICAL,
      decision: "review",
      issues: [{ code: "answer_first", message: "The answer is not in the first paragraph", action: "review" }],
    });
    const run = await call(db, "publish_article", { articleId: A_REVIEW, confirm: true, acknowledgeQualityIssues: true });
    expect(run).toMatchObject({ ok: true, output: { url: "https://acme.test/blog/cited" } });
    expect(mocks.publishArticle).toHaveBeenCalledTimes(1);
  });

  it("parks a generated article that fails the gates in needs_review instead of publishing it, acknowledged or not", async () => {
    const db = seed();
    mocks.ensureCanonical.mockResolvedValue({
      article: CANONICAL,
      decision: "review",
      issues: [
        { code: "answer_first", message: "The answer is not in the first paragraph", action: "review" },
        { code: "long_title", message: "The title is long", action: "warn" },
      ],
    });
    const run = await call(db, "publish_article", { articleId: A_GENERATED, confirm: true, acknowledgeQualityIssues: true });
    expect(run).toMatchObject({ ok: false, status: 409, error: { code: "invalid_state" } });
    expect(!run.ok && run.error.message).toContain("moved to needs_review and nothing was published");
    expect(db.tables.articles.find((a) => a.id === A_GENERATED)).toMatchObject({
      status: "needs_review",
      last_error: "The answer is not in the first paragraph",
    });
    expect(mocks.publishArticle).not.toHaveBeenCalled();
  });

  it("refuses while production is still running, and without a destination", async () => {
    const db = seed();
    db.tables.jobs.push({ id: uuid("e", 1), user_id: USER, business_id: SITE_A, type: "produce-article", article_id: A_GENERATED, status: "running" });
    expect(await call(db, "publish_article", { articleId: A_GENERATED, confirm: true })).toMatchObject({
      ok: false,
      status: 409,
      error: { code: "invalid_state", message: "This article is still being produced. Try again in a minute." },
    });

    db.tables.jobs.length = 0;
    db.tables.integrations.length = 0;
    expect(await call(db, "publish_article", { articleId: A_GENERATED, confirm: true })).toMatchObject({
      ok: false,
      status: 409,
      error: { code: "prerequisite_missing", hint: expect.stringContaining("Settings → Connections") },
    });
    expect(mocks.publishArticle).not.toHaveBeenCalled();
  });

  it("answers delivery_failed when the customer's site rejects the article", async () => {
    const db = seed();
    mocks.publishArticle.mockResolvedValue({ ok: false, error: "HTTP 500 from the webhook" });
    expect(await call(db, "publish_article", { articleId: A_GENERATED, confirm: true })).toMatchObject({
      ok: false,
      status: 502,
      error: { code: "delivery_failed", message: "Your site rejected the article: HTTP 500 from the webhook" },
    });
  });

  it("refuses an article that was never generated", async () => {
    const db = seed();
    expect(await call(db, "publish_article", { articleId: A_QUEUED, confirm: true })).toMatchObject({
      ok: false,
      status: 409,
      error: { code: "invalid_state", message: "Article must be generated before it can be published" },
    });
  });
});
