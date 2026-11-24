import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setCitationProviders } from "@/lib/providers/citations/registry";
import type { FakeSupabase } from "../support/fake-supabase";
import { P_A, P_A2, P_B, P_C, SITE_A, USER, apiCaller, seedWrites } from "./write-seed";
import { customerData } from "./support";

/**
 * The AI Visibility tools. Pinned: the prompt set changes through the
 * screen's own functions and only on the caller's site; suggest_prompts is
 * paid and writes nothing; and the two calls that switch spending on say
 * what they will cost before they do: run_visibility_check answers
 * confirmation_required with the planned probes (prompts × engines) and runs
 * nothing; the cadence is weekly by default since 2026-11-24, off is kept,
 * and setting it back on needs the spend scope and no confirm.
 */

const mocks = vi.hoisted(() => ({
  subscribed: true,
  db: null as unknown,
  runJobNow: vi.fn(),
  agent: vi.fn(),
  afterTasks: [] as unknown[],
}));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: unknown) => {
    mocks.afterTasks.push(task);
  },
}));
vi.mock("@/lib/subscription", () => ({ hasActiveSubscription: async () => mocks.subscribed }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mocks.db }));
vi.mock("@/lib/jobs/worker", () => ({ runJobNow: (...args: unknown[]) => mocks.runJobNow(...args) }));
vi.mock("@/lib/agents/runner", () => ({
  runAgent: (...args: unknown[]) => mocks.agent(...args),
  supabaseRecorder: () => ({ record: async () => {} }),
}));

import { runTool } from "@/lib/tools/runner";

function seed() {
  const db = seedWrites();
  mocks.db = db;
  return db;
}

type Scope = "read" | "write" | "spend";
const call = (db: FakeSupabase, name: string, input: unknown, scopes?: Scope[]) =>
  runTool(apiCaller(db, scopes ? { scopes } : {}), name, input);

const prompts = (db: FakeSupabase, site = SITE_A) => db.tables.aeo_queries.filter((q) => q.business_id === site);
const aeoSettings = (db: FakeSupabase) => db.tables.businesses.find((b) => b.id === SITE_A)?.aeo_settings as Record<string, unknown>;

let quiet: Array<ReturnType<typeof vi.spyOn>>;
beforeEach(() => {
  mocks.subscribed = true;
  mocks.afterTasks = [];
  mocks.runJobNow.mockReset();
  mocks.runJobNow.mockResolvedValue("completed");
  mocks.agent.mockReset();
  setCitationProviders([{ name: "gemini" }, { name: "perplexity" }] as never);
  quiet = (["info", "warn", "error"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
});
afterEach(() => {
  setCitationProviders(undefined);
  quiet.forEach((spy) => spy.mockRestore());
});

describe("an id of another site is refused before anything is written", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["update_prompt", { promptId: P_B, enabled: false }],
    ["update_prompt", { promptId: P_C, query: "Mine now, is it?" }],
    ["delete_prompt", { promptId: P_B }],
    ["delete_prompt", { promptId: P_C }],
  ];
  it.each(cases)("%s %j", async (name, input) => {
    const db = seed();
    const before = customerData(db);
    expect(await call(db, name, input)).toMatchObject({ ok: false, status: 404, error: { code: "not_found" } });
    expect(customerData(db)).toBe(before);
  });
});

describe("the prompt set", () => {
  it("add_prompts adds new wordings to site A in one cluster and counts the ones already there", async () => {
    const db = seed();
    const run = await call(db, "add_prompts", {
      queries: ["  Which   tool tracks AI citations?  ", "how do i get cited by chatgpt?"],
      cluster: "tracking",
    });
    expect(run).toMatchObject({
      ok: true,
      output: { added: 1, duplicates: 1, prompts: [{ query: "Which tool tracks AI citations?", cluster: "tracking", source: "manual" }] },
    });
    expect(prompts(db)).toHaveLength(3);
    expect(prompts(db).at(-1)).toMatchObject({ user_id: USER, business_id: SITE_A });
  });

  it("update_prompt changes only the fields given", async () => {
    const db = seed();
    const run = await call(db, "update_prompt", { promptId: P_A, enabled: false });
    expect(run).toMatchObject({ ok: true, output: { prompt: { id: P_A, enabled: false, cluster: "pricing", intent: "commercial" } } });
    const renamed = await call(db, "update_prompt", { promptId: P_A, query: "Best AI SEO tool for agencies?", cluster: "" });
    expect(renamed).toMatchObject({ ok: true, output: { prompt: { query: "Best AI SEO tool for agencies?", cluster: null } } });
  });

  it("delete_prompt removes one prompt of site A", async () => {
    const db = seed();
    expect(await call(db, "delete_prompt", { promptId: P_A2 })).toEqual({ ok: true, output: { deleted: 1 } });
    expect(prompts(db).map((q) => q.id)).toEqual([P_A]);
  });

  it("import_prompts_from_keywords seeds the set from site A's keywords, verbatim and free", async () => {
    const db = seed();
    const run = await call(db, "import_prompts_from_keywords", {});
    expect(run).toMatchObject({ ok: true, output: { added: 3, duplicates: 0, skipped: 0 } });
    expect(prompts(db).filter((q) => q.source === "keyword").map((q) => q.query)).toEqual([
      "ai seo tools",
      "answer engine optimization",
      "llm citations",
    ]);
    expect(mocks.agent).not.toHaveBeenCalled();
  });

  it("suggest_prompts proposes, drops keyword-like ones and writes nothing; it is paid", async () => {
    const db = seed();
    mocks.agent.mockResolvedValue({
      prompts: [
        { query: "Which tool shows whether ChatGPT cites my site?", cluster: "tracking", intent: "commercial", why: "A buyer's question." },
        { query: "ai seo", cluster: null, intent: "informational", why: "Too short." },
      ],
    });
    const before = prompts(db).length;
    const run = await call(db, "suggest_prompts", {});
    expect(run).toMatchObject({ ok: true, output: { discarded: 1, prompts: [{ cluster: "tracking" }] } });
    expect(prompts(db)).toHaveLength(before);

    expect(await call(db, "suggest_prompts", {}, ["read", "write"])).toMatchObject({ ok: false, status: 403, error: { code: "forbidden_scope" } });
    mocks.subscribed = false;
    expect(await call(db, "suggest_prompts", {})).toMatchObject({ ok: false, status: 402, error: { code: "subscription_required" } });
  });
});

describe("run_visibility_check", () => {
  it("without confirm, runs nothing and answers with the planned probes", async () => {
    const db = seed();
    const run = await call(db, "run_visibility_check", { waitSeconds: 0 });
    // One enabled prompt (P_A2 is disabled) × two engines.
    expect(run).toMatchObject({
      ok: false,
      status: 409,
      error: {
        code: "confirmation_required",
        message: "This run asks 1 prompt × 2 engines (gemini, perplexity) = 2 probes.",
        hint: expect.stringMatching(/confirm: true/),
      },
    });
    expect(db.tables.aeo_runs).toHaveLength(0);
    expect(db.tables.jobs).toHaveLength(0);
    expect(mocks.runJobNow).not.toHaveBeenCalled();
  });

  it("with confirm, starts the run's job, runs it, and says what it planned", async () => {
    const db = seed();
    const run = await call(db, "run_visibility_check", { confirm: true, waitSeconds: 0 });
    expect(run).toMatchObject({
      ok: true,
      output: { alreadyRunning: false, plan: { engines: ["gemini", "perplexity"], prompts: 1, probes: 2 } },
    });
    expect(db.tables.aeo_runs).toHaveLength(1);
    expect(db.tables.aeo_runs[0]).toMatchObject({ user_id: USER, business_id: SITE_A, trigger: "manual" });
    expect(db.tables.jobs[0]).toMatchObject({ user_id: USER, business_id: SITE_A, type: "aeo-run" });
    expect(mocks.runJobNow).toHaveBeenCalledWith(db, db.tables.jobs[0].id, 50_000);
    if (run.ok) expect(run.output.jobId).toBe(db.tables.jobs[0].id);
  });

  it("follows a run already going instead of starting a second", async () => {
    const db = seed();
    db.tables.aeo_runs.push({ id: "run-1", user_id: USER, business_id: SITE_A, status: "running", job_id: null, started_at: "2026-11-09T09:00:00Z" });
    const run = await call(db, "run_visibility_check", { confirm: true, waitSeconds: 0 });
    expect(run).toMatchObject({ ok: true, output: { alreadyRunning: true, runId: "run-1" } });
    expect(db.tables.aeo_runs).toHaveLength(1);
    expect(mocks.runJobNow).not.toHaveBeenCalled();
  });

  it("refuses with the reason when there is nothing to ask, before asking to confirm", async () => {
    const db = seed();
    for (const q of db.tables.aeo_queries) q.enabled = false;
    expect(await call(db, "run_visibility_check", { confirm: true })).toMatchObject({
      ok: false,
      status: 409,
      error: { code: "prerequisite_missing" },
    });
    setCitationProviders([]);
    expect(await call(db, "run_visibility_check", { confirm: true })).toMatchObject({ ok: false, status: 503, error: { code: "unavailable" } });
  });

  it("is paid: the spend scope and the subscription come first", async () => {
    const db = seed();
    expect(await call(db, "run_visibility_check", { confirm: true }, ["read", "write"])).toMatchObject({
      ok: false,
      status: 403,
      error: { code: "forbidden_scope" },
    });
    mocks.subscribed = false;
    expect(await call(db, "run_visibility_check", { confirm: true })).toMatchObject({ ok: false, status: 402 });
    expect(db.tables.aeo_runs).toHaveLength(0);
  });
});

describe("update_visibility_settings", () => {
  it("merges the fields given onto what is stored", async () => {
    const db = seed();
    db.tables.businesses.find((b) => b.id === SITE_A)!.aeo_settings = { brandNames: ["Acme"], maxQueriesPerRun: 12 };
    const run = await call(db, "update_visibility_settings", { domains: ["blog.acme.test"] });
    expect(run).toMatchObject({
      ok: true,
      output: { settings: { brandNames: ["Acme"], domains: ["blog.acme.test"], maxQueriesPerRun: 12, cadence: "weekly" } },
    });
    expect(aeoSettings(db)).toMatchObject({ brandNames: ["Acme"], domains: ["blog.acme.test"], maxQueriesPerRun: 12 });
  });

  it("the cadence is weekly by default; off is kept, and back on needs the spend scope, not a confirm", async () => {
    const db = seed();
    expect(await call(db, "update_visibility_settings", { cadence: "off" }, ["read", "write"])).toMatchObject({
      ok: true,
      output: { settings: { cadence: "off" } },
    });
    expect(aeoSettings(db)).toMatchObject({ cadence: "off" });
    expect(await call(db, "update_visibility_settings", { cadence: "weekly" }, ["read", "write"])).toMatchObject({
      ok: false,
      status: 403,
      error: { code: "forbidden_scope" },
    });
    expect(aeoSettings(db)).toMatchObject({ cadence: "off" });
    const back = await call(db, "update_visibility_settings", { cadence: "weekly" });
    expect(back).toMatchObject({ ok: true, output: { settings: { cadence: "weekly" }, plan: { probes: 2 } } });
    expect(aeoSettings(db)).toMatchObject({ cadence: "weekly" });
    // Already on: changing it needs nothing more.
    expect(await call(db, "update_visibility_settings", { cadence: "monthly" }, ["read", "write"])).toMatchObject({ ok: true });
  });

  it("refuses a value the screen's schema refuses", async () => {
    const db = seed();
    expect(await call(db, "update_visibility_settings", { maxQueriesPerRun: 500 })).toMatchObject({
      ok: false,
      status: 400,
      error: { code: "invalid_input" },
    });
  });
});
