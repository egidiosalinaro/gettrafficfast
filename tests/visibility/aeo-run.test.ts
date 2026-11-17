import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CitationAnswer, CitationProvider, CitationQuery } from "@/lib/providers/citations/types";
import { CitationProviderError } from "@/lib/providers/citations/types";
import { setCitationProviders } from "@/lib/providers/citations/registry";
import { StepIncomplete, type StepContext } from "@/lib/jobs/types";
import { aeoRunWorkflow, selectEngines } from "@/lib/jobs/workflows/aeo-run";
import { FakeSupabase } from "../support/fake-supabase";

/**
 * The run as a durable job. What is asserted is what the measurement needs
 * from the runtime: the set is frozen before anything is asked, a negative
 * answer is stored, an empty one is `invalid`, a failure is `error` and not
 * "not cited", and a step that runs out of time yields instead of dying.
 */

const BUSINESS = {
  id: "biz-1",
  user_id: "user-1",
  name: "GetTrafficFast",
  website_url: "https://gettrafficfa.st",
  content_language: "en",
  aeo_settings: {},
};

function engine(
  name: string,
  answer: (q: CitationQuery) => Promise<CitationAnswer> | CitationAnswer
): CitationProvider {
  return { name, probe: async (q) => answer(q) };
}

const answerWith = (sources: string[], prose = "An answer."): CitationAnswer => ({
  engine: "gemini",
  query: "",
  answer: prose,
  sources: sources.map((url) => ({ url, domain: new URL(url).hostname, title: "" })),
  raw: {},
  model: "gemini-2.5-flash",
  costUsd: 0.035,
});

function step(name: string) {
  const found = aeoRunWorkflow.steps.find((s) => s.name === name);
  if (!found) throw new Error(`no step ${name}`);
  return found;
}

function ctx(db: FakeSupabase, deadline = Date.now() + 60_000): StepContext {
  return {
    job: {
      id: "job-1",
      user_id: "user-1",
      article_id: null,
      type: "aeo-run",
      input: { runId: "run-1", businessId: "biz-1" },
      status: "running",
      current_step: null,
      attempts: 1,
      max_attempts: 3,
      last_error: null,
    },
    supabase: db as unknown as SupabaseClient,
    input: { runId: "run-1", businessId: "biz-1" },
    outputs: {},
    deadline,
  };
}

describe("aeo-run workflow", () => {
  let db: FakeSupabase;

  beforeEach(() => {
    db = new FakeSupabase({
      businesses: [{ ...BUSINESS }],
      aeo_runs: [{ id: "run-1", business_id: "biz-1", user_id: "user-1", status: "running" }],
      aeo_queries: [
        { id: "q1", business_id: "biz-1", query: "best ai seo tool", cluster: "tools", enabled: true, created_at: "2026-09-01" },
        { id: "q2", business_id: "biz-1", query: "what is aeo", cluster: null, enabled: true, created_at: "2026-09-02" },
        { id: "q3", business_id: "biz-1", query: "disabled one", cluster: null, enabled: false, created_at: "2026-09-03" },
      ],
      aeo_probes: [],
      competitors: [{ business_id: "biz-1", domain: "rival.test", name: "Rival", last_seen_at: "2026-09-01" }],
    });
  });

  afterEach(() => setCitationProviders(undefined));

  it("plans one pending probe per enabled query and engine, and freezes the set on the run", async () => {
    setCitationProviders([engine("gemini", () => answerWith([])), engine("perplexity", () => answerWith([]))]);

    const output = await step("plan").run(ctx(db));

    expect(output).toMatchObject({ planned: 4, queries: 2 });
    expect(db.tables.aeo_probes.filter((p) => p.status === "pending")).toHaveLength(4);
    expect(db.tables.aeo_probes.some((p) => p.query === "disabled one")).toBe(false);
    const run = db.tables.aeo_runs[0];
    expect(run.engines).toEqual(["gemini", "perplexity"]);
    expect(run.query_fingerprint).toBeTruthy();
    expect(run.planned_probes).toBe(4);
  });

  it("re-running the plan adds nothing", async () => {
    setCitationProviders([engine("gemini", () => answerWith([]))]);
    await step("plan").run(ctx(db));
    await step("plan").run(ctx(db));
    expect(db.tables.aeo_probes).toHaveLength(2);
  });

  it("fails the run with a readable reason when there is no engine or no query", async () => {
    setCitationProviders([]);
    await step("plan").run(ctx(db));
    expect(db.tables.aeo_runs[0].status).toBe("failed");
    expect(db.tables.aeo_runs[0].error).toMatch(/no answer engine/i);

    db.tables.aeo_runs[0].status = "running";
    db.tables.aeo_queries = [];
    setCitationProviders([engine("gemini", () => answerWith([]))]);
    await step("plan").run(ctx(db));
    expect(db.tables.aeo_runs[0].error).toMatch(/no enabled queries/i);
  });

  it("honours the business's engine selection out of the configured ones", () => {
    const configured = [engine("gemini", () => answerWith([])), engine("perplexity", () => answerWith([]))];
    expect(selectEngines(configured, []).map((e) => e.name)).toEqual(["gemini", "perplexity"]);
    expect(selectEngines(configured, ["perplexity"]).map((e) => e.name)).toEqual(["perplexity"]);
    expect(selectEngines(configured, ["bing"])).toEqual([]);
  });

  it("stores negatives, invalid answers and errors as three different things", async () => {
    setCitationProviders([
      engine("gemini", (q) => {
        if (q.query === "best ai seo tool") return answerWith(["https://rival.test/x"], "Rival is popular.");
        return { ...answerWith([]), answer: "" };
      }),
    ]);
    await step("plan").run(ctx(db));
    await step("probe").run(ctx(db));

    const byQuery = Object.fromEntries(db.tables.aeo_probes.map((p) => [p.query as string, p]));
    expect(byQuery["best ai seo tool"]).toMatchObject({ status: "not_cited", cited: false, mentioned: false });
    expect(byQuery["best ai seo tool"].competitors).toEqual([
      { domain: "rival.test", name: "Rival", via: "source" },
    ]);
    expect(byQuery["what is aeo"]).toMatchObject({ status: "invalid", cited: null });
    expect(byQuery["what is aeo"].cost_usd).toBe(0.035);
    expect(byQuery["what is aeo"].model).toBe("gemini-2.5-flash");
  });

  it("marks a citation with its position and excerpt", async () => {
    setCitationProviders([
      engine("gemini", () => answerWith(["https://rival.test/x", "https://gettrafficfa.st/blog/aeo"], "GetTrafficFast does this.")),
    ]);
    await step("plan").run(ctx(db));
    await step("probe").run(ctx(db));
    const probe = db.tables.aeo_probes[0];
    expect(probe).toMatchObject({
      status: "cited",
      cited: true,
      position: 2,
      source_url: "https://gettrafficfa.st/blog/aeo",
      mentioned: true,
    });
    expect(probe.answer_excerpt).toBe("GetTrafficFast does this.");
  });

  it("records a non-transient engine failure as error, not as not cited", async () => {
    setCitationProviders([
      engine("gemini", () => {
        throw new CitationProviderError("bad request", "gemini", undefined, { status: 400 });
      }),
    ]);
    await step("plan").run(ctx(db));
    const output = await step("probe").run(ctx(db));
    expect(output).toMatchObject({ probed: 0, errors: 2 });
    expect(db.tables.aeo_probes.every((p) => p.status === "error" && p.cited === null)).toBe(true);
    expect(db.tables.aeo_probes[0].error).toMatch(/bad request/);
  });

  it("asks again after a transient failure and gives up after the second", async () => {
    let calls = 0;
    setCitationProviders([
      engine("gemini", () => {
        calls += 1;
        throw new CitationProviderError("upstream", "gemini", undefined, { status: 503 });
      }),
    ]);
    db.tables.aeo_queries = db.tables.aeo_queries.slice(0, 1);
    await step("plan").run(ctx(db));
    await step("probe").run(ctx(db));
    expect(calls).toBe(2);
    expect(db.tables.aeo_probes[0]).toMatchObject({ status: "error", attempts: 2 });
  });

  it("yields with the vendor's Retry-After on a rate limit instead of hammering", async () => {
    setCitationProviders([
      engine("gemini", () => {
        throw new CitationProviderError("slow down", "gemini", undefined, {
          status: 429,
          retryAfterSeconds: 30,
        });
      }),
    ]);
    await step("plan").run(ctx(db));
    let thrown: unknown;
    try {
      await step("probe").run(ctx(db));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(StepIncomplete);
    expect((thrown as StepIncomplete).resumeAfterSeconds).toBe(30);
    // The probe that hit the limit is still pending, to be asked again.
    expect(db.tables.aeo_probes.some((p) => p.status === "pending")).toBe(true);
  });

  it("yields when the tick's deadline is near and finishes on the next call", async () => {
    setCitationProviders([engine("gemini", () => answerWith([]))]);
    await step("plan").run(ctx(db));

    await expect(step("probe").run(ctx(db, Date.now() + 1_000))).rejects.toBeInstanceOf(StepIncomplete);
    expect(db.tables.aeo_probes.every((p) => p.status === "pending")).toBe(true);

    const output = await step("probe").run(ctx(db));
    expect(output).toMatchObject({ probed: 2 });
  });

  it("finishes the run with totals and an estimated cost", async () => {
    setCitationProviders([engine("gemini", () => answerWith(["https://gettrafficfa.st/"]))]);
    await step("plan").run(ctx(db));
    await step("probe").run(ctx(db));
    const output = await step("finish").run(ctx(db));

    expect(output).toMatchObject({ planned: 2, valid: 2, cited: 2, errors: 0 });
    expect(db.tables.aeo_runs[0]).toMatchObject({ status: "completed", cost_usd: 0.07 });
    expect(db.tables.aeo_runs[0].finished_at).toBeTruthy();
  });

  it("marks the run failed when the job gives up", async () => {
    await aeoRunWorkflow.onFailure?.({
      job: ctx(db).job,
      supabase: db as unknown as SupabaseClient,
      error: "boom",
      outputs: {},
    });
    expect(db.tables.aeo_runs[0]).toMatchObject({ status: "failed", error: "boom" });
  });
});
