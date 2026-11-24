import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "../support/fake-supabase";
import { parseAutopilotRun } from "@/lib/automation/run-status";

/**
 * Two sites on one account, both with Autopilot on. The older one has a
 * long history: every topic left in its pool overlaps one it already
 * published, and a top-up that is not told what the site covers proposes
 * the same ground again, so every suggestion is refused. Before 2026-11-24
 * that run scheduled nothing, bought nothing and said so only in the cron's
 * own response: the site read "Autopilot on" while its calendar stayed
 * empty. Now each site's run is stored on the site with the reason, the
 * top-up is told what the site covers, and every site of the account is
 * swept, oldest first.
 */

const state = vi.hoisted(() => ({
  db: null as unknown,
  calls: [] as Array<{ description: string; avoid: readonly string[] }>,
  /** Per site description: what the suggestion call returns. */
  suggestions: {} as Record<string, string[]>,
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db }));
vi.mock("@sentry/nextjs", () => ({ captureException: () => {}, captureMessage: () => {} }));
vi.mock("@/lib/research/keywords", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/research/keywords")>()),
  generateKeywordsFromBusiness: async (
    _niche: string,
    description: string,
    _url: string,
    _language: string,
    context: { avoid?: readonly string[] } = {}
  ) => {
    state.calls.push({ description, avoid: context.avoid ?? [] });
    return (state.suggestions[description] ?? []).map((keyword) => ({
      keyword,
      searchVolume: 200,
      competition: "Medium",
      difficulty: 30,
      cpc: null,
      opportunity: "High",
      intent: "product_adjacent",
    }));
  },
}));

import { GET as autopilot } from "@/app/api/cron/autopilot/route";

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
const day = (n: number) => inDays(n).slice(0, 10);
const settings = { enabled: true, bufferDays: 5, keywordFloor: 3, maxKeywordsPerRun: 3, maxSchedulesPerRun: 5 };

/** Site Older: three published topics, a pool whose every topic overlaps one of them. */
function olderSite() {
  const own = { user_id: "owner", business_id: "older" };
  const published = ["email marketing for online shops", "abandoned cart emails", "welcome email series"];
  return {
    business: {
      id: "older",
      user_id: "owner",
      name: "Brightleaf Goods",
      niche: "ecommerce email",
      description: "older-site",
      website_url: "https://brightleaf.example",
      content_language: "en",
      automation_settings: { ...settings, backLinks: true, pushPage3: true },
      created_at: "2026-01-10T10:00:00Z",
    },
    keywords: [
      ...published.map((keyword, i) => ({ id: `older-k${i}`, ...own, keyword, status: "published", article_id: `older-a${i}`, intent: null })),
      { id: "older-free-1", ...own, keyword: "email marketing for online shops guide", status: "available", article_id: null, intent: null },
      { id: "older-free-2", ...own, keyword: "abandoned cart emails examples", status: "available", article_id: null, intent: null },
    ],
    articles: published.map((title, i) => ({
      id: `older-a${i}`,
      ...own,
      keyword_id: `older-k${i}`,
      status: "published",
      title,
      published_url: `https://brightleaf.example/${i}`,
      scheduled_date: "2026-01-20",
    })),
  };
}

function newerSite() {
  return {
    id: "newer",
    user_id: "owner",
    name: "Copperfield Tools",
    niche: "woodworking",
    description: "newer-site",
    website_url: "https://copperfield.example",
    content_language: "en",
    automation_settings: settings,
    created_at: "2026-03-01T10:00:00Z",
  };
}

function seed(options: { paid?: boolean } = {}): FakeSupabase {
  const older = olderSite();
  return new FakeSupabase({
    subscriptions: options.paid === false ? [] : [{ user_id: "owner", status: "active", current_period_end: inDays(20) }],
    // The newer site first in the table: the sweep orders by age itself.
    businesses: [newerSite(), older.business],
    keywords: older.keywords,
    articles: older.articles,
    entities: [],
    competitors: [],
    aeo_probes: [],
    placement_targets: [],
    provider_pauses: [],
  });
}

async function call(): Promise<Record<string, unknown>> {
  const request = new Request("https://gettrafficfa.st/api/cron/autopilot", { headers: { authorization: "Bearer cron-test" } });
  const response = await autopilot(request as never);
  return (await response.json()) as Record<string, unknown>;
}

function runOf(db: FakeSupabase, id: string) {
  return parseAutopilotRun((db.tables.businesses ?? []).find((b) => b.id === id)?.autopilot_run);
}

const scheduledFor = (db: FakeSupabase, id: string) =>
  (db.tables.articles ?? []).filter((a) => a.business_id === id && a.status === "queued");

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "cron-test");
  state.calls = [];
  state.suggestions = {
    // What a top-up that ignores the site's history proposes: its own ground again.
    "older-site": ["email marketing for online shops tips", "welcome email series ideas"],
    "newer-site": ["dovetail joints by hand", "sharpening a chisel", "choosing a workbench"],
  };
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Autopilot on every site of an account", () => {
  it("sweeps both sites, oldest first, and fills the one that has fuel", async () => {
    const db = seed();
    state.db = db;
    const body = await call();
    expect(body.autopilotOn).toBe(2);
    expect(state.calls.map((c) => c.description)).toEqual(["older-site", "newer-site"]);
    expect(scheduledFor(db, "newer").length).toBe(3);
    expect(runOf(db, "newer")).toMatchObject({ scheduled: 3, topicsAdded: 3, reasons: [expect.objectContaining({ code: "days_empty" })] });
  });

  it("stores on the older site why its calendar stays empty, instead of saying nothing", async () => {
    const db = seed();
    state.db = db;
    const body = await call();
    expect(scheduledFor(db, "older")).toHaveLength(0);
    const run = runOf(db, "older");
    expect(run).not.toBeNull();
    expect(run).toMatchObject({ scheduled: 0, topicsAdded: 0, emptyDays: 5, bufferDays: 5 });
    expect(run!.reasons.map((r) => r.code)).toEqual(["no_new_topics", "pool_overlaps", "days_empty"]);
    expect(run!.reasons.find((r) => r.code === "pool_overlaps")!.message).toContain("2 topics in the pool were not scheduled");
    expect(body.stalled).toBe(2);
  });

  it("tells the top-up what the site already covers, so it can propose new ground", async () => {
    state.db = seed();
    await call();
    const older = state.calls.find((c) => c.description === "older-site")!;
    expect(older.avoid).toEqual(
      expect.arrayContaining(["email marketing for online shops", "abandoned cart emails", "welcome email series", "abandoned cart emails examples"])
    );
    // Only the site's own topics: nothing of the other site.
    expect(older.avoid.join(" ")).not.toContain("dovetail");
  });

  it("refills and schedules the older site once the top-up finds new topics", async () => {
    const db = seed();
    state.db = db;
    state.suggestions["older-site"] = ["subject lines that get opened", "growing a newsletter list", "post-purchase email flow"];
    await call();
    expect(scheduledFor(db, "older")).toHaveLength(3);
    const run = runOf(db, "older")!;
    expect(run).toMatchObject({ scheduled: 3, topicsAdded: 3, emptyDays: 2 });
    // The two empty days are explained: nothing left that does not overlap.
    expect(run.reasons.map((r) => r.code)).toEqual(["pool_overlaps", "days_empty"]);
  });

  it("records a skipped site whole for an account with no plan, on every site of it", async () => {
    const db = seed({ paid: false });
    state.db = db;
    await call();
    expect(state.calls).toHaveLength(0);
    for (const id of ["older", "newer"]) {
      expect(runOf(db, id)!.reasons.map((r) => r.code)).toEqual(["no_plan"]);
    }
  });

  it("leaves a site with Autopilot off untouched, with no record", async () => {
    const db = seed();
    (db.tables.businesses ?? []).find((b) => b.id === "older")!.automation_settings = { enabled: false };
    state.db = db;
    const body = await call();
    expect(body.autopilotOn).toBe(1);
    expect(runOf(db, "older")).toBeNull();
    expect(runOf(db, "newer")).not.toBeNull();
  });

  it("says nothing is wrong when the calendar is already covered", async () => {
    const db = seed();
    for (let n = 1; n <= 5; n += 1) {
      (db.tables.articles ?? []).push({ id: `newer-q${n}`, user_id: "owner", business_id: "newer", keyword_id: null, status: "queued", scheduled_date: day(n) });
    }
    (db.tables.keywords ?? []).push(
      ...["a", "b", "c"].map((k) => ({ id: `newer-free-${k}`, user_id: "owner", business_id: "newer", keyword: `hand plane ${k}`, status: "available", article_id: null, intent: null }))
    );
    state.db = db;
    await call();
    expect(runOf(db, "newer")).toMatchObject({ scheduled: 0, emptyDays: 0, reasons: [] });
  });
});
