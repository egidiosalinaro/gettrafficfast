import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "../support/fake-supabase";

/**
 * The Autopilot sweep and "Questions people ask": with Autopilot on, a
 * paying owner's site gets up to 3 questions a day in its pool before
 * scheduling, so they count as fuel; with Autopilot off nothing is added.
 * Keywords the sweep buys are stored with source "autopilot", for the
 * Content screen to say where they came from.
 */

const state = vi.hoisted(() => ({ db: null as unknown, keywordCalls: 0 }));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db }));
vi.mock("@sentry/nextjs", () => ({ captureException: () => {}, captureMessage: () => {} }));
vi.mock("@/lib/research/keywords", () => ({
  generateKeywordsFromBusiness: async () => {
    state.keywordCalls += 1;
    return [{ keyword: "loyalty program ideas for shops", opportunity: "High", difficulty: 20, searchVolume: 100 }];
  },
}));

import { GET as autopilot } from "@/app/api/cron/autopilot/route";

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

function thread(id: string, businessId: string, title: string) {
  return {
    id,
    user_id: businessId === "biz-on" ? "owner-on" : "owner-off",
    business_id: businessId,
    url: `https://www.reddit.com/r/shops/comments/${id}/`,
    title,
    surface: "reddit",
    kind: "thread",
    community: "r/shops",
    status: "qualified",
    qualified_by: "agent",
    qualify_score: 80,
    intent: "question",
    posted_at: "2026-11-01T00:00:00.000Z",
    created_at: "2026-11-02T00:00:00.000Z",
  };
}

const QUESTIONS = [
  "How do I win back customers who stopped buying?",
  "Is SMS marketing worth it for a small shop?",
  "Which email platform is best for a Shopify store?",
  "What is a good repeat purchase rate for a small shop?",
];

function seed(floor: number): FakeSupabase {
  return new FakeSupabase({
    subscriptions: [
      { user_id: "owner-on", status: "active", current_period_end: inDays(20) },
      { user_id: "owner-off", status: "active", current_period_end: inDays(20) },
    ],
    businesses: [
      { id: "biz-on", user_id: "owner-on", niche: "ecommerce", description: "on", website_url: "https://on.test", content_language: "en", automation_settings: { enabled: true, keywordFloor: floor } },
      { id: "biz-off", user_id: "owner-off", niche: "ecommerce", description: "off", website_url: "https://off.test", content_language: "en", automation_settings: { enabled: false } },
    ],
    placement_targets: [
      ...QUESTIONS.map((q, i) => thread(`on-${i}`, "biz-on", q)),
      ...QUESTIONS.map((q, i) => thread(`off-${i}`, "biz-off", q)),
    ],
    keywords: [],
    provider_pauses: [],
  });
}

async function call(): Promise<Record<string, unknown>> {
  const request = new Request("https://gettrafficfa.st/api/cron/autopilot", { headers: { authorization: "Bearer cron-test" } });
  const response = await autopilot(request as never);
  return (await response.json()) as Record<string, unknown>;
}

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "cron-test");
  state.keywordCalls = 0;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the Autopilot sweep and questions people ask", () => {
  it("adds up to 3 to a site with Autopilot on, none to one with it off", async () => {
    const db = seed(0);
    state.db = db;
    const body = await call();

    expect(body).toMatchObject({ questionsAdded: 3 });
    const questions = (db.tables.keywords ?? []).filter((k) => k.source === "question");
    expect(questions).toHaveLength(3);
    expect(questions.every((k) => k.business_id === "biz-on" && k.search_volume === null && k.difficulty === null)).toBe(true);
  });

  it("schedules from them in the same run: they are fuel like any topic", async () => {
    const db = seed(0);
    state.db = db;
    await call();
    const scheduled = (db.tables.articles ?? []).filter((a) => a.business_id === "biz-on");
    expect(scheduled).toHaveLength(3);
    // Floor 0: nothing was bought, the questions filled the days.
    expect(state.keywordCalls).toBe(0);
  });

  it("stores what it buys as Autopilot's", async () => {
    const db = seed(10);
    state.db = db;
    await call();
    expect(state.keywordCalls).toBe(1);
    expect((db.tables.keywords ?? []).find((k) => k.keyword === "loyalty program ideas for shops")).toMatchObject({
      source: "autopilot",
      business_id: "biz-on",
    });
  });
});
