import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toMcpTool } from "@/lib/tools/mcp";
import { TOOLS } from "@/lib/tools/registry";
import { describeTool } from "@/lib/tools/schema";
import type { FakeSupabase } from "../support/fake-supabase";
import { OTHER, SITE_A, SITE_B, SITE_C, USER, apiCaller, seedWrites } from "./write-seed";
import { customerData } from "./support";

/**
 * "Find places from the last run", as a tool and as the screen's route.
 * Pinned: it is a free write (no spend scope, no paywall, no confirm); it
 * reads the caller's site and nobody else's; it writes reply targets and
 * nothing more (no job, no draft, no probe); a read key cannot call it; with
 * no finished run it says what to do first; and the route answers the same
 * function's result.
 */

const mocks = vi.hoisted(() => ({
  subscribed: true,
  db: null as unknown as FakeSupabase,
  businessId: null as string | null,
  userId: null as string | null,
}));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: () => {},
}));
vi.mock("@/lib/subscription", () => ({ hasActiveSubscription: async () => mocks.subscribed }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mocks.db }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => mocks.db.from(table),
    auth: { getUser: async () => ({ data: { user: mocks.userId ? { id: mocks.userId } : null } }) },
  }),
}));
vi.mock("@/lib/tenancy", () => ({
  NO_BUSINESS_RESPONSE: { error: "No site set up yet. Add your business first.", code: "no_business" },
  selectedBusinessId: async () => mocks.businessId,
}));

import { runTool } from "@/lib/tools/runner";
import { POST } from "@/app/api/visibility/places/route";

const THREAD = "https://www.reddit.com/r/SEO/comments/1xyz111/what_ai_seo_tool_do_you_use/";
const LISTICLE = "https://toolblog.test/best-ai-seo-tools-2026";
const src = (url: string, title = "") => ({ url, domain: new URL(url).hostname.replace(/^www\./, ""), title });

function seed(over: { run?: boolean } = {}) {
  const db = seedWrites();
  if (over.run !== false) {
    db.tables.aeo_runs.push(
      { id: "run-a", user_id: USER, business_id: SITE_A, status: "completed", started_at: "2026-11-09T10:00:00.000Z", finished_at: "2026-11-09T10:05:00.000Z" },
      { id: "run-b", user_id: USER, business_id: SITE_B, status: "completed", started_at: "2026-11-09T11:00:00.000Z", finished_at: "2026-11-09T11:05:00.000Z" },
      { id: "run-c", user_id: OTHER, business_id: SITE_C, status: "completed", started_at: "2026-11-09T12:00:00.000Z", finished_at: "2026-11-09T12:05:00.000Z" }
    );
    const probe = (id: string, runId: string, userId: string, site: string, sources: unknown[]) => ({
      id,
      run_id: runId,
      user_id: userId,
      business_id: site,
      query_id: null,
      query: "best ai seo tool",
      engine: "perplexity",
      status: "not_cited",
      sources,
    });
    db.tables.aeo_probes = [
      probe("pa", "run-a", USER, SITE_A, [src(THREAD, "What AI SEO tool do you use?"), src(LISTICLE, "The 12 Best AI SEO Tools"), src("https://acme.test/blog")]),
      probe("pb", "run-b", USER, SITE_B, [src("https://news.ycombinator.com/item?id=1")]),
      probe("pc", "run-c", OTHER, SITE_C, [src("https://news.ycombinator.com/item?id=2")]),
    ];
  }
  mocks.db = db;
  return db;
}

type Scope = "read" | "write" | "spend";
const call = (db: FakeSupabase, scopes?: Scope[]) => runTool(apiCaller(db, scopes ? { scopes } : {}), "find_places_from_last_run", {});

let quiet: Array<ReturnType<typeof vi.spyOn>>;
beforeEach(() => {
  mocks.subscribed = true;
  mocks.userId = USER;
  mocks.businessId = SITE_A;
  quiet = (["info", "warn", "error"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
});
afterEach(() => quiet.forEach((spy) => spy.mockRestore()));

describe("find_places_from_last_run, as the catalogue describes it", () => {
  const tool = TOOLS.get("find_places_from_last_run");

  it("is a free write: no spend scope, no paywall, no confirm, not destructive", () => {
    expect(tool).toBeDefined();
    if (!tool) return;
    expect(describeTool(tool)).toMatchObject({ scopes: ["write"], paid: false, subscription: true });
    expect(toMcpTool(tool).annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(Object.keys((tool.input as unknown as { shape: Record<string, unknown> }).shape)).toEqual([]);
    // What an agent reads says it is a sample and that nothing is sent.
    expect(tool.description).toMatch(/Sampled/);
    expect(tool.description).toMatch(/Nothing is drafted or sent/);
  });
});

describe("find_places_from_last_run", () => {
  it("turns the caller's last run into reply targets on the caller's site, and nothing else", async () => {
    const db = seed();
    const result = await call(db, ["write"]);

    expect(result).toMatchObject({
      ok: true,
      output: { runId: "run-a", candidates: 2, created: 2, linked: 0, deferred: 0, dropped: { own_site: 1 } },
    });
    const created = db.tables.placement_targets;
    expect(created.map((t) => [t.user_id, t.business_id, t.kind]).sort()).toEqual(
      [
        [USER, SITE_A, "thread"],
        [USER, SITE_A, "listicle"],
      ].sort()
    );
    // Site B's and site C's runs were not read.
    expect(created.some((t) => t.surface === "hackernews")).toBe(false);
    // Free: no job, no draft, no new probe, no run.
    expect(db.tables.jobs).toEqual([]);
    expect(db.tables.placements).toEqual([]);
    expect(db.tables.aeo_probes).toHaveLength(3);
    expect(db.tables.aeo_runs).toHaveLength(3);
  });

  it("is refused without an active plan, like every tool, though nothing here is paid", async () => {
    const db = seed();
    mocks.subscribed = false;
    expect(await call(db, ["write"])).toMatchObject({ ok: false, status: 402, error: { code: "subscription_required" } });
    expect(db.tables.placement_targets ?? []).toHaveLength(0);
  });

  it("called twice, duplicates nothing", async () => {
    const db = seed();
    await call(db);
    expect(await call(db)).toMatchObject({ ok: true, output: { created: 0, linked: 2 } });
    expect(db.tables.placement_targets).toHaveLength(2);
  });

  it("is refused to a read key, with nothing written", async () => {
    const db = seed();
    const before = customerData(db);
    expect(await call(db, ["read"])).toMatchObject({ ok: false, status: 403, error: { code: "forbidden_scope" } });
    expect(customerData(db)).toBe(before);
  });

  it("with no finished run, says to run a check first", async () => {
    const db = seed({ run: false });
    const before = customerData(db);
    const result = await call(db);
    expect(result).toMatchObject({ ok: false, status: 409, error: { code: "prerequisite_missing" } });
    expect(JSON.stringify(result)).toMatch(/run_visibility_check/);
    expect(customerData(db)).toBe(before);
  });
});

describe("POST /api/visibility/places", () => {
  it("answers the same result for the selected site", async () => {
    const db = seed();
    const response = await POST();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, runId: "run-a", created: 2, linked: 0 });
    expect(db.tables.placement_targets.every((t) => t.business_id === SITE_A && t.user_id === USER)).toBe(true);
  });

  it("refuses a visitor, and a person with no site", async () => {
    const db = seed();
    mocks.userId = null;
    expect((await POST()).status).toBe(401);
    mocks.userId = USER;
    mocks.businessId = null;
    expect((await POST()).status).toBe(409);
    expect(db.tables.placement_targets).toEqual([]);
  });

  it("answers 409 in words when no run has finished", async () => {
    seed({ run: false });
    const response = await POST();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "no_run", error: expect.stringMatching(/Run a visibility check first/) });
  });
});
