import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { FakeSupabase } from "../support/fake-supabase";
import { CRAWLED_NOT_INDEXED, INDEXED, NOT_FOUND, REDIRECT } from "../fixtures/url-inspection";

/**
 * Indexing status (docs/ANALYTICS.md, "Indexing status"). What is pinned:
 * the rotation (fresh first, then never checked, then the oldest check) and
 * the daily cap; the re-check interval and a republish cutting it short; a
 * spent quota or a refused grant stopping a site's run while one bad URL
 * does not; a URL never checked counted as "not checked", never as "not
 * indexed"; and the owner's note sent once per URL per Google state.
 */

const m = vi.hoisted(() => ({ sent: [] as Array<{ to: string; subject: string; html: string }>, sendOk: true }));
vi.mock("@/lib/integrations/crypto", () => ({
  decryptSecret: (value: string) => `plain:${value}`,
  encryptSecret: (value: string) => `enc:${value}`,
}));
vi.mock("@/lib/notifications/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notifications/email")>()),
  sendNotificationEmail: async (input: { to: string; subject: string; html: string }) => {
    if (!m.sendOk) return false;
    m.sent.push(input);
    return true;
  },
}));
vi.mock("@/lib/providers/analytics/search-console", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/providers/analytics/search-console")>()),
  refreshAccessToken: async () => "ACCESS",
}));

import {
  alertFor,
  alertKey,
  checksToday,
  DAILY_INSPECTION_CAP,
  inspectBusinessIndex,
  inspectUrlNow,
  isDue,
  listIndexStatus,
  planInspections,
  urlInProperty,
  type InspectionCandidate,
  type Inspector,
  type StoredCheck,
} from "@/lib/analytics/index-status";
import { summarizeIndexing } from "@/lib/analytics/index-status-display";
import { parseUrlInspectionResponse } from "@/lib/providers/analytics/search-console";
import { InspectionError } from "@/lib/providers/analytics/types";

const NOW = new Date("2026-11-12T02:10:00.000Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
const USER = "11111111-1111-4111-8111-111111111111";
const SITE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const candidate = (url: string, over: Partial<InspectionCandidate> = {}): InspectionCandidate => ({
  url,
  articleId: `art-${url}`,
  publishedAt: daysAgo(30),
  changedAt: null,
  ...over,
});
const check = (url: string, checkedAt: string, verdict = "PASS", coverageState: string | null = "Submitted and indexed"): StoredCheck => ({
  url,
  checkedAt,
  verdict,
  coverageState,
});

describe("planInspections", () => {
  it("puts the freshly published first, then never checked or republished, then the oldest checks, within the cap", () => {
    const stored = new Map<string, StoredCheck>([
      ["https://acme.test/five", check("https://acme.test/five", daysAgo(5))],
      ["https://acme.test/four", check("https://acme.test/four", daysAgo(4))],
      ["https://acme.test/yesterday", check("https://acme.test/yesterday", daysAgo(1))],
      ["https://acme.test/republished", check("https://acme.test/republished", daysAgo(1))],
    ]);
    const candidates = [
      candidate("https://acme.test/five"),
      candidate("https://acme.test/four"),
      candidate("https://acme.test/yesterday"),
      candidate("https://acme.test/republished", { changedAt: daysAgo(0.5) }),
      candidate("https://acme.test/never"),
      candidate("https://acme.test/fresh", { publishedAt: daysAgo(1) }),
      candidate("https://acme.test/fresh", { publishedAt: daysAgo(1) }),
    ];
    const order = planInspections({ candidates, stored, now: NOW, cap: 10 }).map((c) => c.url);
    expect(order).toEqual([
      "https://acme.test/fresh",
      "https://acme.test/never",
      "https://acme.test/republished",
      "https://acme.test/five",
      "https://acme.test/four",
    ]);
    expect(planInspections({ candidates, stored, now: NOW, cap: 2 }).map((c) => c.url)).toEqual([
      "https://acme.test/fresh",
      "https://acme.test/never",
    ]);
    expect(planInspections({ candidates, stored, now: NOW, cap: 0 })).toEqual([]);
  });
});

describe("the re-check interval", () => {
  it("waits three days unless the article was republished since", () => {
    const c = candidate("https://acme.test/a");
    expect(isDue(c, undefined, NOW)).toBe(true);
    expect(isDue(c, check(c.url, daysAgo(2.9)), NOW)).toBe(false);
    expect(isDue(c, check(c.url, daysAgo(3)), NOW)).toBe(true);
    expect(isDue({ ...c, changedAt: daysAgo(1) }, check(c.url, daysAgo(2)), NOW)).toBe(true);
    expect(isDue({ ...c, changedAt: daysAgo(2.5) }, check(c.url, daysAgo(2)), NOW)).toBe(false);
  });

  it("counts today's inspections by UTC day", () => {
    expect(
      checksToday([check("a", "2026-11-12T00:00:01Z"), check("b", "2026-11-11T23:59:59Z"), check("c", NOW.toISOString())], NOW)
    ).toBe(2);
  });
});

describe("urlInProperty", () => {
  it("lets a domain property cover its subdomains over http and https, and nothing else", () => {
    expect(urlInProperty("sc-domain:acme.test", "https://acme.test/blog/a")).toBe(true);
    expect(urlInProperty("sc-domain:acme.test", "http://www.acme.test/a")).toBe(true);
    expect(urlInProperty("sc-domain:acme.test", "https://notacme.test/a")).toBe(false);
    expect(urlInProperty("sc-domain:acme.test", "ftp://acme.test/a")).toBe(false);
    expect(urlInProperty("sc-domain:acme.test", "not a url")).toBe(false);
  });

  it("holds a URL-prefix property to its scheme, host and path", () => {
    expect(urlInProperty("https://www.acme.test/", "https://www.acme.test/blog/a")).toBe(true);
    expect(urlInProperty("https://www.acme.test/", "https://WWW.ACME.TEST/blog/a")).toBe(true);
    expect(urlInProperty("https://www.acme.test/", "http://www.acme.test/blog/a")).toBe(false);
    expect(urlInProperty("https://www.acme.test/", "https://acme.test/blog/a")).toBe(false);
    expect(urlInProperty("https://www.acme.test/blog/", "https://www.acme.test/about")).toBe(false);
  });
});

describe("alertFor", () => {
  const inspection = (payload: unknown) => parseUrlInspectionResponse(payload);
  const c = candidate("https://acme.test/blog/thin-page", { publishedAt: daysAgo(8) });

  it("notes a published article still not indexed seven days after publishing", () => {
    expect(alertFor({ businessId: SITE, candidate: c, previous: undefined, inspection: inspection(CRAWLED_NOT_INDEXED), now: NOW })).toMatchObject({
      kind: "not_indexed_after_publish",
      coverageState: "Crawled - currently not indexed",
    });
    expect(
      alertFor({ businessId: SITE, candidate: { ...c, publishedAt: daysAgo(6) }, previous: undefined, inspection: inspection(CRAWLED_NOT_INDEXED), now: NOW })
    ).toBeNull();
  });

  it("notes a page that was indexed and dropped out, whatever its age", () => {
    const young = { ...c, publishedAt: daysAgo(2) };
    expect(
      alertFor({ businessId: SITE, candidate: young, previous: check(c.url, daysAgo(3)), inspection: inspection(NOT_FOUND), now: NOW })
    ).toMatchObject({ kind: "dropped_from_index", coverageState: "Not found (404)" });
  });

  it("raises nothing for an indexed page or a verdict Google did not give", () => {
    expect(alertFor({ businessId: SITE, candidate: c, previous: undefined, inspection: inspection(INDEXED), now: NOW })).toBeNull();
    expect(alertFor({ businessId: SITE, candidate: c, previous: undefined, inspection: inspection({}), now: NOW })).toBeNull();
  });

  it("keys the note by site, URL and Google state, not by kind", () => {
    const a = alertKey(SITE, c.url, "Crawled - currently not indexed", "NEUTRAL");
    expect(alertKey(SITE, c.url, "Crawled - currently not indexed", "NEUTRAL")).toBe(a);
    expect(alertKey(SITE, c.url, "Page with redirect", "NEUTRAL")).not.toBe(a);
    expect(alertKey(SITE, "https://acme.test/other", "Crawled - currently not indexed", "NEUTRAL")).not.toBe(a);
    expect(a).toMatch(/^index_status:[0-9a-f]{32}$/);
  });
});

describe("null is not 'not indexed'", () => {
  it("counts only checked URLs and says how many of how many", () => {
    const none = summarizeIndexing([], 3);
    expect(none).toMatchObject({ total: 3, checked: 0, indexed: 0, notIndexed: 0, unknown: 0, caption: "0 of 3 checked" });
    expect(none.notIndexedRows).toEqual([]);
    expect(summarizeIndexing([], 0).caption).toBeNull();
  });
});

// ── The sweep, on a fake database ──────────────────────────────────────────

const A1 = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const A2 = "a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2";
const A3 = "a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3";
const URLS = {
  [A1]: "https://acme.test/blog/ai-seo",
  [A2]: "https://acme.test/blog/thin-page",
  [A3]: "https://acme.test/blog/gone",
};
const ANSWERS: Record<string, unknown> = {
  [URLS[A1]]: INDEXED,
  [URLS[A2]]: CRAWLED_NOT_INDEXED,
  [URLS[A3]]: NOT_FOUND,
};

function seed(extra: Record<string, Array<Record<string, unknown>>> = {}) {
  const db = new FakeSupabase({
    analytics_connections: [
      {
        id: "conn-1",
        user_id: USER,
        business_id: SITE,
        provider: "search_console",
        site_url: "sc-domain:acme.test",
        refresh_token_encrypted: "rt",
        status: "connected",
        last_synced_on: "2026-11-09",
        updated_at: "2026-11-11T07:00:00Z",
      },
    ],
    articles: [
      { id: A1, user_id: USER, business_id: SITE, status: "published", published_url: URLS[A1], scheduled_date: "2026-10-01" },
      { id: A2, user_id: USER, business_id: SITE, status: "published", published_url: URLS[A2], scheduled_date: "2026-10-20" },
      { id: A3, user_id: USER, business_id: SITE, status: "published", published_url: URLS[A3], scheduled_date: "2026-10-25" },
      { id: "draft", user_id: USER, business_id: SITE, status: "generated", published_url: null, scheduled_date: "2026-11-20" },
      { id: "off", user_id: USER, business_id: SITE, status: "published", published_url: "https://elsewhere.test/x", scheduled_date: "2026-10-01" },
    ],
    publish_attempts: [
      { article_id: A2, ok: true, created_at: "2026-10-20T08:00:00Z" },
      { article_id: A2, ok: false, created_at: "2026-10-19T08:00:00Z" },
    ],
    notification_log: [],
    ...extra,
  });
  (db as unknown as { auth: unknown }).auth = {
    admin: { getUserById: async () => ({ data: { user: { email: "owner@acme.test" } }, error: null }) },
  };
  return db;
}

const answering = (calls: string[], answers: Record<string, unknown> = ANSWERS): Inspector =>
  async (siteUrl, url) => {
    expect(siteUrl).toBe("sc-domain:acme.test");
    calls.push(url);
    return parseUrlInspectionResponse(answers[url]);
  };

beforeEach(() => {
  m.sent = [];
  m.sendOk = true;
});

describe("inspectBusinessIndex", () => {
  it("inspects the published URLs inside the property, stores the latest answer per URL, and notes the owner once", async () => {
    const db = seed();
    const calls: string[] = [];
    const admin = db as unknown as SupabaseClient;
    const result = await inspectBusinessIndex({ admin, businessId: SITE, now: NOW, inspector: answering(calls) });

    expect(result).toMatchObject({ status: "inspected", planned: 3, inspected: 3, failed: 0, outsideProperty: 1, stopped: null, notified: 2 });
    expect(calls.sort()).toEqual(Object.values(URLS).sort());
    expect(db.tables.index_status).toHaveLength(3);
    expect(db.tables.index_status.find((r) => r.url === URLS[A2])).toMatchObject({
      business_id: SITE,
      user_id: USER,
      article_id: A2,
      verdict: "NEUTRAL",
      coverage_state: "Crawled - currently not indexed",
      indexing_state: "INDEXING_ALLOWED",
      robots_state: "ALLOWED",
      fetch_state: "SUCCESSFUL",
      last_crawl_at: "2026-11-08T03:40:00Z",
      checked_at: NOW.toISOString(),
    });
    expect(m.sent).toHaveLength(1);
    expect(m.sent[0].to).toBe("owner@acme.test");
    expect(m.sent[0].html).toContain("Crawled - currently not indexed");
    expect(m.sent[0].html).toContain("Not found (404)");
    expect(db.tables.notification_log).toHaveLength(2);

    // The same day: nothing is due, nothing is asked.
    const again = await inspectBusinessIndex({ admin, businessId: SITE, now: NOW, inspector: answering(calls) });
    expect(again).toEqual({ status: "skipped", reason: "nothing_due" });

    // Three days on, the same states: re-inspected, never noted twice.
    const later = new Date(NOW.getTime() + 3 * 86_400_000);
    const third = await inspectBusinessIndex({ admin, businessId: SITE, now: later, inspector: answering(calls) });
    expect(third).toMatchObject({ status: "inspected", inspected: 3, notified: 0 });
    expect(m.sent).toHaveLength(1);
    expect(db.tables.index_status).toHaveLength(3);
  });

  it("notes a page that drops out of the index, once per new state", async () => {
    const db = seed();
    const admin = db as unknown as SupabaseClient;
    await inspectBusinessIndex({ admin, businessId: SITE, now: NOW, inspector: answering([]) });
    m.sent = [];
    const later = new Date(NOW.getTime() + 3 * 86_400_000);
    const redirected = { ...ANSWERS, [URLS[A1]]: REDIRECT };
    const result = await inspectBusinessIndex({ admin, businessId: SITE, now: later, inspector: answering([], redirected) });
    expect(result).toMatchObject({ notified: 1 });
    expect(result.status === "inspected" && result.alerts.find((a) => a.url === URLS[A1])).toMatchObject({
      kind: "dropped_from_index",
      coverageState: "Page with redirect",
    });
    expect(m.sent[0].html).toContain("Page with redirect");
  });

  it("records nothing in the log when the email could not be sent, so the next sweep tries again", async () => {
    m.sendOk = false;
    const db = seed();
    const result = await inspectBusinessIndex({ admin: db as unknown as SupabaseClient, businessId: SITE, now: NOW, inspector: answering([]) });
    expect(result).toMatchObject({ notified: 0 });
    expect(db.tables.notification_log).toEqual([]);
  });

  it.each([
    ["quota", 429],
    ["forbidden", 403],
  ] as const)("stops the site's run at the first %s refusal", async (kind, status) => {
    const db = seed();
    let n = 0;
    const inspector: Inspector = async () => {
      n += 1;
      throw new InspectionError("no", "search_console", kind, status);
    };
    const result = await inspectBusinessIndex({ admin: db as unknown as SupabaseClient, businessId: SITE, now: NOW, inspector });
    expect(result).toMatchObject({ status: "inspected", inspected: 0, stopped: kind });
    expect(n).toBeLessThanOrEqual(4);
    expect(db.tables.index_status ?? []).toEqual([]);
  });

  it("counts one URL Google will not inspect and goes on", async () => {
    const db = seed();
    const inspector: Inspector = async (siteUrl, url) => {
      if (url === URLS[A3]) throw new InspectionError("bad", "search_console", "invalid", 400);
      return parseUrlInspectionResponse(ANSWERS[url]);
    };
    const result = await inspectBusinessIndex({ admin: db as unknown as SupabaseClient, businessId: SITE, now: NOW, inspector, notify: false });
    expect(result).toMatchObject({ inspected: 2, failed: 1, stopped: null });
  });

  it("asks nothing once the site's daily cap is spent", async () => {
    const today = Array.from({ length: DAILY_INSPECTION_CAP }, (_, i) => ({
      business_id: SITE,
      user_id: USER,
      url: `https://acme.test/old-${i}`,
      checked_at: "2026-11-12T01:00:00Z",
      verdict: "PASS",
    }));
    const db = seed({ index_status: today });
    const calls: string[] = [];
    const result = await inspectBusinessIndex({ admin: db as unknown as SupabaseClient, businessId: SITE, now: NOW, inspector: answering(calls) });
    expect(result).toEqual({ status: "skipped", reason: "daily_cap_reached" });
    expect(calls).toEqual([]);
  });

  it("skips a site with no property selected", async () => {
    const db = seed();
    db.tables.analytics_connections[0].site_url = null;
    expect(await inspectBusinessIndex({ admin: db as unknown as SupabaseClient, businessId: SITE, now: NOW, inspector: answering([]) })).toEqual({
      status: "skipped",
      reason: "no_property",
    });
  });
});

describe("listIndexStatus", () => {
  it("reads unchecked URLs as not checked, and checked ones per Google state", async () => {
    const db = seed();
    const client = db as unknown as SupabaseClient;
    const before = await listIndexStatus(client, SITE);
    expect(before).toMatchObject({ connected: true, siteUrl: "sc-domain:acme.test", rows: [] });
    expect(before.summary).toMatchObject({ total: 3, checked: 0, notIndexed: 0, caption: "0 of 3 checked" });

    await inspectBusinessIndex({ admin: client, businessId: SITE, now: NOW, inspector: answering([]), notify: false });
    const after = await listIndexStatus(client, SITE);
    expect(after.summary).toMatchObject({ total: 3, checked: 3, indexed: 1, notIndexed: 2, caption: "3 of 3 checked" });
    expect(after.summary.byCoverageState.map((e) => e.coverageState).sort()).toEqual([
      "Crawled - currently not indexed",
      "Not found (404)",
      "Submitted and indexed",
    ]);
    expect(after.summary.notIndexedRows.map((r) => r.url)).toEqual([URLS[A3], URLS[A2]]);
    expect((await listIndexStatus(client, SITE, { state: "indexed" })).rows.map((r) => r.url)).toEqual([URLS[A1]]);
    const one = await listIndexStatus(client, SITE, { articleId: A2 });
    expect(one.rows).toHaveLength(1);
    expect(one.rows[0]).toMatchObject({ state: "not_indexed", inspectionResultLink: expect.stringContaining("search-console/inspect") });
  });
});

describe("inspectUrlNow", () => {
  it("inspects an article's URL, stores it, and answers the stored row within ten minutes", async () => {
    const db = seed();
    const admin = db as unknown as SupabaseClient;
    const calls: string[] = [];
    const first = await inspectUrlNow({ admin, userId: USER, businessId: SITE, articleId: A1, now: NOW, inspector: answering(calls) });
    expect(first).toMatchObject({ ok: true, fresh: true, row: { url: URLS[A1], articleId: A1, state: "indexed" } });
    const soon = new Date(NOW.getTime() + 5 * 60_000);
    const second = await inspectUrlNow({ admin, userId: USER, businessId: SITE, url: URLS[A1], now: soon, inspector: answering(calls) });
    expect(second).toMatchObject({ ok: true, fresh: false });
    expect(calls).toEqual([URLS[A1]]);
  });

  it("refuses a URL outside the property, an article not published, and another owner's site", async () => {
    const db = seed();
    const admin = db as unknown as SupabaseClient;
    const inspector = answering([]);
    expect(await inspectUrlNow({ admin, userId: USER, businessId: SITE, url: "https://elsewhere.test/x", now: NOW, inspector })).toMatchObject({
      ok: false,
      status: 400,
      code: "invalid_input",
    });
    expect(await inspectUrlNow({ admin, userId: USER, businessId: SITE, articleId: "draft", now: NOW, inspector })).toMatchObject({
      ok: false,
      status: 404,
    });
    expect(await inspectUrlNow({ admin, userId: "someone-else", businessId: SITE, url: URLS[A1], now: NOW, inspector })).toMatchObject({
      ok: false,
      code: "prerequisite_missing",
    });
  });

  it("turns Google's quota and permission refusals into what a person can act on, storing nothing", async () => {
    const db = seed();
    const admin = db as unknown as SupabaseClient;
    const refusing = (kind: "quota" | "forbidden", status: number): Inspector => async () => {
      throw new InspectionError("no", "search_console", kind, status);
    };
    expect(await inspectUrlNow({ admin, userId: USER, businessId: SITE, url: URLS[A1], now: NOW, inspector: refusing("quota", 429) })).toMatchObject({
      ok: false,
      status: 429,
      code: "cap_reached",
    });
    const forbidden = await inspectUrlNow({ admin, userId: USER, businessId: SITE, url: URLS[A1], now: NOW, inspector: refusing("forbidden", 403) });
    expect(forbidden).toMatchObject({ ok: false, status: 409, code: "prerequisite_missing" });
    expect(forbidden.ok === false && forbidden.error).toMatch(/owner or full user/);
    expect(db.tables.index_status ?? []).toEqual([]);
  });
});
