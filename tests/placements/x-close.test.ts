import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock("@/lib/notifications/email", () => ({ operatorEmailAddress: () => null, sendNotificationEmail: vi.fn() }));

import {
  X_CLOSE_CALL_WORST_USD,
  X_CLOSE_SOURCE,
  buildCloseQueries,
  closeAccountsFrom,
  closeTrialGate,
  closeTrialRecord,
  closeWindowStart,
  searchXCloseAccounts,
  type PostedReplyRow,
} from "@/lib/placements/x-close";
import { runXCloseTrial } from "@/lib/placements/x-close-cron";
import { xCloseTrialWorkflow } from "@/lib/jobs/workflows/x-close-trial";
import { isLlmBoundJob } from "@/lib/jobs/registry";
import type { StepContext } from "@/lib/jobs/types";
import { LedgerFake, fakeXClient, xPost } from "./x-fake";

/**
 * The close-accounts trial: the accounts come from the site's own posted
 * replies, the searches are `from:` ORs under 512 characters, at most two a
 * run, it runs only for a listed site before the end date, and each run
 * leaves one record of what it returned, dropped, qualified and cost.
 */

const NOW = new Date("2026-11-14T15:00:00.000Z");
const SITE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "11111111-1111-4111-8111-111111111111";
const ENV = { X_CLOSE_TRIAL_BUSINESS_IDS: SITE, X_API_ENABLED: "1", X_API_BEARER_TOKEN: "t", X_CLOSE_TRIAL_UNTIL: "2026-11-17" };

let quiet: Array<ReturnType<typeof vi.spyOn>>;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  env = { ...process.env };
  quiet = (["log", "warn", "error"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
});
afterEach(() => {
  process.env = env;
  quiet.forEach((spy) => spy.mockRestore());
});

const reply = (author: string, at: string, over: Partial<PostedReplyRow> = {}): PostedReplyRow => ({
  url: `https://x.com/${author}/status/1${at.replace(/\D/g, "")}`,
  author,
  published_url: `https://x.com/SamRivDev/status/2${at.replace(/\D/g, "")}?s=20`,
  published_at: at,
  ...over,
});

describe("closeAccountsFrom", () => {
  it("ranks the authors replied to by count, then recency, case folded, without the site's own account", () => {
    const rows = [
      reply("pat_builds", "2026-11-14T11:33:31.000Z"),
      reply("pat_builds", "2026-11-13T14:52:53.000Z"),
      reply("hank_ships", "2026-11-14T12:04:09.000Z"),
      reply("DanaShips", "2026-11-11T16:00:11.000Z"),
      reply("x", "2026-11-09T12:22:07.000Z", { url: "https://x.com/danaships/status/9", author: "DanaShips" }),
      reply("rob_codes", "2026-11-14T11:35:18.000Z"),
      // The site answering itself in a thread of its own.
      reply("SamRivDev", "2026-11-14T10:00:00.000Z"),
      // Older than 30 days.
      reply("old", "2026-10-01T10:00:00.000Z"),
    ];
    const accounts = closeAccountsFrom(rows, { now: NOW });
    expect(accounts.map((a) => [a.handle, a.replies])).toEqual([
      ["pat_builds", 2],
      ["danaships", 2],
      ["hank_ships", 1],
      ["rob_codes", 1],
    ]);
    expect(accounts[0].lastRepliedAt).toBe("2026-11-14T11:33:31.000Z");
  });

  it("takes the author from the stored handle when the URL has none, and keeps 25 at most", () => {
    const rows = Array.from({ length: 30 }, (_, i) => reply(`acct${i}`, `2026-11-${String(10 + (i % 4)).padStart(2, "0")}T10:00:00.000Z`));
    rows.push({ url: "https://x.com/i/web/status/5", author: "@Fromauthor", published_url: null, published_at: "2026-11-14T09:00:00.000Z" });
    const accounts = closeAccountsFrom(rows, { now: NOW, ownHandle: "samrivdev" });
    expect(accounts).toHaveLength(25);
    expect(accounts[0].handle).toBe("fromauthor");
  });
});

describe("buildCloseQueries", () => {
  it("writes one from: OR with the filters when the handles fit", () => {
    const { queries, dropped } = buildCloseQueries(["pat_builds", "hank_ships"], "en");
    expect(queries.map((q) => q.query)).toEqual(["(from:pat_builds OR from:hank_ships) lang:en -is:retweet -is:reply"]);
    expect(dropped).toEqual([]);
    expect(buildCloseQueries(["pat_builds"], "it").queries[0].query).toBe("from:pat_builds lang:it -is:retweet -is:reply");
  });

  it("splits under 512 characters, keeps rank order, and drops what two searches cannot hold", () => {
    const handles = Array.from({ length: 80 }, (_, i) => `handle_${String(i).padStart(8, "0")}`);
    const { queries, dropped } = buildCloseQueries(handles, "en");
    expect(queries).toHaveLength(2);
    for (const q of queries) {
      expect(q.query.length).toBeLessThanOrEqual(512);
      expect(q.query.endsWith("lang:en -is:retweet -is:reply")).toBe(true);
    }
    expect([...queries[0].handles, ...queries[1].handles, ...dropped]).toEqual(handles);
    expect(dropped.length).toBeGreaterThan(0);
  });

  it("never writes something that is not a handle as an operator", () => {
    const { queries } = buildCloseQueries(["ok_one", "bad handle", "-is:x", "waytoolonghandle123"], "en");
    expect(queries[0].query).toBe("from:ok_one lang:en -is:retweet -is:reply");
  });
});

describe("closeTrialGate", () => {
  it("runs only for a listed site with the X API on, before the end date", () => {
    expect(closeTrialGate(SITE, NOW, ENV)).toEqual({ ok: true });
    expect(closeTrialGate("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", NOW, ENV).ok).toBe(false);
    expect(closeTrialGate(SITE, NOW, { ...ENV, X_API_ENABLED: "" }).ok).toBe(false);
    expect(closeTrialGate(SITE, new Date("2026-11-17T00:00:00.000Z"), ENV)).toEqual({ ok: false, reason: "the trial ended on 2026-11-17" });
    expect(closeTrialGate(SITE, new Date("2026-11-16T21:00:00.000Z"), ENV).ok).toBe(true);
    expect(closeTrialGate(SITE, NOW, { ...ENV, X_CLOSE_TRIAL_UNTIL: "soon" }).ok).toBe(false);
    expect(closeTrialGate(SITE, NOW, { ...ENV, X_CLOSE_TRIAL_UNTIL: undefined }).ok).toBe(true);
    expect(closeTrialGate(SITE, NOW, { ...ENV, X_CLOSE_TRIAL_BUSINESS_IDS: undefined }).ok).toBe(false);
  });
});

describe("closeWindowStart", () => {
  it("starts at the last run's search, never more than three hours back", () => {
    expect(closeWindowStart(null, NOW).toISOString()).toBe("2026-11-14T12:00:00.000Z");
    expect(closeWindowStart("2026-11-14T13:30:00.000Z", NOW).toISOString()).toBe("2026-11-14T13:30:00.000Z");
    expect(closeWindowStart("2026-11-13T21:00:00.000Z", NOW).toISOString()).toBe("2026-11-14T12:00:00.000Z");
  });
});

function seed(extra: Record<string, Record<string, unknown>[]> = {}) {
  return new LedgerFake({
    businesses: [
      { id: SITE, user_id: USER, name: "GetTrafficFast", niche: "SEO", website_url: "https://gettrafficfa.st", content_language: "en", aeo_settings: {}, voice_settings: { findPostsOnX: true } },
    ],
    placement_targets: [
      { id: "r1", user_id: USER, business_id: SITE, surface: "x", external_id: "status:11", url: "https://x.com/pat_builds/status/11", author: "pat_builds", status: "published_manually", published_at: "2026-11-14T11:00:00.000Z", published_url: "https://x.com/SamRivDev/status/21", title: "a", content_hash: "h1" },
      { id: "r2", user_id: USER, business_id: SITE, surface: "x", external_id: "status:12", url: "https://x.com/hank_ships/status/12", author: "hank_ships", status: "published_manually", published_at: "2026-11-13T11:00:00.000Z", published_url: "https://x.com/SamRivDev/status/22", title: "b", content_hash: "h2" },
    ],
    jobs: [],
    job_steps: [],
    ...extra,
  });
}

describe("searchXCloseAccounts", () => {
  it("searches the close accounts once under the cap and stores what X returned as x_close rows, the authors replied to included", async () => {
    const db = seed();
    const { client, searchRecent } = fakeXClient({ searches: [[xPost("100", { handle: "pat_builds" }), xPost("101", { handle: "hank_ships" }), xPost("102", { handle: "samrivdev" })]] });
    const out = await searchXCloseAccounts({
      supabase: db as never,
      client,
      business: { id: SITE, user_id: USER, content_language: "en" },
      windowStart: new Date("2026-11-14T12:00:00.000Z"),
      now: NOW,
    });
    expect(searchRecent).toHaveBeenCalledTimes(1);
    expect((searchRecent.mock.calls[0] as unknown as [{ query: string; maxResults: number; startTime: Date }])[0]).toMatchObject({
      query: "(from:pat_builds OR from:hank_ships) lang:en -is:retweet -is:reply",
      maxResults: 25,
      startTime: new Date("2026-11-14T12:00:00.000Z"),
    });
    expect(out).toMatchObject({ handles: ["pat_builds", "hank_ships"], fewHandles: true, returned: 3, stored: 2, truncated: false, costUsd: 0.015 });
    expect(out.skipped.own).toBe(1);
    expect(out.skipped.recentAuthor).toBe(0);
    const stored = db.tables.placement_targets.filter((r) => r.found_via === X_CLOSE_SOURCE);
    expect(stored.map((r) => r.external_id).sort()).toEqual(["status:100", "status:101"]);
    // The worst case was reserved, and settled to what X returned.
    expect(X_CLOSE_CALL_WORST_USD).toBe(0.375);
    expect(Number(db.spend("2026-11-01")?.cost_usd)).toBe(0.015);
  });
});

describe("the trial job", () => {
  const step = (name: string) => xCloseTrialWorkflow.steps.find((s) => s.name === name)!;
  const ctx = (db: LedgerFake, outputs: Record<string, unknown> = {}): StepContext => ({
    job: { id: "job-1", user_id: USER, article_id: null, type: "x-close-trial", input: { businessId: SITE }, status: "running", current_step: null, attempts: 1, max_attempts: 2, last_error: null },
    supabase: db as never,
    input: { businessId: SITE },
    outputs,
  });

  it("is model-bound, and its steps are the daily search's plus a measure", () => {
    expect(isLlmBoundJob("x-close-trial")).toBe(true);
    expect(xCloseTrialWorkflow.steps.map((s) => s.name)).toEqual(["search", "rules", "qualify", "draft", "measure"]);
  });

  it("searches nothing for a site not in the trial, or after it ended", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    Object.assign(process.env, { ...ENV, X_CLOSE_TRIAL_BUSINESS_IDS: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
    expect(await step("search").run(ctx(seed()))).toEqual({ skipped: "site not in X_CLOSE_TRIAL_BUSINESS_IDS" });
    Object.assign(process.env, { ...ENV, X_CLOSE_TRIAL_UNTIL: "2026-01-01" });
    expect(await step("search").run(ctx(seed()))).toEqual({ skipped: "the trial ended on 2026-01-01" });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("measures a run in one record and one log line", async () => {
    const outputs = {
      search: { handles: ["a", "b"], fewHandles: true, queries: ["q"], calls: 1, returned: 7, truncated: false, stored: 6, skipped: { duplicate: 1, recentAuthor: 0, crowded: 0, own: 0, empty: 0 }, costUsd: 0.035, stopped: null, windowStart: "w", searchedAt: "s" },
      rules: { considered: 6, rejected: 3, byRule: { x_promo: 2, x_link_share: 1 } },
      qualify: { judged: 3, qualified: 1, rejected: 2, undecided: 0 },
      draft: { started: 1 },
    };
    const record = await step("measure").run(ctx(seed(), outputs));
    expect(record).toMatchObject({ handlesWatched: 2, queries: 1, returned: 7, stored: 6, droppedByRule: { x_promo: 2, x_link_share: 1 }, qualified: 1, rejectedByQualifier: 2, drafted: 1, costUsd: 0.035 });
    const line = (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0])).find((l) => l.includes("x_close_trial"));
    expect(JSON.parse(line!)).toMatchObject({ event: "x_close_trial", business_id: SITE, returned: 7 });
  });

  it("records a skipped run as not measured, never as zero judged", () => {
    const record = closeTrialRecord({ search: { skipped: "site not in X_CLOSE_TRIAL_BUSINESS_IDS" }, rules: { considered: 0, rejected: 0 } });
    expect(record).toMatchObject({ skippedReason: "site not in X_CLOSE_TRIAL_BUSINESS_IDS", returned: 0, skipped: null, judged: null, qualified: null, drafted: null });
  });
});

describe("runXCloseTrial", () => {
  it("does nothing without a listed site", async () => {
    const db = seed();
    expect(await runXCloseTrial({ admin: db as never, now: NOW, env: {} })).toMatchObject({ skipped: "no site in X_CLOSE_TRIAL_BUSINESS_IDS", enqueued: [] });
    expect(db.tables.jobs).toEqual([]);
  });

  it("enqueues a listed site whose stored Find posts on X says off: the switch is gone", async () => {
    Object.assign(process.env, ENV);
    const db = seed({ subscriptions: [{ user_id: USER, status: "active", current_period_end: null }], agent_runs: [] });
    db.tables.businesses[0].voice_settings = { findPostsOnX: false };
    const out = await runXCloseTrial({ admin: db as never, now: NOW, env: ENV });
    expect(out.skippedSites).toEqual([]);
    expect(out.enqueued).toEqual([SITE]);
  });

  it("does not enqueue after the end date", async () => {
    Object.assign(process.env, ENV);
    const db = seed();
    const out = await runXCloseTrial({ admin: db as never, now: new Date("2026-11-17T06:00:00.000Z"), env: ENV });
    expect(out.enqueued).toEqual([]);
    expect(out.skippedSites[0].reason).toBe("the trial ended on 2026-11-17");
    expect(db.tables.jobs).toEqual([]);
  });
});
