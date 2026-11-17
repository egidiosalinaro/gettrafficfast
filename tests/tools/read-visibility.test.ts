import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeSupabase } from "../support/fake-supabase";
import { apiCaller } from "./support";
import { Q_A1, Q_A2, Q_B, Q_C, RUN_A1, RUN_A2, T_A, readSeed } from "./read-support";

/**
 * The AI Visibility tools, as an API-key caller on site A with the read
 * scope only. What is pinned beyond the happy paths: rates are per engine,
 * null when nothing was measured (an engine that only errored), never 0 for
 * that; every answer says it is sampled; a prompt of site B or of another
 * account is a 404.
 */

const m = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => m.db }));
vi.mock("@/lib/providers/citations/registry", () => ({
  getCitationProviders: () => [{ name: "gemini" }, { name: "perplexity" }],
}));

import { runTool } from "@/lib/tools/runner";
import { SAMPLE_LINE } from "@/lib/visibility/summary";

let db: FakeSupabase;
beforeEach(() => {
  db = readSeed();
  m.db = db;
});

const call = (name: string, input: unknown = {}) => runTool(apiCaller(db, { scopes: ["read"] }), name, input);

describe("get_visibility_overview", () => {
  it("answers the latest run per engine, null where nothing was measured, labelled as sampled", async () => {
    const run = await call("get_visibility_overview");
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const o = run.output as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(o.latestRun.id).toBe(RUN_A2);
    expect(o.summary.engines).toEqual([
      expect.objectContaining({ engine: "gemini", valid: 1, cited: 1, rate: 1 }),
      // Asked, but no readable answer: not measured, not 0.
      expect.objectContaining({ engine: "perplexity", valid: 0, errors: 1, rate: null }),
    ]);
    expect(o.summary).not.toHaveProperty("rate");
    expect(o.comparison).toMatchObject({ previousRunId: RUN_A1, comparable: true });
    expect(o.comparison.byEngine).toEqual([
      { engine: "gemini", rate: 1, previousRate: 0, previousCited: 0, previousValid: 1, delta: 100 },
      { engine: "perplexity", rate: null, previousRate: 0, previousCited: 0, previousValid: 1, delta: null },
    ]);
    expect(o.lead.answer).toContain("Gemini cited");
    expect(o).toMatchObject({
      sampled: true,
      sampleNote: SAMPLE_LINE,
      activeEngines: ["gemini"],
      prompts: { total: 2, enabled: 1, clusters: ["tools"] },
      rows: null,
    });
    expect(o.runs.map((r: { id: string }) => r.id)).toEqual([RUN_A2, RUN_A1]);
  });

  it("adds the per-prompt rows when asked", async () => {
    const run = await call("get_visibility_overview", { includeRows: true });
    expect(run.ok && (run.output.rows as Array<{ engine: string; change: string }>).map((r) => [r.engine, r.change])).toEqual([
      ["gemini", "gained"],
      ["perplexity", "unknown"],
    ]);
  });
});

describe("list_prompts", () => {
  it("lists the site's prompt set", async () => {
    const run = await call("list_prompts");
    expect(run.ok && run.output).toMatchObject({ total: 2, enabled: 1 });
    expect(run.ok && (run.output.prompts as Array<{ id: string }>).map((p) => p.id).sort()).toEqual([Q_A1, Q_A2].sort());
  });
});

describe("get_prompt_history", () => {
  it("answers one prompt's history per engine, its articles and its replies, sampled", async () => {
    const run = await call("get_prompt_history", { queryId: Q_A1 });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const h = run.output as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(h.prompt).toMatchObject({ id: Q_A1, query: "best ai seo tool" });
    expect(h.history).toEqual([
      expect.objectContaining({ engine: "gemini", valid: 2, cited: 1, rate: 0.5 }),
      expect.objectContaining({ engine: "perplexity", valid: 1, cited: 0, rate: 0 }),
    ]);
    expect(h.probes).toHaveLength(4);
    expect(h.articles).toEqual([expect.objectContaining({ via: "cited", publishedUrl: "https://acme.test/ai-seo" })]);
    expect(h.placements).toEqual([expect.objectContaining({ id: T_A })]);
    expect(h).toMatchObject({ sampled: true, sampleNote: SAMPLE_LINE });
  });

  it("answers 404 for a prompt of another site or another account", async () => {
    for (const queryId of [Q_B, Q_C]) {
      expect(await call("get_prompt_history", { queryId })).toMatchObject({
        ok: false,
        status: 404,
        error: { code: "not_found", message: "No prompt with that queryId on this site." },
      });
    }
  });
});

describe("list_visibility_runs", () => {
  it("lists the site's runs newest first, bounded by limit, with no cost", async () => {
    const run = await call("list_visibility_runs", { limit: 1 });
    expect(run.ok && run.output.runs).toEqual([expect.objectContaining({ id: RUN_A2, trigger: "schedule" })]);
    // The run row carries cost_usd (0.004 in the seed): the platform's, never in the answer.
    expect(JSON.stringify(run)).not.toMatch(/cost/i);
    const all = await call("list_visibility_runs");
    expect(all.ok && (all.output.runs as unknown[]).length).toBe(2);
  });
});

describe("get_visibility_settings", () => {
  it("answers what counts as the site, the engines and the cadence", async () => {
    const run = await call("get_visibility_settings");
    expect(run.ok && run.output).toMatchObject({
      settings: { brandNames: ["Acme"], engines: ["gemini"], cadence: "weekly" },
      identity: { domains: ["acme.test"], brandNames: ["Acme"] },
      configuredEngines: ["gemini", "perplexity"],
      activeEngines: ["gemini"],
      business: { name: "Acme", websiteUrl: "https://acme.test" },
    });
  });
});
