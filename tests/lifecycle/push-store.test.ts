import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { groupQueriesByArticle, queryWindow } from "@/lib/analytics/search-console";
import { parseSearchQueryResponse } from "@/lib/providers/analytics/search-console";
import { measureDuePushes, requestArticlePush, resolveArticlePush, sweepSitePushes } from "@/lib/lifecycle/push-store";
import { FakeSupabase } from "../support/fake-supabase";

/**
 * Push page 3, the stored half (docs/LIFECYCLE.md): the query report per
 * page, recording a push (or its skip, with the reason), the weekly cap,
 * the on-demand refusals, the answer to a proposal, and after-values that
 * exist only once Search Console covers their window.
 */

const USER = "user-1";
const SITE = "biz-1";
const NOW = new Date("2026-11-15T09:40:00Z");
const db = () => fake as unknown as SupabaseClient;
let fake: FakeSupabase;

/** 28 days of rows ending on 2026-11-12. */
function days(articleId: string, impressions: number, position: number) {
  return Array.from({ length: 28 }, (_, i) => ({
    article_id: articleId,
    business_id: SITE,
    source: "search_console",
    captured_on: new Date(Date.UTC(2026, 10, 12) - i * 86_400_000).toISOString().slice(0, 10),
    impressions,
    clicks: 0,
    position,
  }));
}

const article = (id: string) => ({ id, user_id: USER, business_id: SITE, status: "published", published_url: `https://acme.test/blog/${id}`, last_refreshed_at: null });
const query = (articleId: string, q: string, impressions: number) => ({ article_id: articleId, query: q, impressions, clicks: 0, position: 30, period_end: "2026-11-12" });

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  fake = new FakeSupabase({
    analytics_connections: [{ business_id: SITE, provider: "search_console", last_synced_on: "2026-11-12", site_url: "sc-domain:acme.test", status: "connected" }],
    articles: ["a", "b", "c", "d", "top"].map(article),
    content_metrics: [...days("a", 9, 25), ...days("b", 5, 30), ...days("c", 3, 12), ...days("d", 2, 33), ...days("top", 20, 3)],
    content_queries: [query("a", "x growth tools", 120), query("a", "grow on x", 30), query("c", "rare", 4), query("b", "x scheduler", 60)],
    article_pushes: [],
    article_versions: [],
    article_events: [],
    jobs: [],
  });
});

describe("the query report", () => {
  it("parses Google's page and query rows, dropping the incomplete", () => {
    expect(
      parseSearchQueryResponse({
        rows: [
          { keys: ["https://acme.test/a", "x growth tools"], impressions: 12.4, clicks: 1, position: 22.5 },
          { keys: ["https://acme.test/a"], impressions: 3 },
        ],
      })
    ).toEqual([{ page: "https://acme.test/a", query: "x growth tools", impressions: 12, clicks: 1, position: 22.5 }]);
  });

  it("folds URL variants onto the article, weighting the position by impressions; unattributed rows are dropped", () => {
    const grouped = groupQueriesByArticle(
      [
        { page: "https://www.acme.test/a/", query: "X Growth Tools", impressions: 10, clicks: 1, position: 20 },
        { page: "https://acme.test/a", query: "x growth tools", impressions: 30, clicks: 0, position: 40 },
        { page: "https://other.test/a", query: "x growth tools", impressions: 99, clicks: 9, position: 1 },
      ],
      [{ id: "a", publishedUrl: "https://acme.test/a" }]
    );
    expect(grouped).toEqual([{ articleId: "a", query: "x growth tools", impressions: 40, clicks: 1, position: 35 }]);
    expect(queryWindow("2026-11-12")).toEqual({ startDate: "2026-10-16", endDate: "2026-11-12" });
  });
});

describe("the weekly sweep for a site", () => {
  it("records at most 3, the main query from the report, a skip with its reason, and queues a job per push", async () => {
    const result = await sweepSitePushes({ admin: db(), businessId: SITE, userId: USER, now: NOW });
    expect(result).toEqual({ status: "swept", selected: 2, skipped: 1, excluded: 2 });
    const rows = fake.tables.article_pushes;
    expect(rows.map((r) => [r.article_id, r.status, r.main_query ?? null])).toEqual([
      ["a", "selected", "x growth tools"],
      ["b", "selected", "x scheduler"],
      ["c", "skipped", null],
    ]);
    expect(rows[2].skip_reason).toMatch(/^No clear query: no query reached 10 impressions/);
    expect(rows[0]).toMatchObject({ origin: "sweep", before_position: 25, before_impressions: 252, before_start: "2026-10-16", before_end: "2026-11-12" });
    expect(fake.tables.jobs.map((j) => [j.type, j.article_id])).toEqual([
      ["push-article", "a"],
      ["push-article", "b"],
    ]);
    // Run again: the three are cooling down, so only the fourth is looked
    // at (no query of its own: a skip); a third run finds nothing.
    expect(await sweepSitePushes({ admin: db(), businessId: SITE, userId: USER, now: NOW })).toMatchObject({ selected: 0, skipped: 1 });
    expect(await sweepSitePushes({ admin: db(), businessId: SITE, userId: USER, now: NOW })).toMatchObject({ selected: 0, skipped: 0 });
    expect(fake.tables.article_pushes).toHaveLength(4);
    expect(fake.tables.jobs).toHaveLength(2);
  });

  it("does nothing without Search Console", async () => {
    fake.tables.analytics_connections = [];
    expect(await sweepSitePushes({ admin: db(), businessId: SITE, userId: USER, now: NOW })).toEqual({ status: "no_search_console" });
  });
});

describe("push_article on demand", () => {
  it("pushes an article outside the band, and refuses one pushed in the last 28 days", async () => {
    const first = await requestArticlePush({ admin: db(), userId: USER, businessId: SITE, articleId: "top", now: NOW });
    expect(first).toMatchObject({ ok: true, push: { origin: "on_demand", status: "skipped" } });
    const second = await requestArticlePush({ admin: db(), userId: USER, businessId: SITE, articleId: "top", now: NOW });
    expect(second).toMatchObject({ ok: false, status: 409, error: expect.stringContaining("pushed less than 28 days ago") });
  });

  it("does not find another account's article", async () => {
    expect(await requestArticlePush({ admin: db(), userId: "someone-else", businessId: SITE, articleId: "a", now: NOW })).toMatchObject({ ok: false, status: 404 });
  });
});

describe("answering a proposal", () => {
  it("only a proposal of this site and user, and 'applied' starts the measurement that day", async () => {
    fake.tables.article_pushes.push(
      { id: "p1", user_id: USER, business_id: SITE, article_id: "a", status: "proposed", origin: "sweep", links: [], created_at: "2026-11-10T00:00:00Z" },
      { id: "p2", user_id: USER, business_id: SITE, article_id: "b", status: "applied", origin: "sweep", links: [], created_at: "2026-11-10T00:00:00Z" }
    );
    expect(await resolveArticlePush({ admin: db(), userId: "other", businessId: SITE, pushId: "p1", action: "applied" })).toMatchObject({ ok: false, status: 404 });
    expect(await resolveArticlePush({ admin: db(), userId: USER, businessId: SITE, pushId: "p2", action: "dismissed" })).toMatchObject({ ok: false, status: 409 });
    const done = await resolveArticlePush({ admin: db(), userId: USER, businessId: SITE, pushId: "p1", action: "applied", now: NOW });
    expect(done).toMatchObject({ ok: true, push: { status: "applied", appliedBy: "customer", appliedAt: NOW.toISOString() } });
  });
});

describe("after-values", () => {
  it("are measured only once Search Console covers the window; nothing invented before", async () => {
    fake.tables.article_pushes.push({
      id: "p1",
      user_id: USER,
      business_id: SITE,
      article_id: "a",
      status: "applied",
      applied_at: "2026-10-20T10:00:00Z",
      before_position: 37,
      after_14: null,
      after_28: null,
    });
    await measureDuePushes(db(), SITE, NOW);
    const row = fake.tables.article_pushes[0];
    // 21 Oct to 3 Nov is covered by the watermark (12 Nov); 21 Oct to 17 Nov is not.
    expect(row.after_14).toMatchObject({ start: "2026-10-21", end: "2026-11-03", days: 14, position: 25, impressions: 126 });
    expect(row.after_28).toBeNull();
  });
});

describe("what counts as a change", () => {
  it("a declined refresh (published → published) is not an edit; going live and an archived version are", async () => {
    fake.tables.article_events.push(
      { article_id: "a", from_state: "published", to_state: "published", created_at: "2026-11-09T09:00:00Z" },
      { article_id: "b", from_state: "generated", to_state: "published", created_at: "2026-11-09T09:00:00Z" }
    );
    fake.tables.article_versions.push({ article_id: "c", business_id: SITE, created_at: "2026-11-10T00:00:00Z" });
    await sweepSitePushes({ admin: db(), businessId: SITE, userId: USER, now: NOW });
    expect(fake.tables.article_pushes.map((r) => r.article_id)).toEqual(["a", "d"]);
  });
});
