import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "../support/fake-supabase";

/**
 * The Autopilot sweep and the kind of search a topic answers: the top-up is
 * asked for the mix with the names the site's own data holds, buys no
 * comparison of a product the data never named, stores each topic's intent
 * and no volume for the new kinds, and writes the rules' verdict on topics
 * stored before intents were. One suggestion call, as before: no new paid
 * call per topic.
 */

const state = vi.hoisted(() => ({ db: null as unknown, calls: [] as unknown[][] }));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db }));
vi.mock("@sentry/nextjs", () => ({ captureException: () => {}, captureMessage: () => {} }));
vi.mock("@/lib/research/keywords", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/research/keywords")>()),
  generateKeywordsFromBusiness: async (...args: unknown[]) => {
    state.calls.push(args);
    const base = { competition: "Medium", difficulty: 40, opportunity: "High", cpc: 3 };
    return [
      { keyword: "Jasper alternatives", searchVolume: 900, intent: "comparison", ...base },
      { keyword: "Fooly vs Jasper", searchVolume: 500, intent: "comparison", ...base },
      { keyword: "how to connect WordPress to Search Console", searchVolume: 300, intent: "platform_howto", ...base },
      { keyword: "why does my blog get no traffic", searchVolume: 700, intent: "problem", ...base },
      { keyword: "ai seo content workflow", searchVolume: 1000, intent: "product_adjacent", ...base },
    ];
  },
}));

import { GET as autopilot } from "@/app/api/cron/autopilot/route";

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
const own = { user_id: "owner", business_id: "biz" };

function seed(): FakeSupabase {
  return new FakeSupabase({
    subscriptions: [{ user_id: "owner", status: "active", current_period_end: inDays(20) }],
    businesses: [
      {
        id: "biz",
        user_id: "owner",
        name: "Acme",
        niche: "AI SEO",
        description: "AI SEO content",
        website_url: "https://acme.test",
        content_language: "en",
        automation_settings: { enabled: true, keywordFloor: 10, bufferDays: 3 },
      },
    ],
    entities: [
      { ...own, name: "Jasper", type: "product", article_entities: [{ count: 2 }] },
      { ...own, name: "WordPress", type: "product", article_entities: [{ count: 3 }] },
    ],
    competitors: [],
    aeo_probes: [],
    placement_targets: [],
    keywords: [
      { id: "old-1", ...own, keyword: "best ai writing tools", status: "available", article_id: null, intent: null, opportunity: "Low", difficulty: 90 },
    ],
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
  state.calls = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the Autopilot sweep and the mix of searches", () => {
  it("asks once, with the names the site's data holds", async () => {
    state.db = seed();
    await call();
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0][4]).toEqual({ businessName: "Acme", names: ["WordPress", "Jasper"] });
  });

  it("buys no comparison of a product the data never named, and says so", async () => {
    const db = seed();
    state.db = db;
    const body = await call();
    const stored = (db.tables.keywords ?? []).map((k) => k.keyword);
    expect(stored).not.toContain("Fooly vs Jasper");
    expect(stored).toContain("Jasper alternatives");
    expect(JSON.stringify(body.notes)).toContain("naming a product the site's data does not");
  });

  it("stores each topic's intent, and no volume for a comparison, a how-to or a problem", async () => {
    const db = seed();
    state.db = db;
    await call();
    const row = (keyword: string) => (db.tables.keywords ?? []).find((k) => k.keyword === keyword);
    expect(row("Jasper alternatives")).toMatchObject({ intent: "comparison", search_volume: null, cpc: null, source: "autopilot" });
    expect(row("how to connect WordPress to Search Console")).toMatchObject({ intent: "platform_howto", search_volume: null });
    expect(row("why does my blog get no traffic")).toMatchObject({ intent: "problem", search_volume: null });
    expect(row("ai seo content workflow")).toMatchObject({ intent: "product_adjacent", search_volume: 1000 });
  });

  it("writes the rules' verdict on a topic stored before intents were", async () => {
    const db = seed();
    state.db = db;
    await call();
    expect((db.tables.keywords ?? []).find((k) => k.id === "old-1")).toMatchObject({ intent: "comparison" });
  });

  it("fills the buffer's days with the mix, not by score alone", async () => {
    const db = seed();
    state.db = db;
    await call();
    const scheduledIds = new Set((db.tables.articles ?? []).filter((a) => a.business_id === "biz").map((a) => a.keyword_id));
    const kinds = (db.tables.keywords ?? []).filter((k) => scheduledIds.has(k.id)).map((k) => k.intent);
    // Three free days: a problem, a how-to and a comparison, before the higher-scored core topic.
    expect(kinds.sort()).toEqual(["comparison", "platform_howto", "problem"]);
  });
});
