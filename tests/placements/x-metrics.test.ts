import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock("@/lib/notifications/email", () => ({ operatorEmailAddress: () => null, sendNotificationEmail: vi.fn() }));

import { compactCount, mapReplyMetrics, metricsLine } from "@/lib/placements/reply-metrics";
import { loadReplyMetrics } from "@/lib/placements/reply-metrics-read";
import { pickRepliesToRead, refreshXReplyMetrics } from "@/lib/placements/x-metrics";
import { runXDaily } from "@/lib/placements/x-daily";
import { LedgerFake, fakeXClient, xPost } from "./x-fake";

/**
 * The numbers of posted replies: one batched lookup a day for the replies of
 * the last 14 days, a dated snapshot each, a null for every number X did not
 * return (never a 0), a row of nulls for a reply X did not hand back, and
 * nothing asked twice the same day. And the gate in front of all of it: a
 * key without the platform's opt-in calls nothing.
 */

const NOW = new Date("2026-11-11T13:20:00.000Z");
const SITE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OFF_SITE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER = "11111111-1111-4111-8111-111111111111";

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

function posted(id: string, statusId: string, publishedAt: string, business = SITE) {
  return {
    id,
    user_id: USER,
    business_id: business,
    surface: "x",
    status: "published_manually",
    published_url: `https://x.com/samriv/status/${statusId}`,
    published_at: publishedAt,
  };
}

describe("which replies are read", () => {
  it("one per status id, the ones read today left out, at most 100 a run", () => {
    const rows = [
      posted("a", "1", "2026-11-10T10:00:00Z"),
      posted("b", "1", "2026-11-10T09:00:00Z"),
      posted("c", "2", "2026-11-09T10:00:00Z"),
      { ...posted("d", "0", "2026-11-09T10:00:00Z"), published_url: "https://www.reddit.com/r/seo/comments/abc/x/def/" },
    ];
    const picked = pickRepliesToRead(rows, new Set(["c"]));
    expect(picked.picked.map((r) => r.id)).toEqual(["a"]);
    expect(picked).toMatchObject({ considered: 3, alreadyToday: 1 });

    const many = Array.from({ length: 150 }, (_, i) => posted(`r${i}`, String(1000 + i), "2026-11-10T10:00:00Z"));
    expect(pickRepliesToRead(many, new Set()).picked).toHaveLength(100);
  });
});

describe("the daily read", () => {
  it("asks X once for every reply, stores a snapshot each, nulls where X gave nothing", async () => {
    const db = new LedgerFake({
      placement_targets: [
        posted("a", "11", "2026-11-10T10:00:00Z"),
        posted("b", "12", "2026-11-05T10:00:00Z"),
        // Posted 20 days ago: outside the 14-day window.
        posted("old", "13", "2026-10-22T10:00:00Z"),
      ],
      placement_metrics: [],
    });
    const { client, lookup } = fakeXClient({
      lookup: (ids) => ({
        posts: [xPost("11", { metrics: { impressions: 1234, likes: 8, replies: 2, reposts: 0, quotes: null, bookmarks: 1 } })],
        missingIds: ids.filter((id) => id !== "11"),
        billedPosts: 1,
        costUsd: 0.005,
      }),
    });

    const out = await refreshXReplyMetrics({ admin: db as never, client, businessIds: [SITE], now: NOW });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect((lookup.mock.calls[0] as unknown as [string[]])[0].sort()).toEqual(["11", "12"]);
    expect(out).toMatchObject({ asked: 2, returned: 1, missing: 1, stored: 2, costUsd: 0.005, stopped: null });

    const a = db.tables.placement_metrics.find((r) => r.target_id === "a");
    const b = db.tables.placement_metrics.find((r) => r.target_id === "b");
    expect(a).toMatchObject({ day: "2026-11-11", user_id: USER, business_id: SITE, impressions: 1234, likes: 8, replies: 2, reposts: 0, quotes: null, bookmarks: 1 });
    // Asked, and X handed nothing back: the row is the measurement, every number null.
    expect(b).toMatchObject({ day: "2026-11-11", impressions: null, likes: null, replies: null, reposts: null, quotes: null, bookmarks: null });
    expect(db.spend("2026-11-01")).toMatchObject({ cost_usd: 0.005, calls: 1 });

    // The same day again: nothing asked, nothing spent.
    const again = await refreshXReplyMetrics({ admin: db as never, client, businessIds: [SITE], now: new Date("2026-11-11T20:00:00Z") });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(again).toMatchObject({ considered: 2, alreadyToday: 2, asked: 0 });

    // What the inbox reads back.
    const latest = await loadReplyMetrics(db as never, SITE, ["a", "b"]);
    expect(latest?.get("a")).toMatchObject({ day: "2026-11-11", impressions: 1234 });
  });

  it("stops at the cap without calling, and records nothing", async () => {
    const db = new LedgerFake({
      placement_targets: [posted("a", "11", "2026-11-10T10:00:00Z")],
      placement_metrics: [],
      provider_spend: [{ provider: "x-api", month: "2026-11-01", cost_usd: 20, calls: 1, posts: 1 }],
    });
    const { client, lookup } = fakeXClient();
    const out = await refreshXReplyMetrics({ admin: db as never, client, businessIds: [SITE], now: NOW });
    expect(lookup).not.toHaveBeenCalled();
    expect(out.stopped).toBe("cap");
    expect(db.tables.placement_metrics).toEqual([]);
  });
});

describe("the line on a posted reply", () => {
  const snap = (over: Record<string, unknown>) =>
    mapReplyMetrics({ day: "2026-11-11", fetched_at: "2026-11-11T13:20:00Z", impressions: null, likes: null, replies: null, reposts: null, quotes: null, bookmarks: null, ...over });

  it("names only what X returned, zeros included, and the day", () => {
    expect(metricsLine(snap({ impressions: 1234, likes: 8, replies: 2 }), NOW)).toBe("1.2k views · 8 likes · 2 replies · as of today");
    expect(metricsLine(snap({ impressions: 0, likes: 0, replies: 1, reposts: 3 }), NOW)).toBe("0 views · 0 likes · 1 reply · 3 reposts · as of today");
    expect(metricsLine(snap({ likes: 1, day: "2026-11-10" }), NOW)).toBe("1 like · as of yesterday");
    expect(metricsLine(snap({ likes: 1, day: "2026-11-01" }), NOW)).toBe("1 like · as of Nov 1");
  });

  it("says X gave nothing, never a row of zeros, and nothing at all without a snapshot", () => {
    expect(metricsLine(snap({}), NOW)).toBe("X returned no numbers for this reply · as of today");
    expect(metricsLine(null, NOW)).toBeNull();
    expect(snap({ likes: "7", impressions: -1 })).toMatchObject({ likes: 7, impressions: null });
  });

  it("reads big numbers short", () => {
    expect([compactCount(999), compactCount(1000), compactCount(1250), compactCount(12_900), compactCount(3_450_000)]).toEqual([
      "999",
      "1k",
      "1.2k",
      "12k",
      "3.4M",
    ]);
  });
});

describe("the daily run's gate", () => {
  const seed = () =>
    new LedgerFake({
      businesses: [
        { id: SITE, user_id: USER, voice_settings: { findPostsOnX: true, aboutYou: "I run it." } },
        { id: OFF_SITE, user_id: USER, voice_settings: { findPostsOnX: false } },
      ],
      subscriptions: [{ user_id: USER, status: "active", current_period_end: null }],
      placement_targets: [posted("a", "11", "2026-11-10T10:00:00Z"), posted("z", "99", "2026-11-10T10:00:00Z", OFF_SITE)],
      placement_metrics: [],
      jobs: [],
      agent_runs: [],
    });

  it("with the key present but the platform not opted in, calls nothing and enqueues nothing", async () => {
    process.env.X_API_BEARER_TOKEN = "a-real-looking-token";
    delete process.env.X_API_ENABLED;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const db = seed();
    const out = await runXDaily({ admin: db as never, now: NOW });
    expect(out).toMatchObject({ skipped: "x_api_disabled" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.tables.jobs).toEqual([]);
    expect(db.tables.provider_spend).toEqual([]);
    fetchSpy.mockRestore();
  });

  it("reads numbers and enqueues a search only for the sites that turned Find posts on X on", async () => {
    const db = seed();
    const { client, lookup } = fakeXClient({ lookup: () => ({ posts: [xPost("11")], missingIds: [], billedPosts: 1, costUsd: 0.005 }) });
    const out = await runXDaily({ admin: db as never, now: NOW, client });
    expect(out.sites).toBe(1);
    expect((lookup.mock.calls[0] as unknown as [string[]])[0]).toEqual(["11"]);
    expect(db.tables.jobs).toEqual([expect.objectContaining({ type: "x-post-discovery", business_id: SITE, input: { businessId: SITE } })]);

    // The columns the database fills by default on insert.
    Object.assign(db.tables.jobs[0], { status: "completed", created_at: NOW.toISOString() });
    // Run again the same day (a retried cron): no second search.
    const again = await runXDaily({ admin: db as never, now: new Date("2026-11-11T14:00:00Z"), client });
    expect(again.search).toMatchObject({ enqueued: 0, recent: 1 });
    expect(db.tables.jobs).toHaveLength(1);
  });

  it("enqueues no search once the month's cap is reached", async () => {
    const db = seed();
    db.tables.provider_spend.push({ provider: "x-api", month: "2026-11-01", cost_usd: 19.99, calls: 1, posts: 1 });
    process.env.X_API_ENABLED = "1";
    process.env.X_API_BEARER_TOKEN = "t";
    const { client } = fakeXClient();
    const out = await runXDaily({ admin: db as never, now: NOW, client });
    expect(out.search).toEqual({ skipped: "monthly_cap_reached" });
    expect(db.tables.jobs).toEqual([]);
  });
});
