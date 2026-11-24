import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeSupabase } from "../support/fake-supabase";
import { apiCaller, SITE_A, USER } from "./support";
import { ART_A2, KW_A3, KW_A4, QUALITY, readSeed } from "./read-support";

/**
 * `get_content`: what the Content screen shows, read by the function GET
 * /api/content reads, as an API-key caller on site A with the read scope
 * only. Site B's rows never show; a held article says why; topics say where
 * they came from and an old one says it was not recorded.
 */

const m = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => m.db }));

import { runTool } from "@/lib/tools/runner";

let db: FakeSupabase;
beforeEach(() => {
  // Thursday 12 November 2026, the day ART_A2 is scheduled for.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-12T10:00:00.000Z"));
  db = readSeed();
  m.db = db;
});
afterEach(() => vi.useRealTimers());

const call = (input: Record<string, unknown> = {}) => runTool(apiCaller(db, { scopes: ["read"] }), "get_content", input);

describe("get_content", () => {
  it("answers today's article, the week Monday to Sunday and the site's counts", async () => {
    const run = await call();
    expect(run.ok, JSON.stringify(run).slice(0, 300)).toBe(true);
    if (!run.ok) return;
    const out = run.output as Record<string, unknown> & { week: Array<Record<string, unknown>> };
    expect(out).toMatchObject({
      today: "2026-11-12",
      site: { host: "acme.test" },
      autopilot: true,
      todayArticle: { id: ART_A2, day: "2026-11-12", title: "aeo", status: "scheduled", articleStatus: "queued", reasons: [] },
      // Autopilot is on: it adds the questions itself, so they are not counted.
      questionsWaiting: null,
      articlesTotal: 3,
    });
    expect(out.week.map((d) => [d.day, d.weekday, d.isToday])).toEqual([
      ["2026-11-09", "Mon", false],
      ["2026-11-10", "Tue", false],
      ["2026-11-11", "Wed", false],
      ["2026-11-12", "Thu", true],
      ["2026-11-13", "Fri", false],
      ["2026-11-14", "Sat", false],
      ["2026-11-15", "Sun", false],
    ]);
    // Only the 12th has an article; ART_A1 (1 Nov) is another week.
    expect(out.week.filter((d) => d.article).map((d) => (d.article as { id: string }).id)).toEqual([ART_A2]);
  });

  it("lists the next topics in Autopilot's order, with where each came from", async () => {
    db.tables.keywords.find((k) => k.id === KW_A4)!.source = "autopilot";
    const run = await call();
    if (!run.ok) throw new Error(JSON.stringify(run));
    expect(run.output.nextTopics).toEqual([
      { id: KW_A3, keyword: "llm seo checklist", source: "unknown", sourceUrl: null, starred: false, intent: "product_adjacent" },
      { id: KW_A4, keyword: "enterprise seo", source: "autopilot", sourceUrl: null, starred: true, intent: "product_adjacent" },
    ]);
    expect(run.output).toMatchObject({ topicsTotal: 2, topicsHeldBack: 0, overlapGroups: 0 });
    const one = await call({ topics: 1 });
    expect(one.ok && one.output).toMatchObject({ nextTopics: [{ id: KW_A3 }], topicsTotal: 2 });
  });

  it("says why a held article waits", async () => {
    Object.assign(db.tables.articles.find((a) => a.id === ART_A2)!, { status: "needs_review", quality_report: QUALITY });
    const run = await call();
    if (!run.ok) throw new Error(JSON.stringify(run));
    expect(run.output.todayArticle).toMatchObject({ status: "waiting", reasons: ["Too short."] });
  });

  it("counts the questions people ask while Autopilot is off", async () => {
    db.tables.businesses.find((b) => b.id === SITE_A)!.automation_settings = { enabled: false };
    db.tables.placement_targets.push({
      id: "t-q",
      user_id: USER,
      business_id: SITE_A,
      surface: "reddit",
      kind: "thread",
      title: "Is answer engine optimization worth it for a small SaaS?",
      url: "https://www.reddit.com/r/SaaS/comments/9/",
      status: "qualified",
      created_at: "2026-11-10T00:00:00.000Z",
    });
    const run = await call();
    if (!run.ok) throw new Error(JSON.stringify(run));
    expect(run.output).toMatchObject({ autopilot: false, questionsWaiting: 1 });
  });

  it("says Autopilot has not run yet for a site with no run recorded, and nothing while it is off", async () => {
    const run = await call();
    if (!run.ok) throw new Error(JSON.stringify(run));
    expect(run.output.autopilotRun).toMatchObject({ state: "not_run_yet", lastRun: null });
    expect((run.output.autopilotRun as { message: string }).message).toContain("06:00 UTC");
    db.tables.businesses.find((b) => b.id === SITE_A)!.automation_settings = { enabled: false };
    const off = await call();
    expect(off.ok && off.output.autopilotRun).toBeNull();
  });

  it("says why the last run left days empty, in words and with the reasons", async () => {
    db.tables.businesses.find((b) => b.id === SITE_A)!.autopilot_run = {
      at: "2026-11-12T06:00:00.000Z",
      scheduled: 0,
      topicsAdded: 0,
      questionsAdded: 0,
      emptyDays: 14,
      bufferDays: 14,
      reasons: [
        { code: "pool_overlaps", message: "3 topics in the pool were not scheduled: each overlaps a topic already published or on the calendar." },
        { code: "no_new_topics", message: "The top-up looked for 10 new topics and found none." },
        { code: "days_empty", message: "14 days of the next 14 have no article: no topic was left to schedule." },
      ],
    };
    const run = await call();
    if (!run.ok) throw new Error(JSON.stringify(run));
    expect(run.output.autopilotRun).toMatchObject({
      state: "stalled",
      message: "14 days of the next 14 have no article: no topic was left to schedule.",
      lastRun: { emptyDays: 14, reasons: [{ code: "pool_overlaps" }, { code: "no_new_topics" }, { code: "days_empty" }] },
    });
  });

  it("an empty day today is null, never an invented article", async () => {
    db.tables.articles = db.tables.articles.filter((a) => a.id !== ART_A2);
    const run = await call();
    if (!run.ok) throw new Error(JSON.stringify(run));
    expect(run.output.todayArticle).toBeNull();
    expect((run.output.week as Array<{ article: unknown }>).every((d) => d.article === null)).toBe(true);
    expect(run.output.articlesTotal).toBe(2);
  });
});
