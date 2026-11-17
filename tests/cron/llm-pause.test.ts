import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "../support/fake-supabase";

/**
 * The crons that enqueue model work do not while the LLM layer is paused for
 * billing: the work would only wait behind the pause, and discovery would pay
 * for searches nobody can judge. Without a pause they enqueue as before.
 */

const state = vi.hoisted(() => ({
  db: null as unknown,
  discoveries: 0,
  enqueued: 0,
  ticks: 0,
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db }));
vi.mock("@sentry/nextjs", () => ({ captureException: () => {}, captureMessage: () => {} }));

vi.mock("@/lib/providers/discovery/registry", () => ({
  getDiscoveryProviders: () => [{ name: "web", search: async () => [] }],
}));
vi.mock("@/lib/placements/runs", () => ({
  startDiscovery: async () => {
    state.discoveries += 1;
    return { alreadyRunning: false, jobId: "job-1" };
  },
}));

vi.mock("@/lib/jobs/queue", () => ({
  enqueueJob: async () => {
    state.enqueued += 1;
    return "job-1";
  },
  hasActiveJob: async () => false,
}));
vi.mock("@/lib/jobs/worker", () => ({
  tick: async () => {
    state.ticks += 1;
    return { claimed: 0, outcomes: { completed: 0, failed: 0, retrying: 0, yielded: 0 }, paused: 0, pausedUntil: null };
  },
}));

import { GET as discoverPlacements } from "@/app/api/cron/discover-placements/route";
import { GET as generateArticles } from "@/app/api/cron/generate-articles/route";

function cronRequest(path: string) {
  return new Request(`https://gettrafficfa.st${path}`, {
    headers: { authorization: "Bearer cron-test" },
  }) as unknown as Parameters<typeof generateArticles>[0];
}

const today = new Date().toISOString().slice(0, 10);

function seed(paused: boolean): FakeSupabase {
  return new FakeSupabase({
    provider_pauses: paused
      ? [{ kind: "llm", paused_until: new Date(Date.now() + 3_600_000).toISOString() }]
      : [],
    businesses: [{ id: "biz-1", user_id: "user-1" }],
    // A paying owner: generation produces only for those (generate-articles-paid.test.ts).
    subscriptions: [{ user_id: "user-1", status: "active", current_period_end: null }],
    articles: [
      { id: "a-1", user_id: "user-1", business_id: "biz-1", status: "queued", attempt_count: 0, scheduled_date: today },
    ],
  });
}

describe("crons under the LLM billing pause", () => {
  beforeEach(() => {
    vi.stubEnv("CRON_SECRET", "cron-test");
    state.discoveries = 0;
    state.enqueued = 0;
    state.ticks = 0;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("discover-placements enqueues nothing, so no search is paid for", async () => {
    state.db = seed(true);
    const res = await discoverPlacements(cronRequest("/api/cron/discover-placements"));
    const body = await res.json();
    expect(body).toMatchObject({ enqueued: 0, skipped: "llm_billing_paused" });
    expect(state.discoveries).toBe(0);
  });

  it("discover-placements enqueues as usual without a pause", async () => {
    state.db = seed(false);
    await discoverPlacements(cronRequest("/api/cron/discover-placements"));
    expect(state.discoveries).toBe(1);
  });

  it("generate-articles leaves due articles queued and runs no tick, but still publishes", async () => {
    const db = seed(true);
    state.db = db;
    const res = await generateArticles(cronRequest("/api/cron/generate-articles"));
    const body = await res.json();
    expect(state.enqueued).toBe(0);
    expect(state.ticks).toBe(0);
    expect(body.generation).toMatchObject({ enqueued: 0, skipped: "llm_billing_paused" });
    expect(body.publishing).toBeDefined();
    expect(db.tables.articles[0].status).toBe("queued");
    expect(db.tables.articles[0].attempt_count).toBe(0);
  });

  it("generate-articles enqueues due articles without a pause", async () => {
    state.db = seed(false);
    await generateArticles(cronRequest("/api/cron/generate-articles"));
    expect(state.enqueued).toBe(1);
    expect(state.ticks).toBe(1);
  });

  it("refuses a request without the cron secret", async () => {
    state.db = seed(false);
    const res = await discoverPlacements(
      new Request("https://gettrafficfa.st/api/cron/discover-placements") as unknown as Parameters<typeof discoverPlacements>[0]
    );
    expect(res.status).toBe(401);
    expect(state.discoveries).toBe(0);
  });
});
