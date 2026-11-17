import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeSupabase } from "../support/fake-supabase";
import { apiCaller } from "./support";
import { ART_A1, ART_A3, readSeed } from "./read-support";

/**
 * `get_results`, as an API-key caller on site A with the read scope only:
 * the Results screen's numbers from the function the screen calls, with the
 * citation rates per engine and labelled as sampled, and no pooled rate
 * anywhere. Site B's article (ranking 2nd) never counts.
 */

const m = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => m.db }));

import { runTool } from "@/lib/tools/runner";
import { loadResults } from "@/lib/lifecycle/load-results";

let db: FakeSupabase;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-09T12:00:00.000Z"));
  db = readSeed();
  m.db = db;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("get_results", () => {
  it("answers the Results screen's numbers, per engine and sampled", async () => {
    const caller = apiCaller(db, { scopes: ["read"] });
    const run = await runTool(caller, "get_results", {});
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const out = run.output as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const screen = await loadResults(caller.client, caller.businessId!);

    expect(out.articles.map((a: { articleId: string }) => a.articleId)).toEqual([ART_A1, ART_A3]);
    expect(out.articles[0]).toMatchObject({
      rank: { current: 6.5, samples: 1 },
      rankSource: "search_console",
      traffic: { impressions: 200, clicks: 9, windowDays: 28 },
      citations: { probes: 2, cited: 1, byEngine: [{ engine: "gemini", rate: 1 }, { engine: "perplexity", rate: 0 }] },
    });
    // Measured as absent: no position, but looked at once; not "never measured".
    expect(out.articles[1]).toMatchObject({ rank: { current: null, samples: 1 }, rankSource: "serp", traffic: { impressions: null } });

    expect(out.citationsByEngine).toEqual([
      { engine: "gemini", rate: 0.5, probes: 2, cited: 1 },
      { engine: "perplexity", rate: 0, probes: 1, cited: 0 },
    ]);
    expect(out.totals).toEqual({
      published: 2,
      rankMeasured: 2,
      ranking: 1,
      topTen: 1,
      averagePosition: 6.5,
      citationProbes: 3,
      impressions: 200,
      clicks: 9,
    });
    // No rate across engines, anywhere in the answer.
    expect(out.totals).not.toHaveProperty("citationRate");
    expect(out.articles[0].citations).not.toHaveProperty("rate");
    expect(out).toMatchObject({ citationsSampled: true, citationNote: expect.stringContaining("sampled") });

    // The same numbers as the screen's function, minus the pooled rates.
    expect(out.searchConsole).toEqual(screen.searchConsole);
    expect(out.traffic).toEqual(screen.traffic);
    expect(out.articles[0].rank).toEqual(screen.articles[0].rank);
    expect(out.searchConsole).toMatchObject({ status: "connected", siteUrl: "sc-domain:acme.test" });
    expect(JSON.stringify(out)).not.toContain("SECRET");
  });
});
