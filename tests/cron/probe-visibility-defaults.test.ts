import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "../support/fake-supabase";

/**
 * The AI Visibility scheduler with the weekly cadence on by default
 * (2026-11-24): a site with nothing stored is due, a site that chose off is
 * never touched, a site that never had a prompt gets its set from its own
 * keywords (free), a site that emptied its set after a run is left empty,
 * and at most 50 runs start a day.
 */

const state = vi.hoisted(() => ({ db: null as unknown, started: [] as string[] }));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db }));
vi.mock("@sentry/nextjs", () => ({ captureException: () => {}, captureMessage: () => {} }));
vi.mock("@/lib/providers/citations/registry", () => ({
  getCitationProviders: () => [{ name: "perplexity", probe: async () => ({ engine: "perplexity", answer: "", sources: [] }) }],
}));
vi.mock("@/lib/visibility/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/visibility/store")>()),
  hasActiveRun: async () => false,
  startRun: async ({ businessId }: { businessId: string }) => {
    state.started.push(businessId);
    return { runId: "run-1", jobId: "job-1" };
  },
}));

import { GET as probeVisibility } from "@/app/api/cron/probe-visibility/route";

type Handler = (request: never) => Promise<Response>;

async function run(): Promise<Record<string, unknown>> {
  const request = new Request("https://app.example.test/api/cron/probe-visibility", { headers: { authorization: "Bearer cron-test" } });
  const response = await (probeVisibility as Handler)(request as never);
  return (await response.json()) as Record<string, unknown>;
}

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
const site = (id: string, aeo: unknown, createdAt = "2026-10-01T00:00:00.000Z") => ({ id, user_id: "owner", aeo_settings: aeo, created_at: createdAt });

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "cron-test");
  state.started = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("probe-visibility with the weekly cadence on by default", () => {
  it("runs a site with nothing stored, seeds a never-set-up site from its keywords, and leaves an opted-out or emptied one alone", async () => {
    const db = new FakeSupabase({
      subscriptions: [{ user_id: "owner", status: "active", current_period_end: inDays(20) }],
      businesses: [
        site("biz-default", {}),
        site("biz-fresh", null),
        site("biz-off", { cadence: "off" }),
        site("biz-emptied", {}),
      ],
      aeo_runs: [{ id: "r-old", business_id: "biz-emptied", started_at: "2026-10-01T00:00:00.000Z" }],
      aeo_queries: [
        { id: "q1", business_id: "biz-default", user_id: "owner", query: "best tool for x", enabled: true },
        { id: "q-off", business_id: "biz-off", user_id: "owner", query: "asked by hand", enabled: true },
      ],
      keywords: [
        { id: "k1", business_id: "biz-fresh", keyword: "invoice software for freelancers", created_at: "2026-10-02T00:00:00.000Z" },
        { id: "k2", business_id: "biz-fresh", keyword: "how to send an invoice", created_at: "2026-10-03T00:00:00.000Z" },
        { id: "k3", business_id: "biz-emptied", keyword: "not imported again", created_at: "2026-10-03T00:00:00.000Z" },
      ],
    });
    state.db = db;

    const body = await run();

    expect(state.started.sort()).toEqual(["biz-default", "biz-fresh"]);
    expect(body).toMatchObject({ started: 2, seeded: 1 });
    const fresh = db.tables.aeo_queries.filter((q) => q.business_id === "biz-fresh");
    expect(fresh.map((q) => q.query).sort()).toEqual(["how to send an invoice", "invoice software for freelancers"]);
    expect(fresh.every((q) => q.source === "keyword" && q.cluster === "keywords")).toBe(true);
    expect(db.tables.aeo_queries.filter((q) => q.business_id === "biz-emptied")).toEqual([]);
  });

  it("starts at most 50 runs a day, oldest sites first", async () => {
    const ids = Array.from({ length: 55 }, (_, i) => `biz-${String(i).padStart(2, "0")}`);
    state.db = new FakeSupabase({
      subscriptions: [{ user_id: "owner", status: "active", current_period_end: inDays(20) }],
      businesses: ids.map((id, i) => site(id, {}, new Date(Date.UTC(2026, 0, 1 + i)).toISOString())).reverse(),
      aeo_runs: [],
      aeo_queries: ids.map((id) => ({ id: `q-${id}`, business_id: id, user_id: "owner", query: "a question", enabled: true })),
      keywords: [],
    });

    const body = await run();

    expect(body.started).toBe(50);
    expect(state.started).toEqual(ids.slice(0, 50));
  });
});
