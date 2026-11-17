import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "../support/fake-supabase";

/**
 * /api/jobs/tick publishes what has just become ready after running the
 * jobs: the 2026-11-10 article, whose production finished at 08:08 after the
 * daily run's publishing phase, is published by the next tick instead of
 * waiting a day. The tick is quiet when it published or failed nothing.
 */

const state = vi.hoisted(() => ({ db: null as unknown, publishArticle: vi.fn(), tickRan: 0 }));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db }));
vi.mock("@sentry/nextjs", () => ({ captureException: () => {}, captureMessage: () => {} }));
vi.mock("@/lib/jobs/worker", () => ({
  tick: async (db: FakeSupabase) => {
    state.tickRan++;
    // The production job finishes inside this tick.
    for (const job of db.tables.jobs) job.status = "completed";
    return { claimed: 1, outcomes: { completed: 1, failed: 0, retrying: 0, yielded: 0 }, paused: 0, pausedUntil: null };
  },
}));
vi.mock("@/lib/content/service", () => ({
  ensureCanonical: async () => ({ article: { bodyHtml: "<p>Answer.</p>" }, decision: "publish", issues: [] }),
  publishArticle: (...args: unknown[]) => state.publishArticle(...args),
}));
vi.mock("@/lib/jobs/workflows/backlink-article", () => ({ enqueueBacklinkPass: async () => null }));

import { GET as tickRoute } from "@/app/api/jobs/tick/route";

const today = new Date().toISOString().slice(0, 10);
const request = () =>
  new Request("https://gettrafficfa.st/api/jobs/tick", {
    headers: { authorization: "Bearer cron-test" },
  }) as unknown as Parameters<typeof tickRoute>[0];

let lines: string[] = [];

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "cron-test");
  state.tickRan = 0;
  lines = [];
  state.publishArticle.mockReset();
  state.publishArticle.mockImplementation(async ({ articleId }: { articleId: string }) => {
    const row = (state.db as FakeSupabase).tables.articles.find((a) => a.id === articleId)!;
    row.status = "published";
    return { ok: true, url: "https://acme.test/ai-blog-writer-for-seo", externalId: "p-1" };
  });
  const capture = (raw: unknown) => lines.push(String(raw));
  vi.spyOn(console, "log").mockImplementation(capture);
  vi.spyOn(console, "warn").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function seed(jobStatus: string) {
  state.db = new FakeSupabase({
    articles: [
      {
        id: "a-1",
        user_id: "u-1",
        business_id: "biz-1",
        keyword_id: "kw-1",
        status: "generated",
        content: "<p>Answer.</p>",
        canonical: { bodyHtml: "<p>Answer.</p>" },
        scheduled_date: today,
        last_error: null,
        publish_claimed_at: null,
        updated_at: new Date(Date.now() - 2 * 60_000).toISOString(),
      },
    ],
    jobs: [{ id: "job-1", article_id: "a-1", type: "produce-article", status: jobStatus }],
    integrations: [{ id: "int-1", user_id: "u-1", business_id: "biz-1", type: "webhook", status: "connected", created_at: "2026-10-01" }],
  });
  return state.db as FakeSupabase;
}

describe("/api/jobs/tick publishing", () => {
  it("runs the jobs, then publishes the article whose production just finished", async () => {
    const db = seed("running");

    const response = await tickRoute(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(state.tickRan).toBe(1);
    expect(body).toMatchObject({ claimed: 1, publishing: { published: 1 } });
    expect(db.tables.articles[0].status).toBe("published");
    expect(lines.some((line) => line.includes('"phase":"publish_done"'))).toBe(true);
  });

  it("logs nothing when there is nothing to publish", async () => {
    seed("running");
    (state.db as FakeSupabase).tables.articles[0].status = "published";

    const body = await (await tickRoute(request())).json();

    expect(body.publishing).toMatchObject({ published: 0, retry_pending: 0 });
    expect(state.publishArticle).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
  });

  it("refuses a request without the cron secret", async () => {
    seed("running");
    const response = await tickRoute(new Request("https://gettrafficfa.st/api/jobs/tick") as never);
    expect(response.status).toBe(401);
    expect(state.tickRan).toBe(0);
  });
});
