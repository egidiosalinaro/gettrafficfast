import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock("@/lib/notifications/email", () => ({ operatorEmailAddress: () => null, sendNotificationEmail: vi.fn() }));

import {
  X_CLOSE_CALL_WORST_USD,
  X_CLOSE_MAX_QUERIES,
  X_CLOSE_RESULTS_PER_QUERY,
  X_CLOSE_SOURCE,
  X_CLOSE_WINDOW_HOURS,
  buildCloseQueries,
  closeAccountsFrom,
  closeWindowStart,
  searchXCloseAccounts,
  type PostedReplyRow,
} from "@/lib/placements/x-close";
import { xCloseTrialWorkflow } from "@/lib/jobs/workflows/x-close-trial";
import { xDiscoveryWorkflow } from "@/lib/jobs/workflows/x-discovery";
import { isLlmBoundJob, workflowTypes } from "@/lib/jobs/registry";
import type { StepContext } from "@/lib/jobs/types";
import { XApiClient } from "@/lib/providers/x/api";
import { LedgerFake, fakeXClient, xPost } from "./x-fake";

/**
 * The close accounts, permanent since 2026-11-24: the accounts come from
 * the site's own posted replies, the searches are `from:` ORs under 512
 * characters, at most two a run of 25 posts each over 12 hours, and they
 * are the `close` step of every site's daily X job, with no list of sites
 * and no end date.
 */

const NOW = new Date("2026-11-14T15:00:00.000Z");
const SITE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "11111111-1111-4111-8111-111111111111";
const ENV = { X_API_ENABLED: "1", X_API_BEARER_TOKEN: "t" };

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

describe("closeWindowStart", () => {
  it("starts at the last run's search, never more than 12 hours back", () => {
    expect(X_CLOSE_WINDOW_HOURS).toBe(12);
    expect(closeWindowStart(null, NOW).toISOString()).toBe("2026-11-14T03:00:00.000Z");
    expect(closeWindowStart("2026-11-14T13:30:00.000Z", NOW).toISOString()).toBe("2026-11-14T13:30:00.000Z");
    expect(closeWindowStart("2026-11-13T15:00:00.000Z", NOW).toISOString()).toBe("2026-11-14T03:00:00.000Z");
  });
});

describe("the bounds", () => {
  it("two searches of 25 posts a site a run, 50 handles never more than two queries", () => {
    expect(X_CLOSE_MAX_QUERIES).toBe(2);
    expect(X_CLOSE_RESULTS_PER_QUERY).toBe(25);
    const handles = Array.from({ length: 60 }, (_, i) => `account_${i}`);
    expect(buildCloseQueries(handles, "en").queries.length).toBeLessThanOrEqual(X_CLOSE_MAX_QUERIES);
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

describe("the close step of the daily X job", () => {
  const step = (name: string) => xDiscoveryWorkflow.steps.find((s) => s.name === name)!;
  const ctx = (db: LedgerFake, jobId = "job-1"): StepContext => ({
    job: { id: jobId, user_id: USER, article_id: null, type: "x-post-discovery", input: { businessId: SITE }, status: "running", current_step: null, attempts: 1, max_attempts: 2, last_error: null },
    supabase: db as never,
    input: { businessId: SITE },
    outputs: {},
  });

  it("runs between the topic search and the shared rules, qualifier and drafts", () => {
    expect(xDiscoveryWorkflow.steps.map((s) => s.name)).toEqual(["search", "close", "rules", "qualify", "draft"]);
    expect(isLlmBoundJob("x-post-discovery")).toBe(true);
  });

  it("searches any site's close accounts with the X API on: no list of sites, no end date", async () => {
    Object.assign(process.env, ENV);
    delete process.env.X_CLOSE_TRIAL_BUSINESS_IDS;
    delete process.env.X_CLOSE_TRIAL_UNTIL;
    const searchRecent = vi
      .spyOn(XApiClient.prototype, "searchRecent")
      .mockResolvedValue({ posts: [xPost("300", { handle: "pat_builds" })], missingIds: [], billedPosts: 1, costUsd: 0.005 });
    const db = seed();
    const out = (await step("close").run(ctx(db))) as { calls: number; stored: number; windowStart: string };
    expect(searchRecent).toHaveBeenCalledTimes(1);
    expect((searchRecent.mock.calls[0] as unknown as [{ query: string; maxResults: number }])[0]).toMatchObject({
      query: "(from:pat_builds OR from:hank_ships) lang:en -is:retweet -is:reply",
      maxResults: 25,
    });
    expect(out).toMatchObject({ calls: 1, stored: 1 });
    expect(db.tables.placement_targets.filter((r) => r.found_via === X_CLOSE_SOURCE).map((r) => r.external_id)).toEqual(["status:300"]);
    const line = (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0])).find((l) => l.includes('"x_close"'));
    expect(JSON.parse(line!)).toMatchObject({ event: "x_close", business_id: SITE, calls: 1, stored: 1 });
    searchRecent.mockRestore();
  });

  it("starts where the site's last daily run searched its close accounts", async () => {
    Object.assign(process.env, ENV);
    const searchRecent = vi.spyOn(XApiClient.prototype, "searchRecent").mockResolvedValue({ posts: [], missingIds: [], billedPosts: 0, costUsd: 0 });
    const last = new Date(Date.now() - 5 * 3_600_000).toISOString();
    const db = seed({
      jobs: [{ id: "job-0", business_id: SITE, type: "x-post-discovery", created_at: last }],
      job_steps: [{ job_id: "job-0", step: "close", status: "completed", output: { searchedAt: last } }],
    });
    await step("close").run(ctx(db));
    const startTime = (searchRecent.mock.calls[0] as unknown as [{ startTime: Date }])[0].startTime;
    expect(startTime.toISOString()).toBe(last);
    searchRecent.mockRestore();
  });

  it("makes no call for a site with no reply posted on X, and none without the X API", async () => {
    Object.assign(process.env, ENV);
    const searchRecent = vi.spyOn(XApiClient.prototype, "searchRecent");
    const empty = seed({ placement_targets: [] });
    expect(await step("close").run(ctx(empty))).toMatchObject({ handles: [], calls: 0 });
    delete process.env.X_API_ENABLED;
    expect(await step("close").run(ctx(seed()))).toEqual({ skipped: "the X API is not turned on for this deployment" });
    expect(searchRecent).not.toHaveBeenCalled();
    searchRecent.mockRestore();
  });
});

describe("the retired trial job type", () => {
  it("stays registered so a stored row is known, does nothing, and is not model-bound", async () => {
    expect(workflowTypes()).toContain("x-close-trial");
    expect(isLlmBoundJob("x-close-trial")).toBe(false);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const out = await xCloseTrialWorkflow.steps[0].run({
      job: { id: "old", user_id: USER, article_id: null, type: "x-close-trial", input: { businessId: SITE }, status: "running", current_step: null, attempts: 1, max_attempts: 2, last_error: null },
      supabase: seed() as never,
      input: { businessId: SITE },
      outputs: {},
    });
    expect(out).toMatchObject({ skipped: expect.stringContaining("daily X run") });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
