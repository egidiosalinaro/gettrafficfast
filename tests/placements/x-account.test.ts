import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock("@/lib/notifications/email", () => ({ operatorEmailAddress: () => null, sendNotificationEmail: vi.fn() }));

import { XApiError } from "@/lib/providers/x/api";
import { X_ACCOUNT_MAX_SITES_PER_RUN } from "@/lib/placements/x-budget";
import { pickSitesToRead, refreshXAccountMetrics } from "@/lib/placements/x-account";
import { runXDaily } from "@/lib/placements/x-daily";
import { LedgerFake, fakeXClient, xAccount, xPost } from "./x-fake";

/**
 * The followers of a site's own X account: one user lookup per site and day
 * through the cap, a dated snapshot each, a row of nulls when X knows no
 * such account, nothing asked for a site with no linked reply, nothing asked
 * twice the same day, and nothing paid for when the table is not there yet.
 */

const NOW = new Date("2026-11-13T13:20:00.000Z");
const USER = "11111111-1111-4111-8111-111111111111";
const site = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;
const SITE = site(1);

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

function posted(id: string, business: string, handle: string, statusId = "1855000000000000001") {
  return {
    id,
    user_id: USER,
    business_id: business,
    surface: "x",
    status: "published_manually",
    published_url: `https://x.com/${handle}/status/${statusId}`,
    published_at: "2026-11-12T10:00:00Z",
  };
}

const sites = (...ids: string[]) => ids.map((id) => ({ id, user_id: USER }));

describe("the daily read of the account", () => {
  it("looks the account up once, stores the day's numbers, and asks nothing again the same day", async () => {
    const db = new LedgerFake({ placement_targets: [posted("a", SITE, "Samriv")], x_account_metrics: [] });
    const { client, userByUsername } = fakeXClient({ user: (h) => xAccount("Samriv", { followers: h === "samriv" ? 2310 : 0 }) });

    const out = await refreshXAccountMetrics({ admin: db as never, client, sites: sites(SITE), now: NOW });
    expect(userByUsername).toHaveBeenCalledTimes(1);
    expect(userByUsername.mock.calls[0][0]).toBe("samriv");
    expect(out).toMatchObject({ considered: 1, asked: 1, stored: 1, missing: 0, costUsd: 0.01, stopped: null });
    expect(db.tables.x_account_metrics).toEqual([
      expect.objectContaining({ business_id: SITE, user_id: USER, day: "2026-11-13", handle: "Samriv", followers: 2310, following: 300, posts: 5000, listed: 4 }),
    ]);
    expect(db.spend("2026-11-01")).toMatchObject({ cost_usd: 0.01, calls: 1 });

    const again = await refreshXAccountMetrics({ admin: db as never, client, sites: sites(SITE), now: new Date("2026-11-13T20:00:00Z") });
    expect(userByUsername).toHaveBeenCalledTimes(1);
    expect(again).toMatchObject({ alreadyToday: 1, asked: 0, costUsd: 0 });
    expect(db.spend("2026-11-01")).toMatchObject({ cost_usd: 0.01, calls: 1 });
  });

  it("stores a row of nulls when X knows no such account: asked, and nothing came back", async () => {
    const db = new LedgerFake({ placement_targets: [posted("a", SITE, "renamed")], x_account_metrics: [] });
    const { client } = fakeXClient({ user: () => null });
    const out = await refreshXAccountMetrics({ admin: db as never, client, sites: sites(SITE), now: NOW });
    expect(out).toMatchObject({ asked: 1, missing: 1, stored: 1, costUsd: 0 });
    expect(db.tables.x_account_metrics[0]).toMatchObject({ handle: "renamed", followers: null, following: null, posts: null, listed: null });
  });

  it("asks nothing for a site with no linked reply on X, and one lookup for two sites posting from one account", async () => {
    const db = new LedgerFake({
      placement_targets: [
        posted("a", site(1), "samriv"),
        posted("b", site(2), "Samriv"),
        { ...posted("c", site(3), "x"), published_url: null },
      ],
      x_account_metrics: [],
    });
    const { client, userByUsername } = fakeXClient();
    const out = await refreshXAccountMetrics({ admin: db as never, client, sites: sites(site(1), site(2), site(3)), now: NOW });
    expect(userByUsername).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ noHandle: 1, asked: 1, stored: 2 });
    expect(db.tables.x_account_metrics.map((r) => r.business_id).sort()).toEqual([site(1), site(2)]);
  });

  it("stops at the cap without calling, and stores nothing", async () => {
    const db = new LedgerFake({
      placement_targets: [posted("a", SITE, "samriv")],
      x_account_metrics: [],
      provider_spend: [{ provider: "x-api", month: "2026-11-01", cost_usd: 20, calls: 1, posts: 1 }],
    });
    const { client, userByUsername } = fakeXClient();
    const out = await refreshXAccountMetrics({ admin: db as never, client, sites: sites(SITE), now: NOW });
    expect(userByUsername).not.toHaveBeenCalled();
    expect(out.stopped).toBe("cap");
    expect(db.tables.x_account_metrics).toEqual([]);
  });

  it("stops at the first failed call, keeps what was read, and asks the rest tomorrow", async () => {
    const db = new LedgerFake({
      placement_targets: [posted("a", site(1), "first"), posted("b", site(2), "second"), posted("c", site(3), "third")],
      x_account_metrics: [],
    });
    const { client, userByUsername } = fakeXClient();
    userByUsername.mockImplementationOnce(async (handle: string) => ({ account: xAccount(handle), billedPosts: 1, costUsd: 0.01 }));
    userByUsername.mockImplementationOnce(async () => {
      throw new XApiError("X API did not answer within 15000 ms", "timeout");
    });
    const out = await refreshXAccountMetrics({ admin: db as never, client, sites: sites(site(1), site(2), site(3)), now: NOW });
    expect(userByUsername).toHaveBeenCalledTimes(2);
    expect(out).toMatchObject({ asked: 1, stored: 1, stopped: "error" });
    expect(db.tables.x_account_metrics.map((r) => r.business_id)).toEqual([site(1)]);
    // The failed call was settled to nothing: only the one user read is spent.
    expect(db.spend("2026-11-01")).toMatchObject({ cost_usd: 0.01 });
  });

  it("pays for nothing while the table is not there yet", async () => {
    const db = new LedgerFake({ placement_targets: [posted("a", SITE, "samriv")] });
    const from = db.from.bind(db);
    (db as unknown as { from: (t: string) => unknown }).from = (table: string) =>
      table === "x_account_metrics"
        ? {
            select: () => ({
              in: () => ({
                gte: () => ({
                  limit: () =>
                    Promise.resolve({ data: null, error: { code: "PGRST205", message: "Could not find the table 'public.x_account_metrics' in the schema cache" } }),
                }),
              }),
            }),
          }
        : from(table);
    const { client, userByUsername } = fakeXClient();
    const out = await refreshXAccountMetrics({ admin: db as never, client, sites: sites(SITE), now: NOW });
    expect(userByUsername).not.toHaveBeenCalled();
    expect(out.note).toMatch(/not there yet/);
    expect(db.tables.provider_spend).toEqual([]);
  });

  it("reads at most 10 accounts a run, the ones read longest ago first", async () => {
    const ids = Array.from({ length: 12 }, (_, i) => site(i + 1));
    const db = new LedgerFake({
      placement_targets: ids.map((id, i) => posted(`t${i}`, id, `acct${i}`)),
      // Site 1 was read yesterday, site 2 never... every other one two days ago.
      x_account_metrics: ids.slice(2).map((id) => ({ business_id: id, user_id: USER, day: "2026-11-11", handle: "x" })).concat([
        { business_id: site(1), user_id: USER, day: "2026-11-12", handle: "acct0" },
      ]),
    });
    const { client, userByUsername } = fakeXClient();
    const out = await refreshXAccountMetrics({ admin: db as never, client, sites: sites(...ids), now: NOW });
    expect(userByUsername).toHaveBeenCalledTimes(X_ACCOUNT_MAX_SITES_PER_RUN);
    expect(out.asked).toBe(10);
    // Never read first, then the oldest; the one read yesterday waits for tomorrow.
    expect(userByUsername.mock.calls[0][0]).toBe("acct1");
    expect(userByUsername.mock.calls.map((c) => c[0])).not.toContain("acct0");
  });

  it("orders the sites to read: not today's, never read first, then the oldest", () => {
    const last = new Map([
      ["a", "2026-11-13"],
      ["b", "2026-11-10"],
      ["c", "2026-11-12"],
    ]);
    expect(pickSitesToRead([{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }], last, "2026-11-13").map((s) => s.id)).toEqual(["d", "b", "c"]);
  });
});

describe("inside the daily X run", () => {
  it("reads the followers of the sites that turned Find posts on X on, owners who pay", async () => {
    const db = new LedgerFake({
      businesses: [
        { id: site(1), user_id: USER, voice_settings: { findPostsOnX: true, aboutYou: "I run it." } },
        { id: site(2), user_id: USER, voice_settings: { findPostsOnX: false } },
      ],
      subscriptions: [{ user_id: USER, status: "active", current_period_end: null }],
      placement_targets: [posted("a", site(1), "samriv", "11"), posted("b", site(2), "other", "12")],
      placement_metrics: [],
      x_account_metrics: [],
      jobs: [],
      agent_runs: [],
    });
    const { client, userByUsername } = fakeXClient({ lookup: () => ({ posts: [xPost("11")], missingIds: [], billedPosts: 1, costUsd: 0.005 }) });
    const out = await runXDaily({ admin: db as never, now: NOW, client });
    expect(userByUsername).toHaveBeenCalledTimes(1);
    expect(userByUsername.mock.calls[0][0]).toBe("samriv");
    expect(out.account).toMatchObject({ considered: 1, asked: 1, stored: 1 });
    expect(db.tables.x_account_metrics).toEqual([expect.objectContaining({ business_id: site(1), followers: 1200 })]);
  });

  it("with the key present but the platform not opted in, reads no account", async () => {
    process.env.X_API_BEARER_TOKEN = "a-real-looking-token";
    delete process.env.X_API_ENABLED;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const db = new LedgerFake({ businesses: [{ id: SITE, user_id: USER, voice_settings: { findPostsOnX: true } }], x_account_metrics: [] });
    const out = await runXDaily({ admin: db as never, now: NOW });
    expect(out.account).toEqual({ skipped: "x_api_disabled" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.tables.x_account_metrics).toEqual([]);
    fetchSpy.mockRestore();
  });
});
