import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "../support/fake-supabase";

/**
 * Every per-customer cron that spends works only for owners who pay
 * (`hasPaidAccess`, the paywall's rule on the service role): autopilot
 * (keyword generation is a model call, and every article it schedules is
 * one the platform pays to write), probe-visibility (paid answer-engine
 * probes), probe-citations (the same), refresh-articles (a SERP lookup, then
 * a model rewrite) and discover-placements (searches, then a model). A
 * lapsed owner's work is skipped and logged, one line per owner, as
 * `cron.unpaid_skipped`; a paying owner's runs as before.
 */

const state = vi.hoisted(() => ({
  db: null as unknown,
  keywordCalls: [] as string[],
  started: [] as string[],
  probed: [] as string[],
  measured: [] as string[],
  enqueued: [] as string[],
  discoveries: [] as string[],
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db }));
vi.mock("@sentry/nextjs", () => ({ captureException: () => {}, captureMessage: () => {} }));

vi.mock("@/lib/research/keywords", () => ({
  generateKeywordsFromBusiness: async (_niche: string, description: string) => {
    state.keywordCalls.push(description);
    return [{ keyword: `fresh keyword for ${description}`, opportunity: "High", difficulty: 20, searchVolume: 100 }];
  },
}));

vi.mock("@/lib/providers/citations/registry", () => ({
  getCitationProviders: () => [
    {
      name: "perplexity",
      probe: async ({ query }: { query: string }) => {
        state.probed.push(query);
        return { engine: "perplexity", answer: "an answer", sources: [] };
      },
    },
  ],
}));
vi.mock("@/lib/visibility/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/visibility/store")>()),
  hasActiveRun: async () => false,
  startRun: async ({ businessId }: { businessId: string }) => {
    state.started.push(businessId);
    return { runId: "run-1", jobId: "job-1" };
  },
}));
vi.mock("@/lib/lifecycle/citations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/lifecycle/citations")>()),
  recordCitationProbe: async () => {},
}));

vi.mock("@/lib/providers/serp/registry", () => ({ getSerpProvider: () => ({ name: "serper" }) }));
vi.mock("@/lib/intelligence/serp", () => ({
  ensureSerpSnapshot: async ({ keyword }: { keyword: string }) => {
    state.measured.push(keyword);
    return { data: { results: [] } };
  },
}));
vi.mock("@/lib/lifecycle/rank", () => ({
  findOwnPosition: () => null,
  recordRankMeasurement: async () => {},
  loadRankHistory: async () => [],
}));
vi.mock("@/lib/lifecycle/decay", () => ({
  detectDecay: () => ({ decaying: true, reason: "dropped", detail: "fell off page one" }),
}));
vi.mock("@/lib/jobs/queue", () => ({
  enqueueJob: async ({ articleId }: { articleId: string }) => {
    state.enqueued.push(articleId);
    return `job-${articleId}`;
  },
  hasActiveJob: async () => false,
}));

vi.mock("@/lib/providers/discovery/registry", () => ({
  getDiscoveryProviders: () => [{ name: "web", search: async () => [] }],
}));
vi.mock("@/lib/placements/runs", () => ({
  startDiscovery: async ({ businessId }: { businessId: string }) => {
    state.discoveries.push(businessId);
    return { alreadyRunning: false, jobId: "job-1" };
  },
}));

import { GET as autopilot } from "@/app/api/cron/autopilot/route";
import { GET as probeVisibility } from "@/app/api/cron/probe-visibility/route";
import { GET as probeCitations } from "@/app/api/cron/probe-citations/route";
import { GET as refreshArticles } from "@/app/api/cron/refresh-articles/route";
import { GET as discoverPlacements } from "@/app/api/cron/discover-placements/route";

type Handler = (request: never) => Promise<Response>;

async function call(handler: Handler, path: string): Promise<Record<string, unknown>> {
  const request = new Request(`https://gettrafficfa.st${path}`, { headers: { authorization: "Bearer cron-test" } });
  const response = await handler(request as never);
  return (await response.json()) as Record<string, unknown>;
}

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

/** Two owners: one pays, one lapsed. Each has one site. */
function seed(extra: Record<string, Array<Record<string, unknown>>> = {}): FakeSupabase {
  return new FakeSupabase({
    subscriptions: [
      { user_id: "paid", status: "active", current_period_end: inDays(20) },
      { user_id: "lapsed", status: "canceled", current_period_end: inDays(-3) },
    ],
    businesses: [
      {
        id: "biz-paid",
        user_id: "paid",
        niche: "seo",
        description: "paid site",
        website_url: "https://paid.test",
        content_language: "en",
        automation_settings: { enabled: true },
        aeo_settings: { cadence: "weekly" },
      },
      {
        id: "biz-lapsed",
        user_id: "lapsed",
        niche: "seo",
        description: "lapsed site",
        website_url: "https://lapsed.test",
        content_language: "en",
        automation_settings: { enabled: true },
        aeo_settings: { cadence: "weekly" },
      },
    ],
    aeo_runs: [],
    aeo_queries: [
      { id: "q-paid", business_id: "biz-paid", user_id: "paid", enabled: true },
      { id: "q-lapsed", business_id: "biz-lapsed", user_id: "lapsed", enabled: true },
    ],
    keywords: [],
    provider_pauses: [],
    ai_citations: [],
    article_events: [],
    ...extra,
  });
}

function published(id: string, userId: string, businessId: string) {
  return {
    id,
    user_id: userId,
    business_id: businessId,
    keyword_id: `kw-${id}`,
    status: "published",
    published_url: `https://${businessId}.test/${id}`,
    last_refreshed_at: null,
    created_at: "2026-09-01T00:00:00.000Z",
    keywords: { keyword: `keyword ${id}` },
  };
}

let lines: Array<Record<string, unknown>> = [];
const skipped = (cron: string) => lines.filter((line) => line.event === "cron.unpaid_skipped" && line.cron === cron);

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "cron-test");
  state.keywordCalls = [];
  state.started = [];
  state.probed = [];
  state.measured = [];
  state.enqueued = [];
  state.discoveries = [];
  lines = [];
  const capture = (raw: unknown) => {
    try {
      lines.push(JSON.parse(String(raw)));
    } catch {
      // not a JSON line
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

describe("crons skip owners who do not pay", () => {
  it("autopilot neither buys keywords nor schedules for a lapsed owner", async () => {
    const db = seed();
    state.db = db;

    const body = await call(autopilot as Handler, "/api/cron/autopilot");

    expect(body).toMatchObject({ autopilotOn: 2, skippedUnpaid: 1 });
    expect(state.keywordCalls).toEqual(["paid site"]);
    expect(db.tables.keywords.every((k) => k.business_id === "biz-paid")).toBe(true);
    expect((db.tables.articles ?? []).filter((a) => a.business_id === "biz-lapsed")).toEqual([]);
    expect((db.tables.articles ?? []).some((a) => a.business_id === "biz-paid")).toBe(true);
    expect(skipped("autopilot")).toEqual([
      expect.objectContaining({ user_id: "lapsed", business_id: "biz-lapsed", reason: "no_active_subscription" }),
    ]);
  });

  it("probe-visibility starts no run for a lapsed owner", async () => {
    state.db = seed();
    const body = await call(probeVisibility as Handler, "/api/cron/probe-visibility");
    expect(body).toMatchObject({ due: 2, skippedUnpaid: 1, started: 1 });
    expect(state.started).toEqual(["biz-paid"]);
    expect(skipped("probe-visibility")).toEqual([
      expect.objectContaining({ user_id: "lapsed", business_id: "biz-lapsed", reason: "no_active_subscription" }),
    ]);
  });

  it("probe-citations probes no article of a lapsed owner", async () => {
    state.db = seed({
      articles: [published("a-lapsed", "lapsed", "biz-lapsed"), published("a-paid", "paid", "biz-paid")],
    });
    const body = await call(probeCitations as Handler, "/api/cron/probe-citations");
    expect(state.probed).toEqual(["keyword a-paid"]);
    expect(body).toMatchObject({ due: 1, probed: 1, skippedUnpaid: { owners: 1, articles: 1 } });
    expect(skipped("probe-citations")).toEqual([
      expect.objectContaining({ user_id: "lapsed", reason: "no_active_subscription", articles_seen: 1 }),
    ]);
  });

  it("refresh-articles neither measures nor rewrites a lapsed owner's article", async () => {
    state.db = seed({
      articles: [published("a-lapsed", "lapsed", "biz-lapsed"), published("a-paid", "paid", "biz-paid")],
    });
    const body = await call(refreshArticles as Handler, "/api/cron/refresh-articles");
    expect(state.measured).toEqual(["keyword a-paid"]);
    expect(state.enqueued).toEqual(["a-paid"]);
    expect(body).toMatchObject({ scanned: 1, skippedUnpaid: { owners: 1, articles: 1 } });
    expect(skipped("refresh-articles")).toEqual([
      expect.objectContaining({ user_id: "lapsed", reason: "no_active_subscription" }),
    ]);
  });

  it("discover-placements enqueues no discovery for a lapsed owner", async () => {
    state.db = seed();
    const body = await call(discoverPlacements as Handler, "/api/cron/discover-placements");
    expect(state.discoveries).toEqual(["biz-paid"]);
    expect(body).toMatchObject({ enqueued: 1, skippedUnpaid: 1 });
    expect(skipped("discover-placements")).toEqual([
      expect.objectContaining({ user_id: "lapsed", business_id: "biz-lapsed", reason: "no_active_subscription" }),
    ]);
  });

  it("counts an owner whose subscription cannot be read as not paid, with its own reason", async () => {
    const db = seed();
    const broken = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== "from") return Reflect.get(target, property, receiver);
        return (table: string) => {
          if (table !== "subscriptions") return target.from(table);
          const failing = {
            select: () => failing,
            eq: () => failing,
            in: () => Promise.resolve({ data: null, error: { message: "permission denied" } }),
          };
          return failing;
        };
      },
    });
    state.db = broken;

    const body = await call(discoverPlacements as Handler, "/api/cron/discover-placements");

    expect(state.discoveries).toEqual([]);
    expect(body).toMatchObject({ enqueued: 0, skippedUnpaid: 2 });
    expect(skipped("discover-placements").map((line) => [line.reason, line.level])).toEqual([
      ["subscription_unreadable", "warn"],
      ["subscription_unreadable", "warn"],
    ]);
  });
});

/**
 * The same crons and the account's daily AI spend limit (lib/limits/): an
 * owner who pays but has reached it is left out of the run's paid work,
 * logged as `cron.spend_skipped` and counted apart from the unpaid. Autopilot
 * still schedules from the pool (free; the day cannot be recovered) and
 * buys no keywords.
 */
describe("crons leave out owners at their daily AI spend limit", () => {
  const atLimit = () => ({
    agent_runs: [
      { user_id: "paid", agent: "writing", model: "gemini-2.5-flash", cost_usd: 6, created_at: new Date(Date.now() - 3_600_000).toISOString() },
    ],
  });
  const spendSkipped = (cron: string) => lines.filter((line) => line.event === "cron.spend_skipped" && line.cron === cron);

  it("probe-visibility starts no run for them", async () => {
    state.db = seed(atLimit());
    const body = await call(probeVisibility as Handler, "/api/cron/probe-visibility");
    expect(state.started).toEqual([]);
    expect(body).toMatchObject({ due: 2, skippedUnpaid: 1, skippedSpendCap: 1, started: 0 });
    expect(spendSkipped("probe-visibility")).toEqual([
      expect.objectContaining({ user_id: "paid", business_id: "biz-paid", reason: "spend_cap_reached" }),
    ]);
  });

  it("discover-placements enqueues no discovery for them", async () => {
    state.db = seed(atLimit());
    const body = await call(discoverPlacements as Handler, "/api/cron/discover-placements");
    expect(state.discoveries).toEqual([]);
    expect(body).toMatchObject({ enqueued: 0, skippedUnpaid: 1, skippedSpendCap: 1 });
  });

  it("probe-citations and refresh-articles leave their articles alone, counted apart", async () => {
    const articles = [published("a-lapsed", "lapsed", "biz-lapsed"), published("a-paid", "paid", "biz-paid")];
    state.db = seed({ ...atLimit(), articles });
    const probed = await call(probeCitations as Handler, "/api/cron/probe-citations");
    expect(state.probed).toEqual([]);
    expect(probed).toMatchObject({ skippedUnpaid: { owners: 1, articles: 1 }, skippedSpendCap: { owners: 1, articles: 1 } });

    state.db = seed({ ...atLimit(), articles: articles.map((a) => ({ ...a })) });
    const refreshed = await call(refreshArticles as Handler, "/api/cron/refresh-articles");
    expect(state.measured).toEqual([]);
    expect(state.enqueued).toEqual([]);
    expect(refreshed).toMatchObject({ scanned: 0, skippedSpendCap: { owners: 1, articles: 1 } });
    expect(spendSkipped("refresh-articles")).toEqual([expect.objectContaining({ user_id: "paid", reason: "spend_cap_reached" })]);
  });

  it("autopilot keeps scheduling from their pool and buys them no keywords", async () => {
    const db = seed({
      ...atLimit(),
      keywords: [
        { id: "kw-1", user_id: "paid", business_id: "biz-paid", keyword: "pooled", status: "available", article_id: null, opportunity: "High", difficulty: 10, search_volume: 100 },
      ],
    });
    state.db = db;
    const body = await call(autopilot as Handler, "/api/cron/autopilot");
    expect(state.keywordCalls).toEqual([]);
    expect(body).toMatchObject({ skippedUnpaid: 1, keywordsDeferredSpendCap: 1 });
    expect((db.tables.articles ?? []).filter((a) => a.business_id === "biz-paid")).toHaveLength(1);
    expect(spendSkipped("autopilot")).toEqual([expect.objectContaining({ user_id: "paid", reason: "spend_cap_reached", step: "keywords" })]);
  });
});
