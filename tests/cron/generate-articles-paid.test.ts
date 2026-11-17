import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "../support/fake-supabase";

/**
 * The generation cron produces only for owners with paid access: it runs on
 * the service role, where the screens' paywall does not reach, and every
 * article it enqueues is one the platform pays to write. A lapsed account's
 * due articles stay `queued`, untouched, and are logged as skipped, one line
 * per business. Its backlog cannot keep paying accounts out of the run.
 */

const state = vi.hoisted(() => ({ db: null as unknown, enqueued: [] as string[] }));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db }));
vi.mock("@sentry/nextjs", () => ({ captureException: () => {}, captureMessage: () => {} }));
vi.mock("@/lib/jobs/queue", () => ({
  enqueueJob: async ({ articleId }: { articleId: string }) => {
    state.enqueued.push(articleId);
    return `job-${articleId}`;
  },
  hasActiveJob: async () => false,
}));
vi.mock("@/lib/jobs/worker", () => ({
  tick: async () => ({ claimed: 0, outcomes: { completed: 0, failed: 0, retrying: 0, yielded: 0 }, paused: 0, pausedUntil: null }),
}));

import { GET as generateArticles } from "@/app/api/cron/generate-articles/route";

const cronRequest = () =>
  new Request("https://gettrafficfa.st/api/cron/generate-articles", {
    headers: { authorization: "Bearer cron-test" },
  }) as unknown as Parameters<typeof generateArticles>[0];

const today = new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

function due(id: string, userId: string, businessId: string, scheduledDate = today) {
  return { id, user_id: userId, business_id: businessId, status: "queued", attempt_count: 0, scheduled_date: scheduledDate };
}

let logs: Array<Record<string, unknown>> = [];
const skippedLines = () => logs.filter((line) => line.phase === "generation" && typeof line.skipped === "string");

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "cron-test");
  state.enqueued = [];
  logs = [];
  const capture = (raw: unknown) => {
    try {
      logs.push(JSON.parse(String(raw)));
    } catch {
      // not one of the cron's JSON lines
    }
  };
  vi.spyOn(console, "log").mockImplementation(capture);
  vi.spyOn(console, "warn").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("generate-articles only produces for paying owners", () => {
  it("enqueues a subscriber's due article and skips a lapsed owner's, leaving it queued", async () => {
    const db = new FakeSupabase({
      subscriptions: [
        { user_id: "paid", status: "active", current_period_end: inDays(20) },
        { user_id: "lapsed", status: "canceled", current_period_end: inDays(-3) },
      ],
      articles: [due("a-lapsed", "lapsed", "biz-l", daysAgo(2)), due("a-paid", "paid", "biz-p")],
    });
    state.db = db;

    const body = await (await generateArticles(cronRequest())).json();

    expect(state.enqueued).toEqual(["a-paid"]);
    expect(body.generation).toMatchObject({ enqueued: 1, skipped_unpaid: { businesses: 1, articles_seen: 1 } });
    const lapsed = db.tables.articles.find((a) => a.id === "a-lapsed");
    expect(lapsed).toMatchObject({ status: "queued", attempt_count: 0 });
    expect(skippedLines()).toEqual([
      expect.objectContaining({ skipped: "no_active_subscription", user_id: "lapsed", business_id: "biz-l", due_articles_seen: 1 }),
    ]);
  });

  it("counts a trial, and an active row with no period end, as paid; an ended period as not", async () => {
    state.db = new FakeSupabase({
      subscriptions: [
        { user_id: "trial", status: "trialing", current_period_end: null },
        { user_id: "open", status: "active", current_period_end: null },
        { user_id: "ended", status: "active", current_period_end: inDays(-1) },
        { user_id: "late", status: "past_due", current_period_end: inDays(10) },
      ],
      articles: [
        due("a-trial", "trial", "biz-t"),
        due("a-open", "open", "biz-o"),
        due("a-ended", "ended", "biz-e"),
        due("a-late", "late", "biz-x"),
        due("a-none", "nobody", "biz-n"),
      ],
    });

    await generateArticles(cronRequest());

    expect(state.enqueued.sort()).toEqual(["a-open", "a-trial"]);
    expect(skippedLines().map((line) => line.user_id).sort()).toEqual(["ended", "late", "nobody"]);
  });

  it("does not let a lapsed account's backlog keep paying accounts out of the run", async () => {
    // 40 old due articles of a lapsed account, older than everything else:
    // they fill the first page entirely.
    const backlog = Array.from({ length: 40 }, (_, i) => due(`old-${i}`, "lapsed", "biz-l", daysAgo(60 - i)));
    const paid = Array.from({ length: 7 }, (_, i) => due(`new-${i}`, "paid", "biz-p", daysAgo(5 - (i % 5))));
    state.db = new FakeSupabase({
      subscriptions: [{ user_id: "paid", status: "active", current_period_end: null }],
      articles: [...backlog, ...paid],
    });

    const body = await (await generateArticles(cronRequest())).json();

    // At most MAX_ARTICLES_PER_RUN (5), all from the paying owner.
    expect(state.enqueued).toHaveLength(5);
    expect(state.enqueued.every((id) => id.startsWith("new-"))).toBe(true);
    // One subscription read for the lapsed owner, however many rows it has.
    expect(skippedLines()).toHaveLength(1);
    expect(body.generation.skipped_unpaid.businesses).toBe(1);
  });

  it("fails closed with its own reason when a subscription cannot be read", async () => {
    const db = new FakeSupabase({ articles: [due("a-1", "user-1", "biz-1")] });
    const from = db.from.bind(db);
    db.from = ((table: string) => {
      if (table !== "subscriptions") return from(table);
      const failing = {
        select: () => failing,
        eq: () => failing,
        in: async () => ({ data: null, error: { message: "connection reset" } }),
      };
      return failing;
    }) as typeof db.from;
    state.db = db;

    await generateArticles(cronRequest());

    expect(state.enqueued).toEqual([]);
    expect(skippedLines()).toEqual([
      expect.objectContaining({ level: "warn", skipped: "subscription_unreadable", user_id: "user-1", business_id: "biz-1" }),
    ]);
    expect(db.tables.articles[0].status).toBe("queued");
  });
});

describe("generate-articles and the account's daily AI spend limit", () => {
  const spent = (userId: string, usd: number) => ({
    user_id: userId,
    agent: "writing",
    model: "gemini-2.5-flash",
    cost_usd: usd,
    created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  });

  it("leaves an owner at the limit out of the run, queued and logged with its own reason; their backlog cannot hold the slots", async () => {
    const capped = Array.from({ length: 30 }, (_, i) => due(`capped-${i}`, "capped", "biz-c", daysAgo(40 - i)));
    const db = new FakeSupabase({
      subscriptions: [
        { user_id: "capped", status: "active", current_period_end: inDays(20) },
        { user_id: "paid", status: "active", current_period_end: inDays(20) },
      ],
      agent_runs: [spent("capped", 5.2), spent("paid", 1)],
      articles: [...capped, due("a-paid", "paid", "biz-p")],
    });
    state.db = db;

    const body = await (await generateArticles(cronRequest())).json();

    expect(state.enqueued).toEqual(["a-paid"]);
    expect(body.generation).toMatchObject({ enqueued: 1, skipped_spend_cap: { businesses: 1 }, skipped_unpaid: { businesses: 0 } });
    expect(skippedLines()).toEqual([
      expect.objectContaining({ skipped: "spend_cap_reached", user_id: "capped", business_id: "biz-c", level: "info" }),
    ]);
    expect(db.tables.articles.filter((a) => a.user_id === "capped").every((a) => a.status === "queued")).toBe(true);
  });
});
