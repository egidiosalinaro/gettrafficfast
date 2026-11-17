import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INTENT_SKIP_REASON } from "@/lib/jobs/workflows/produce-article";
import { jobOutcome } from "@/lib/articles/provider-comparison";
import { JOB_SUBSCRIPTION_INACTIVE_MESSAGE } from "@/lib/jobs/types";
import type { FakeSupabase } from "../support/fake-supabase";
import { apiCaller, uuid } from "./support";
import { A, ART_A1, ART_A2, ART_B, ART_C, B, C, readSeed } from "./read-support";

/**
 * `compare_article_providers`, as an API-key caller on site A with the read
 * scope only: site A's production jobs by the arm their `arm` step stored,
 * the runs the fallback answered counted apart, nothing of site B or of
 * another account, and no model asked.
 */

const m = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => m.db }));
vi.mock("@/lib/integrations/crypto", () => ({ decryptSecret: (v: string) => v, encryptSecret: (v: string) => v }));

import { runTool } from "@/lib/tools/runner";

const J1 = uuid("a", 1);
const J2 = uuid("a", 2);
const J3 = uuid("a", 3);
const J4 = uuid("a", 4);
const JB = uuid("a", 8);
const JC = uuid("a", 9);

const jobRow = (id: string, site: typeof A, articleId: string, over: Record<string, unknown> = {}) => ({
  id,
  ...site,
  article_id: articleId,
  type: "produce-article",
  status: "completed",
  last_error: null,
  created_at: "2026-09-30T06:00:00.000Z",
  ...over,
});

const step = (jobId: string, name: string, output: unknown) => ({ job_id: jobId, step: name, status: "completed", output });

const settle = (status: string, over: Record<string, unknown> = {}) => ({
  revised: false,
  status,
  problems: 0,
  gateIssues: 1,
  wordCount: 1500,
  auditScore: 80,
  ...over,
});

const call = (provider: string, model: string, fallback = false) => ({ provider, model, fallback });

const agentRun = (jobId: string, site: typeof A, agent: string, over: Record<string, unknown> = {}) => ({
  ...site,
  job_id: jobId,
  agent,
  status: "completed",
  cost_usd: 0.01,
  latency_ms: 1000,
  llm_calls: [call("anthropic", "claude-haiku-5-5")],
  created_at: "2026-09-30T06:05:00.000Z",
  ...over,
});

let db: FakeSupabase;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-09T12:00:00.000Z"));
  vi.stubEnv("LLM_ARTICLE_ROTATION", "gemini,anthropic");
  db = readSeed();
  m.db = db;

  db.tables.jobs = [
    jobRow(J1, A, ART_A1),
    jobRow(J2, A, ART_A2, { created_at: "2026-10-01T06:00:00.000Z" }),
    jobRow(J3, A, ART_A2, { status: "failed", last_error: INTENT_SKIP_REASON, created_at: "2026-10-03T06:00:00.000Z" }),
    // Ran without a rotation: in no arm.
    jobRow(J4, A, ART_A2, { created_at: "2026-09-01T06:00:00.000Z" }),
    jobRow(JB, B, ART_B),
    jobRow(JC, C, ART_C),
    // Another kind of job on site A.
    { ...jobRow(uuid("a", 5), A, ART_A1), type: "refresh-article" },
  ];
  db.tables.job_steps = [
    step(J1, "arm", { arm: "anthropic", day: "2026-09-30", rotation: ["gemini", "anthropic"] }),
    step(J1, "settle", settle("generated", { problems: 2, gateIssues: 3, wordCount: 1800, auditScore: 88 })),
    step(J2, "arm", { arm: "gemini", day: "2026-10-01", rotation: ["gemini", "anthropic"] }),
    step(J2, "settle", settle("needs_review", { gateIssues: 5, wordCount: 1200, auditScore: 61 })),
    step(J3, "arm", { arm: "gemini", day: "2026-10-03", rotation: ["gemini", "anthropic"] }),
    step(J4, "arm", { arm: null }),
    step(J4, "settle", settle("generated")),
    step(JB, "arm", { arm: "gemini" }),
    step(JB, "settle", settle("generated")),
    step(JC, "arm", { arm: "gemini" }),
    step(JC, "settle", settle("generated")),
  ];
  db.tables.agent_runs = [
    agentRun(J1, A, "outline", { cost_usd: 0.002, latency_ms: 4000 }),
    agentRun(J1, A, "writing", { cost_usd: 0.05, latency_ms: 30_000, llm_calls: [call("anthropic", "claude-sonnet-5-5")] }),
    agentRun(J1, A, "aeo-audit", { cost_usd: 0.003, latency_ms: 5000 }),
    // A Gemini day on which Gemini's account refused: Claude wrote, as the fallback.
    agentRun(J2, A, "writing", { cost_usd: 0.06, latency_ms: 40_000, llm_calls: [call("anthropic", "claude-sonnet-5-5", true)] }),
    agentRun(J2, A, "aeo-audit", { cost_usd: 0.004, latency_ms: 6000, llm_calls: [call("gemini", "gemini-2.5-flash")] }),
    agentRun(J3, A, "serp-analysis", { cost_usd: 0.001, latency_ms: 3000, llm_calls: [call("gemini", "gemini-2.5-flash")] }),
    agentRun(J4, A, "writing", { cost_usd: 9, llm_calls: [call("gemini", "gemini-2.5-pro")] }),
    agentRun(JB, B, "writing", { cost_usd: 9, llm_calls: [call("gemini", "gemini-2.5-pro")] }),
    agentRun(JC, C, "writing", { cost_usd: 9, llm_calls: [call("gemini", "gemini-2.5-pro")] }),
  ];
  // ART_A1 went live on 1 October; Search Console is ingested through 6 November.
  db.tables.publish_attempts = [
    { id: uuid("6", 1), ...A, article_id: ART_A1, integration_type: "webhook", ok: true, created_at: "2026-10-01T09:00:00.000Z" },
    { id: uuid("6", 2), ...A, article_id: ART_A1, integration_type: "webhook", ok: true, created_at: "2026-10-15T09:00:00.000Z" },
    { id: uuid("6", 3), ...A, article_id: ART_A2, integration_type: "webhook", ok: false, created_at: "2026-10-02T09:00:00.000Z" },
  ];
  db.tables.content_metrics = [
    { ...A, article_id: ART_A1, captured_on: "2026-10-10", source: "search_console", position: 9, impressions: 120, clicks: 3 },
    { ...A, article_id: ART_A1, captured_on: "2026-10-12", source: "serp", position: 4, impressions: null, clicks: null },
    // Day 36: outside the first 28.
    { ...A, article_id: ART_A1, captured_on: "2026-11-05", source: "search_console", position: 6.5, impressions: 200, clicks: 9 },
  ];
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("compare_article_providers", () => {
  it("answers site A's arms, with the fallback's runs apart and nothing of another site", async () => {
    const run = await runTool(apiCaller(db, { scopes: ["read"] }), "compare_article_providers", {});
    expect(run, JSON.stringify(run).slice(0, 400)).toMatchObject({ ok: true });
    if (!run.ok) return;
    const out = run.output as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

    expect(out.window).toMatchObject({ days: 90, jobsRead: 4, jobsWithArm: 3, truncated: false });
    // 9 November 2026 is day 20766 of the epoch: even, the first entry.
    expect(out.rotation).toEqual({ configured: ["gemini", "anthropic"], today: "gemini" });
    expect(out.enoughSamples).toBe(false);
    expect(out.auditJudgedBySameProvider).toBe(true);
    expect(out.arms.map((arm: { provider: string }) => arm.provider)).toEqual(["anthropic", "gemini"]);

    const [anthropic, gemini] = out.arms;
    expect(anthropic.enoughSamples).toBe(false);
    expect(anthropic.articles).toEqual({
      count: 1,
      settled: 1,
      skipped: 0,
      failed: 0,
      skippedOrFailedRate: 0,
      neededRevisionRate: 1,
      needsReviewRate: 0,
      avgGateIssuesBeforeRevision: 3,
      avgWordCount: 1800,
      auditScore: 88,
      auditScoreSamples: 1,
      auditJudgedBySameProvider: true,
    });
    expect(anthropic.agents).toEqual([
      expect.objectContaining({ agent: "aeo-audit", samples: 1, fallbackRuns: 0, avgDurationMs: 5000 }),
      expect.objectContaining({ agent: "outline", samples: 1, avgDurationMs: 4000 }),
      expect.objectContaining({
        agent: "writing",
        samples: 1,
        avgDurationMs: 30_000,
        models: [{ model: "claude-sonnet-5-5", runs: 1 }],
      }),
    ]);
    // 1 to 28 October, fully ingested: the row of 5 November is day 36 and the SERP row is not Search Console's.
    expect(anthropic.downstream).toEqual({
      windowDays: 28,
      measuredArticles: 1,
      waitingArticles: 0,
      excludedArticles: 0,
      impressions: 120,
      clicks: 3,
      impressionsPerArticle: 120,
      clicksPerArticle: 3,
      averagePosition: 9,
    });

    expect(gemini.articles).toMatchObject({
      count: 2,
      settled: 1,
      skipped: 1,
      failed: 0,
      skippedOrFailedRate: 0.5,
      needsReviewRate: 1,
      avgGateIssuesBeforeRevision: 5,
      avgWordCount: 1200,
      auditScore: 61,
      auditScoreSamples: 1,
    });
    // The writer's run on the Gemini day was Claude's: counted, never averaged, nothing from another site.
    expect(gemini.agents.find((a: { agent: string }) => a.agent === "writing")).toMatchObject({
      samples: 0,
      fallbackRuns: 1,
      avgDurationMs: null,
      models: [],
    });
    expect(gemini.agents.find((a: { agent: string }) => a.agent === "serp-analysis")).toMatchObject({ samples: 1, avgDurationMs: 3000 });
    // Nothing published on this arm: not measured, not zero.
    expect(gemini.downstream).toMatchObject({ measuredArticles: 0, impressions: null, clicks: null, averagePosition: null });

    expect(JSON.stringify(out)).not.toContain("SECRET");
    // What a run costs the platform is the owner's, never in the tool's answer.
    expect(JSON.stringify(out)).not.toMatch(/cost/i);
    // No field says who won; the only mention is the note that nobody is declared.
    expect(JSON.stringify({ ...out, notes: [] })).not.toMatch(/winner|better|best/i);
    expect(out.notes[0]).toMatch(/^No winner is declared/);
  });

  it("reads only the window asked for", async () => {
    const run = await runTool(apiCaller(db, { scopes: ["read"] }), "compare_article_providers", { days: 38 });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const out = run.output as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    // Since 2 October: only the skipped job of 3 October is left.
    expect(out.window).toMatchObject({ days: 38, jobsRead: 1, jobsWithArm: 1 });
    expect(out.arms.map((arm: { provider: string }) => arm.provider)).toEqual(["gemini"]);
    expect(out.arms[0].articles).toMatchObject({ count: 1, skipped: 1, needsReviewRate: null, auditScore: null });
  });

  it("answers the other site's own arms to a caller on it", async () => {
    const run = await runTool(apiCaller(db, { scopes: ["read"], businessId: B.business_id }), "compare_article_providers", {});
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const out = run.output as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(out.window.jobsRead).toBe(1);
    expect(out.arms.map((arm: { provider: string }) => arm.provider)).toEqual(["gemini"]);
    expect(out.arms[0].agents[0]).toMatchObject({ agent: "writing", samples: 1, models: [{ model: "gemini-2.5-pro", runs: 1 }] });
  });

  it("says there is no rotation when the variable is unset, and still reads what ran under one", async () => {
    vi.stubEnv("LLM_ARTICLE_ROTATION", "");
    const run = await runTool(apiCaller(db, { scopes: ["read"] }), "compare_article_providers", {});
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const out = run.output as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(out.rotation).toEqual({ configured: null, today: null });
    expect(out.arms).toHaveLength(2);
  });

  it("is refused to a key without the read scope, needs no spend, and needs a plan like every tool", async () => {
    const refused = await runTool(apiCaller(db, { scopes: ["write"] }), "compare_article_providers", {});
    expect(refused).toMatchObject({ ok: false, status: 403, error: { code: "forbidden_scope" } });
    const readOnly = await runTool(apiCaller(db, { scopes: ["read"] }), "compare_article_providers", {});
    expect(readOnly.ok).toBe(true);
    db.tables.subscriptions = [];
    const unpaid = await runTool(apiCaller(db, { scopes: ["read"] }), "compare_article_providers", {});
    expect(unpaid).toMatchObject({ ok: false, status: 402, error: { code: "subscription_required" } });
  });
});

describe("how a production job ended", () => {
  it("is settled when completed, skipped on the intent gate, failed otherwise, and settled when a draft was validated", () => {
    expect(jobOutcome({ status: "completed", lastError: null }, false)).toBe("settled");
    expect(jobOutcome({ status: "failed", lastError: INTENT_SKIP_REASON }, false)).toBe("skipped");
    expect(jobOutcome({ status: "failed", lastError: "The generated article failed validation: X" }, false)).toBe("failed");
    // A later step failed: the article exists, `onFailure` settled it.
    expect(jobOutcome({ status: "failed", lastError: "enrich exploded" }, true)).toBe("settled");
  });

  it("is unfinished while queued or running, and when the owner's subscription stopped it", () => {
    expect(jobOutcome({ status: "pending", lastError: null }, false)).toBe("unfinished");
    expect(jobOutcome({ status: "running", lastError: null }, false)).toBe("unfinished");
    expect(jobOutcome({ status: "failed", lastError: JOB_SUBSCRIPTION_INACTIVE_MESSAGE }, false)).toBe("unfinished");
  });
});
