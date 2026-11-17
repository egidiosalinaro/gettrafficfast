import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CitationAnswer, CitationProvider } from "@/lib/providers/citations/types";
import { setCitationProviders } from "@/lib/providers/citations/registry";
import { runJobNow } from "@/lib/jobs/worker";
import { AEO_RUN } from "@/lib/jobs/workflows/aeo-run";
import { AI_VISIBILITY_SOURCE, parseAiCitation } from "@/lib/placements/ai-citation";
import { startVisibilityRun } from "@/lib/visibility/manage";
import { loadOverview } from "@/lib/visibility/read";
import { startRun } from "@/lib/visibility/store";
import { FakeSupabase } from "../support/fake-supabase";

/**
 * Places to reply happen by themselves: every visibility run that completes
 * ends with its cited pages in the Replies inbox, whoever started it. The
 * scheduled run (`startRun`, as the cron calls it) and Run now (the screen's
 * route and `run_visibility_check` both call `startVisibilityRun`) go
 * through the real worker here, step by step, with nothing stored in the
 * site's settings. Pinned: the places are there, once, with this run's
 * sighting; nothing paid is started for them (no draft job, no model run,
 * no placement); a second run adds no duplicate and the Prompts page's
 * line counts what the latest run cited; a stored `false` is honoured.
 */

const mocks = vi.hoisted(() => ({ captured: [] as unknown[] }));
// The owner pays and is under the daily ceiling: the worker's two gates for a paid job.
vi.mock("@/lib/paid-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/paid-access")>()),
  hasPaidAccess: async () => true,
}));
vi.mock("@/lib/limits/spend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/limits/spend")>()),
  checkAccountSpend: async () => ({ ok: true, spend: null }),
}));
vi.mock("@sentry/nextjs", () => ({
  captureException: (err: unknown) => mocks.captured.push(err),
  captureMessage: () => undefined,
}));

const THREAD = "https://www.reddit.com/r/SEO/comments/1xyz111/which_tool_tracks_ai_answers/";

function engine(name: string): CitationProvider {
  return {
    name,
    probe: async (q): Promise<CitationAnswer> => ({
      engine: name,
      query: q.query,
      answer: "Rival is a popular choice.",
      sources: [
        { url: THREAD, domain: "reddit.com", title: "Which tool tracks AI answers? : r/SEO" },
        { url: "https://rival.test/pricing", domain: "rival.test", title: "" },
      ],
      raw: {},
      model: "sonar",
      costUsd: 0.005,
    }),
  };
}

function seed(aeoSettings: Record<string, unknown> | null = {}) {
  return new FakeSupabase({
    businesses: [{ id: "biz-1", user_id: "user-1", name: "Acme", website_url: "https://acme.test", content_language: "en", aeo_settings: aeoSettings }],
    aeo_queries: [{ id: "q1", user_id: "user-1", business_id: "biz-1", query: "best tool to track ai answers", cluster: null, enabled: true, created_at: "2026-11-01" }],
    competitors: [{ user_id: "user-1", business_id: "biz-1", domain: "rival.test", name: "Rival" }],
    aeo_runs: [],
    aeo_probes: [],
    placement_targets: [],
    placements: [],
  });
}

const client = (db: FakeSupabase) => db as unknown as SupabaseClient;

describe("places after every completed run", () => {
  beforeEach(() => {
    mocks.captured.length = 0;
    setCitationProviders([engine("perplexity")]);
    // Direct addresses need no lookup; nothing else may be fetched.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
  });

  afterEach(() => {
    setCitationProviders(undefined);
    vi.unstubAllGlobals();
  });

  it("a scheduled run ends with its cited pages in Replies, and nothing paid started for them", async () => {
    const db = seed();
    const { runId, jobId } = await startRun({ supabase: client(db), userId: "user-1", businessId: "biz-1", trigger: "schedule" });

    expect(await runJobNow(client(db), jobId, 60_000)).toBe("completed");
    expect(mocks.captured).toEqual([]);
    expect(db.tables.aeo_runs.find((r) => r.id === runId)?.status).toBe("completed");
    expect(db.job(jobId)?.result).toMatchObject({ places: { created: 1, linked: 0 } });

    expect(db.tables.placement_targets).toHaveLength(1);
    const row = db.tables.placement_targets[0];
    expect(row).toMatchObject({ surface: "reddit", found_via: AI_VISIBILITY_SOURCE, status: "qualified", qualify_angle: null });
    expect(parseAiCitation(row.ai_citation)?.runId).toBe(runId);

    // The only job is the run itself: no draft was queued, no model asked.
    expect(db.tables.jobs.map((j) => j.type)).toEqual([AEO_RUN]);
    expect(db.tables.placements).toEqual([]);
    expect(db.tables.agent_runs).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("Run now (the route and run_visibility_check) does the same, and a second run adds no duplicate", async () => {
    const db = seed(null);
    const first = await startVisibilityRun({ supabase: client(db), admin: client(db), userId: "user-1", businessId: "biz-1" });
    if (!first.ok || first.alreadyRunning) throw new Error("the run did not start");
    expect(await runJobNow(client(db), first.jobId, 60_000)).toBe("completed");
    expect(db.tables.placement_targets).toHaveLength(1);

    const second = await startVisibilityRun({ supabase: client(db), admin: client(db), userId: "user-1", businessId: "biz-1" });
    if (!second.ok || second.alreadyRunning) throw new Error("the run did not start");
    expect(await runJobNow(client(db), second.jobId, 60_000)).toBe("completed");
    expect(db.job(second.jobId)?.result).toMatchObject({ places: { created: 0, linked: 1 } });

    // One row, now carrying the latest run's sighting: what the Prompts page counts.
    expect(db.tables.placement_targets).toHaveLength(1);
    expect(parseAiCitation(db.tables.placement_targets[0].ai_citation)?.runId).toBe(second.runId);
    // The fake database stamps no start time; the newer run is the second.
    for (const run of db.tables.aeo_runs) {
      run.started_at = run.id === second.runId ? "2026-11-13T09:00:00.000Z" : "2026-11-13T08:00:00.000Z";
    }
    const overview = await loadOverview(client(db), "biz-1");
    expect(overview.latestRun?.id).toBe(second.runId);
    expect(overview.places).toEqual({ open: 1, fromLatestRun: 1 });
    expect(overview.settings.placesFromSources).toBe(true);
  });

  it("a site whose owner turned it off gets no places, and the run still completes", async () => {
    const db = seed({ placesFromSources: false });
    const { runId, jobId } = await startRun({ supabase: client(db), userId: "user-1", businessId: "biz-1", trigger: "schedule" });

    expect(await runJobNow(client(db), jobId, 60_000)).toBe("completed");
    expect(db.tables.aeo_runs.find((r) => r.id === runId)?.status).toBe("completed");
    expect(db.job(jobId)?.result).toMatchObject({ places: { skipped: "off" } });
    expect(db.tables.placement_targets).toEqual([]);
    const overview = await loadOverview(client(db), "biz-1");
    expect(overview.places).toEqual({ open: 0, fromLatestRun: 0 });
  });
});
