import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeSupabase } from "../support/fake-supabase";
import { apiCaller } from "./support";
import { ART_A1, ART_A3, RUN_A2, readSeed } from "./read-support";

/**
 * `get_growth` and `list_ai_answers`, as an API-key caller on site A with
 * the read scope only: Growth's numbers from the function the screen's route
 * calls (lib/growth/read.ts), per engine, sampled, null for what nobody
 * measured; site B's probe (cited, the same day) never counts and never
 * shows.
 */

const m = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => m.db }));

import { runTool } from "@/lib/tools/runner";
import { listAiAnswers, loadGrowth } from "@/lib/growth/read";

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = Record<string, any>;

describe("get_growth", () => {
  it("answers the three blocks of the screen, per engine, nulls as nulls", async () => {
    const caller = apiCaller(db, { scopes: ["read"] });
    const run = await runTool(caller, "get_growth", {});
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const out = run.output as Any;

    expect(out.days).toBe(7);
    // Google: the week ending on the watermark (Nov 6); the week before is older than the data.
    expect(out.google.current).toEqual({ from: "2026-10-31", to: "2026-11-06", impressions: 200, clicks: 9, averagePosition: 6.5 });
    expect(out.google.previous).toBeNull();
    expect(out.google.change).toEqual({ impressions: null, clicks: null, averagePosition: null });
    expect(JSON.stringify(out.google)).not.toContain("SECRET");

    // AI answers: both families, per engine; B's cited probe of Nov 9 is not here.
    expect(out.ai.window.current).toEqual({ from: "2026-11-03", to: "2026-11-09" });
    expect(out.ai.engines).toEqual([
      {
        engine: "gemini",
        current: { asks: 3, cited: 2, rate: 2 / 3 },
        previous: { asks: 1, cited: 0, rate: 0 },
        byKind: { prompts: { asks: 1, cited: 1, rate: 1 }, articles: { asks: 2, cited: 1, rate: 0.5 } },
        unreadable: 0,
      },
      {
        engine: "perplexity",
        current: { asks: 1, cited: 0, rate: 0 },
        previous: { asks: 1, cited: 0, rate: 0 },
        byKind: { prompts: { asks: 0, cited: 0, rate: null }, articles: { asks: 1, cited: 0, rate: 0 } },
        unreadable: 1,
      },
    ]);
    expect(out.ai).toMatchObject({ sampled: true, prompts: { total: 2, enabled: 1 }, lastAskedAt: "2026-11-08T10:00:00.000Z" });
    expect(out.ai.note).toMatch(/Sampled/);

    // Replies on X: no reply posted, the X API is not set up in tests.
    expect(out.replies).toMatchObject({ days: 7, status: "off_platform", week: { posted: 0, views: null } });

    // The same answer as the screen's function.
    const screen = await loadGrowth(caller.client, caller.businessId!, { days: 7, xApiEnabled: false });
    expect({ ...out, generatedAt: "" }).toEqual({ ...JSON.parse(JSON.stringify(screen)), generatedAt: "" });
  });

  it("reads 28 days when asked, and refuses another period", async () => {
    const caller = apiCaller(db, { scopes: ["read"] });
    const run = await runTool(caller, "get_growth", { days: 28 });
    expect(run.ok).toBe(true);
    if (run.ok) expect((run.output as Any).ai.window.current).toEqual({ from: "2026-10-13", to: "2026-11-09" });
    const bad = await runTool(caller, "get_growth", { days: 30 });
    expect(bad.ok).toBe(false);
  });
});

describe("list_ai_answers", () => {
  it("lists the week's answers of the caller's site, newest first, with what is stored", async () => {
    const caller = apiCaller(db, { scopes: ["read"] });
    const run = await runTool(caller, "list_ai_answers", {});
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const out = run.output as Any;

    expect(out.window).toEqual({ from: "2026-11-03", to: "2026-11-09" });
    expect(out.engines).toEqual(["gemini", "perplexity"]);
    expect(out.total).toBe(5);
    expect(out.answers.map((a: Any) => [a.kind, a.engine, a.status, a.counted])).toEqual([
      ["prompt", "gemini", "cited", true],
      ["prompt", "perplexity", "error", false],
      ["article", "gemini", "not_cited", true],
      ["article", "gemini", "cited", true],
      ["article", "perplexity", "not_cited", true],
    ]);
    const cited = out.answers[0];
    expect(cited).toMatchObject({ question: "best ai seo tool", ourPosition: 1, citedUrl: "https://acme.test/ai-seo", sourcesKept: true, excerpt: "An answer." });
    expect(cited.sources).toEqual([
      { position: 1, url: "https://rival.test/x", domain: "rival.test", title: "Rival", opensPage: true, ours: false, inToday: false },
    ]);
    const article = out.answers.find((a: Any) => a.kind === "article" && a.status === "cited");
    expect(article).toMatchObject({ articleId: ART_A1, sources: [], sourcesKept: false });
    expect(out.answers.some((a: Any) => a.articleId === ART_A3)).toBe(true);
    // Site B asked the same question on Nov 9 and was cited: not here.
    expect(out.answers.filter((a: Any) => a.askedAt.startsWith("2026-11-09"))).toEqual([]);
    expect(out.answers[0].id).toContain(`prompt:`);
    expect(JSON.stringify(out)).not.toContain(RUN_A2);
  });

  it("filters by engine and pages", async () => {
    const caller = apiCaller(db, { scopes: ["read"] });
    const gemini = await runTool(caller, "list_ai_answers", { engine: "gemini", limit: 2 });
    expect(gemini.ok).toBe(true);
    if (!gemini.ok) return;
    const page = gemini.output as Any;
    expect(page.total).toBe(3);
    expect(page.answers).toHaveLength(2);
    expect(page.nextOffset).toBe(2);
    const next = await listAiAnswers(caller.client, caller.businessId!, { days: 7, engine: "gemini", offset: 2, limit: 2 });
    expect(next.answers).toHaveLength(1);
    expect(next.nextOffset).toBeNull();
  });
});
