import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "../support/fake-supabase";

/**
 * The daily run's publishing phase after it moved to
 * lib/articles/publish-ready.ts: the same rules as before. Every due
 * `generated` article, oldest first, including a failed delivery (the daily
 * retry); not one still producing, not needs_review, not a future date; no
 * destination counted rather than guessed; a back-link pass after a first
 * publish; the same response shape.
 */

const state = vi.hoisted(() => ({ db: null as unknown, publishArticle: vi.fn(), backlinks: [] as string[] }));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db }));
vi.mock("@sentry/nextjs", () => ({ captureException: () => {}, captureMessage: () => {} }));
vi.mock("@/lib/jobs/worker", () => ({
  tick: async () => ({ claimed: 0, outcomes: { completed: 0, failed: 0, retrying: 0, yielded: 0 }, paused: 0, pausedUntil: null }),
}));
vi.mock("@/lib/content/service", () => ({
  ensureCanonical: async ({ article }: { article: { canonical: unknown } }) =>
    article.canonical
      ? { article: article.canonical, decision: "publish", issues: [] }
      : { article: null, decision: "needs_review", issues: [{ code: "EMPTY", action: "block", message: "Empty body" }] },
  publishArticle: (...args: unknown[]) => state.publishArticle(...args),
}));
vi.mock("@/lib/jobs/workflows/backlink-article", () => ({
  enqueueBacklinkPass: async ({ articleId }: { articleId: string }) => {
    state.backlinks.push(articleId);
    return null;
  },
}));

import { GET as generateArticles } from "@/app/api/cron/generate-articles/route";

const cronRequest = () =>
  new Request("https://gettrafficfa.st/api/cron/generate-articles", {
    headers: { authorization: "Bearer cron-test" },
  }) as unknown as Parameters<typeof generateArticles>[0];

const today = new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

function generated(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    user_id: "u-1",
    business_id: "biz-1",
    keyword_id: `kw-${id}`,
    status: "generated",
    content: "<p>Answer.</p>",
    canonical: { bodyHtml: "<p>Answer.</p>" },
    scheduled_date: today,
    last_error: null,
    publish_claimed_at: null,
    // Older than the tick's window: the daily run reads every due article.
    updated_at: new Date(Date.now() - 10 * 86_400_000).toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "cron-test");
  state.backlinks = [];
  state.publishArticle.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("generate-articles publishing phase", () => {
  it("applies the same rules as before and answers with the same counters", async () => {
    const db = new FakeSupabase({
      articles: [
        generated("ready"),
        generated("retry", { scheduled_date: daysAgo(3), last_error: "publish: 503 from the site" }),
        generated("producing"),
        generated("no-site", { business_id: null }),
        generated("other-site", { business_id: "biz-2" }),
        generated("empty", { canonical: null }),
        generated("future", { scheduled_date: inDays(2) }),
        generated("review", { status: "needs_review" }),
      ],
      jobs: [{ id: "job-p", article_id: "producing", type: "produce-article", status: "running" }],
      integrations: [{ id: "int-1", user_id: "u-1", business_id: "biz-1", type: "webhook", status: "connected", created_at: "2026-10-01" }],
    });
    state.db = db;
    state.publishArticle.mockImplementation(async ({ articleId }: { articleId: string }) => {
      const row = db.tables.articles.find((a) => a.id === articleId)!;
      if (articleId === "retry") return { ok: false, error: "503 from the site" };
      row.status = "published";
      return { ok: true, url: `https://acme.test/${articleId}`, externalId: "p-1" };
    });

    const body = await (await generateArticles(cronRequest())).json();

    expect(body.publishing).toEqual({
      published: 1,
      retry_pending: 1,
      needs_review: 1,
      no_destination: 2,
      still_producing: 1,
      claimed_elsewhere: 0,
    });
    // Oldest first: the failed delivery from three days ago is retried first.
    expect(state.publishArticle.mock.calls.map(([p]) => (p as { articleId: string }).articleId)).toEqual(["retry", "ready"]);
    expect(state.backlinks).toEqual(["ready"]);
    const status = (id: string) => db.tables.articles.find((a) => a.id === id)?.status;
    expect(status("retry")).toBe("generated");
    expect(status("empty")).toBe("needs_review");
    expect(status("future")).toBe("generated");
    expect(status("review")).toBe("needs_review");
    expect(db.tables.articles.every((a) => a.publish_claimed_at === null)).toBe(true);
  });
});
