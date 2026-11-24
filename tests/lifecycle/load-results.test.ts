import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "../support/fake-supabase";

/**
 * Results aggregation has one home (lib/lifecycle/load-results.ts): the
 * Results route and the Overview both call it, and the `get_results` tool
 * reads the same function. These pin both routes' answers, captured before
 * the aggregation moved out of them, so the move changed no number:
 *
 * - /api/results: rank per article from Search Console when there is one,
 *   else the SERP series; traffic per article and per day; citations per
 *   article and per engine; the Search Console connection's state;
 * - /api/home: the Measure stage's per-engine rates and rank counts, from
 *   the published articles only.
 */

const m = vi.hoisted(() => ({
  db: null as unknown as FakeSupabase,
  businessId: "biz-1" as string | null,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => m.db.from(table),
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
  }),
}));
vi.mock("@/lib/tenancy", () => ({ selectedBusinessId: async () => m.businessId }));

import { GET as results } from "@/app/api/results/route";
import { GET as home } from "@/app/api/home/route";

const owned = { user_id: "user-1", business_id: "biz-1" };

function seed() {
  return new FakeSupabase({
    businesses: [
      {
        id: "biz-1",
        user_id: "user-1",
        name: "Acme",
        website_url: "https://acme.test",
        niche: "SEO tools",
        voice_settings: { aboutYou: "I run Acme." },
        automation_settings: { enabled: true },
        media_settings: {},
      },
    ],
    articles: [
      {
        id: "art-1",
        ...owned,
        status: "published",
        scheduled_date: "2026-10-20",
        published_url: "https://acme.test/blog/one",
        created_at: "2026-10-20T08:00:00.000Z",
        keyword_id: "kw-1",
        keywords: { keyword: "ai seo" },
      },
      {
        id: "art-2",
        ...owned,
        status: "published",
        scheduled_date: "2026-10-25",
        published_url: "https://acme.test/blog/two",
        created_at: "2026-10-25T08:00:00.000Z",
        keyword_id: "kw-2",
        keywords: [{ keyword: "aeo" }],
      },
      {
        id: "art-3",
        ...owned,
        status: "published",
        scheduled_date: "2026-10-30",
        published_url: null,
        created_at: "2026-10-30T08:00:00.000Z",
        keyword_id: null,
        keywords: null,
      },
      {
        id: "art-4",
        ...owned,
        status: "queued",
        scheduled_date: "2026-11-12",
        created_at: "2026-11-01T08:00:00.000Z",
        keyword_id: "kw-3",
        keywords: { keyword: "geo" },
      },
      // Another site of the same account: never on this site's results.
      {
        id: "art-9",
        user_id: "user-1",
        business_id: "biz-2",
        status: "published",
        scheduled_date: "2026-10-21",
        created_at: "2026-10-21T08:00:00.000Z",
        keywords: { keyword: "other" },
      },
    ],
    keywords: [
      { id: "kw-1", ...owned, keyword: "ai seo", search_volume: 900, opportunity: "High", is_starred: false, article_id: "art-1", created_at: "2026-10-01T00:00:00.000Z" },
      { id: "kw-4", ...owned, keyword: "llm seo", search_volume: null, opportunity: "Medium", is_starred: true, article_id: null, created_at: "2026-10-02T00:00:00.000Z" },
      { id: "kw-5", ...owned, keyword: "rank tracking", search_volume: 300, opportunity: "Low", is_starred: false, article_id: null, created_at: "2026-10-03T00:00:00.000Z" },
    ],
    integrations: [{ id: "int-1", ...owned, type: "webhook", status: "connected" }],
    analytics_connections: [
      {
        id: "ac-1",
        ...owned,
        provider: "search_console",
        site_url: "sc-domain:acme.test",
        status: "connected",
        last_error: null,
        last_synced_on: "2026-11-06",
        updated_at: "2026-11-09T07:00:00.000Z",
        refresh_token_encrypted: "never-read",
      },
    ],
    content_metrics: [
      // art-1: both sources; Search Console wins, never interleaved.
      { article_id: "art-1", captured_on: "2026-10-22", source: "serp", position: 14, impressions: null, clicks: null },
      { article_id: "art-1", captured_on: "2026-10-28", source: "search_console", position: 9.5, impressions: 120, clicks: 4 },
      { article_id: "art-1", captured_on: "2026-11-05", source: "search_console", position: 7.25, impressions: 200, clicks: 9 },
      // art-2: SERP only, measured as absent then ranking.
      { article_id: "art-2", captured_on: "2026-10-27", source: "serp", position: null, impressions: null, clicks: null },
      { article_id: "art-2", captured_on: "2026-11-04", source: "serp", position: 22, impressions: null, clicks: null },
      { article_id: "art-9", captured_on: "2026-11-04", source: "serp", position: 3, impressions: null, clicks: null },
    ],
    ai_citations: [
      { article_id: "art-1", checked_on: "2026-11-05", engine: "gemini", cited: true },
      { article_id: "art-1", checked_on: "2026-11-05", engine: "perplexity", cited: false },
      { article_id: "art-2", checked_on: "2026-11-06", engine: "gemini", cited: false },
      { article_id: "art-2", checked_on: "2026-11-07", engine: "gemini", cited: true },
    ],
    placement_targets: [
      { id: "t-1", ...owned, status: "drafted", found_via: "manual", published_at: null },
      { id: "t-2", ...owned, status: "published_manually", found_via: "search", published_at: "2026-11-08T10:00:00.000Z" },
    ],
    jobs: [],
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-09T12:00:00.000Z"));
  m.db = seed();
  m.businessId = "biz-1";
});

afterEach(() => {
  vi.useRealTimers();
});

async function body(response: Response) {
  expect(response.status).toBe(200);
  return response.json();
}

describe("GET /api/results", () => {
  it("answers exactly what it answered before the aggregation moved to lib", async () => {
    expect(await body(await results())).toMatchInlineSnapshot(`
      {
        "articles": [
          {
            "articleId": "art-3",
            "citations": {
              "byEngine": [],
              "cited": 0,
              "lastCheckedOn": null,
              "probes": 0,
              "rate": null,
            },
            "keyword": "",
            "publishedUrl": null,
            "rank": {
              "current": null,
              "delta": null,
              "measuredOn": null,
              "previous": null,
              "samples": 0,
            },
            "rankSource": null,
            "traffic": {
              "clicks": null,
              "impressions": null,
              "windowDays": 28,
            },
          },
          {
            "articleId": "art-2",
            "citations": {
              "byEngine": [
                {
                  "engine": "gemini",
                  "probes": 2,
                  "rate": 0.5,
                },
              ],
              "cited": 1,
              "lastCheckedOn": "2026-11-07",
              "probes": 2,
              "rate": 0.5,
            },
            "keyword": "aeo",
            "publishedUrl": "https://acme.test/blog/two",
            "rank": {
              "current": 22,
              "delta": null,
              "measuredOn": "2026-11-04",
              "previous": null,
              "samples": 2,
            },
            "rankSource": "serp",
            "traffic": {
              "clicks": null,
              "impressions": null,
              "windowDays": 28,
            },
          },
          {
            "articleId": "art-1",
            "citations": {
              "byEngine": [
                {
                  "engine": "gemini",
                  "probes": 1,
                  "rate": 1,
                },
                {
                  "engine": "perplexity",
                  "probes": 1,
                  "rate": 0,
                },
              ],
              "cited": 1,
              "lastCheckedOn": "2026-11-05",
              "probes": 2,
              "rate": 0.5,
            },
            "keyword": "ai seo",
            "publishedUrl": "https://acme.test/blog/one",
            "rank": {
              "current": 7.3,
              "delta": 2.2,
              "measuredOn": "2026-11-05",
              "previous": 9.5,
              "samples": 2,
            },
            "rankSource": "search_console",
            "traffic": {
              "clicks": 13,
              "impressions": 320,
              "windowDays": 28,
            },
          },
        ],
        "searchConsole": {
          "lastError": null,
          "lastSyncedOn": "2026-11-06",
          "pulledAt": "2026-11-09T07:00:00.000Z",
          "siteUrl": "sc-domain:acme.test",
          "stale": true,
          "status": "connected",
          "syncing": false,
        },
        "totals": {
          "averagePosition": 14.7,
          "citationProbes": 4,
          "citationRate": 0.5,
          "clicks": 13,
          "impressions": 320,
          "published": 3,
          "rankMeasured": 2,
          "ranking": 2,
          "topTen": 1,
        },
        "traffic": {
          "days": [
            {
              "clicks": 0,
              "day": "2026-10-12",
              "impressions": 0,
            },
            {
              "clicks": 0,
              "day": "2026-10-13",
              "impressions": 0,
            },
            {
              "clicks": 0,
              "day": "2026-10-14",
              "impressions": 0,
            },
            {
              "clicks": 0,
              "day": "2026-10-15",
              "impressions": 0,
            },
            {
              "clicks": 0,
              "day": "2026-10-16",
              "impressions": 0,
            },
            {
              "clicks": 0,
              "day": "2026-10-17",
              "impressions": 0,
            },
            {
              "clicks": 0,
              "day": "2026-10-18",
              "impressions": 0,
            },
            {
              "clicks": 0,
              "day": "2026-10-19",
              "impressions": 0,
            },
            {
              "clicks": 0,
              "day": "2026-10-20",
              "impressions": 0,
            },
            {
              "clicks": 0,
              "day": "2026-10-21",
              "impressions": 0,
            },
            {
              "clicks": 0,
              "day": "2026-10-22",
              "impressions": 0,
            },
            {
              "clicks": 0,
              "day": "2026-10-23",
              "impressions": 0,
            },
            {
              "clicks": 0,
              "day": "2026-10-24",
              "impressions": 0,
            },
            {
              "clicks": 0,
              "day": "2026-10-25",
              "impressions": 0,
            },
            {
              "clicks": 0,
              "day": "2026-10-26",
              "impressions": 0,
            },
            {
              "clicks": 0,
              "day": "2026-10-27",
              "impressions": 0,
            },
            {
              "clicks": 4,
              "day": "2026-10-28",
              "impressions": 120,
            },
            {
              "clicks": 0,
              "day": "2026-10-29",
              "impressions": 0,
            },
            {
              "clicks": 0,
              "day": "2026-10-30",
              "impressions": 0,
            },
            {
              "clicks": 0,
              "day": "2026-10-31",
              "impressions": 0,
            },
            {
              "clicks": 0,
              "day": "2026-11-01",
              "impressions": 0,
            },
            {
              "clicks": 0,
              "day": "2026-11-02",
              "impressions": 0,
            },
            {
              "clicks": 0,
              "day": "2026-11-03",
              "impressions": 0,
            },
            {
              "clicks": 0,
              "day": "2026-11-04",
              "impressions": 0,
            },
            {
              "clicks": 9,
              "day": "2026-11-05",
              "impressions": 200,
            },
          ],
          "settledThrough": "2026-11-05",
          "windowDays": 28,
        },
      }
    `);
  });

  it("answers the empty shape with no site, and with no published article", async () => {
    m.businessId = null;
    expect(await body(await results())).toMatchInlineSnapshot(`
      {
        "articles": [],
        "searchConsole": {
          "lastError": null,
          "lastSyncedOn": null,
          "pulledAt": null,
          "siteUrl": null,
          "stale": false,
          "status": "absent",
          "syncing": false,
        },
        "totals": {
          "averagePosition": null,
          "citationProbes": 0,
          "citationRate": null,
          "clicks": null,
          "impressions": null,
          "published": 0,
          "rankMeasured": 0,
          "ranking": 0,
          "topTen": 0,
        },
        "traffic": {
          "days": [],
          "settledThrough": null,
          "windowDays": 28,
        },
      }
    `);
    m.businessId = "biz-1";
    m.db.tables.articles = m.db.tables.articles.filter((a) => a.status !== "published");
    m.db.tables.analytics_connections = [];
    expect(await body(await results())).toMatchInlineSnapshot(`
      {
        "articles": [],
        "searchConsole": {
          "lastError": null,
          "lastSyncedOn": null,
          "pulledAt": null,
          "siteUrl": null,
          "stale": false,
          "status": "absent",
          "syncing": false,
        },
        "totals": {
          "averagePosition": null,
          "citationProbes": 0,
          "citationRate": null,
          "clicks": null,
          "impressions": null,
          "published": 0,
          "rankMeasured": 0,
          "ranking": 0,
          "topTen": 0,
        },
        "traffic": {
          "days": [],
          "settledThrough": null,
          "windowDays": 28,
        },
      }
    `);
  });
});

describe("GET /api/home", () => {
  it("answers exactly what it answered before the aggregation and the counts moved to lib", async () => {
    expect(await body(await home())).toMatchInlineSnapshot(`
      {
        "business": {
          "name": "Acme",
          "niche": "SEO tools",
          "website_url": "https://acme.test",
        },
        "loop": {
          "nextAction": null,
          "replies": {
            "detail": "Drafted and ready for you to post. 1 posted in the last 7 days.",
            "href": "/today",
            "metric": "1 waiting",
            "postedLast7Days": 1,
            "status": "blocked",
            "title": "Replies",
            "waiting": 1,
          },
          "stages": [
            {
              "detail": "2 still unused. Volumes and difficulty are model estimates, labelled as such in the list.",
              "href": "/content/topics",
              "id": "research",
              "metric": "3 keywords",
              "status": "active",
              "title": "Research",
            },
            {
              "detail": "Autopilot keeps empty days ahead filled from the pool.",
              "href": "/content",
              "id": "plan",
              "metric": "4 on the calendar",
              "status": "active",
              "title": "Plan",
            },
            {
              "detail": "The daily run picks the next queued day at 08:00 UTC.",
              "href": "/content",
              "id": "produce",
              "metric": "1 queued",
              "status": "pending",
              "title": "Produce",
            },
            {
              "detail": "Live articles went through the same adapters as every other destination.",
              "href": "/settings/integrations",
              "id": "publish",
              "metric": "3 live",
              "status": "active",
              "title": "Publish",
            },
            {
              "detail": "2 currently ranking. Cited share per engine, from 4 probes, sampled, not ground truth.",
              "href": "/growth",
              "id": "measure",
              "metric": "Gemini 2 of 3 · Perplexity 0 of 1",
              "status": "active",
              "title": "Measure",
            },
          ],
        },
        "unusedKeywords": [
          {
            "id": "kw-4",
            "keyword": "llm seo",
            "opportunity": "Medium",
            "searchVolume": null,
          },
          {
            "id": "kw-5",
            "keyword": "rank tracking",
            "opportunity": "Low",
            "searchVolume": 300,
          },
        ],
        "upcoming": [
          {
            "id": "art-4",
            "keyword": "geo",
            "scheduledDate": "2026-11-12",
            "status": "queued",
          },
        ],
      }
    `);
  });

  it("answers the empty snapshot with no site", async () => {
    m.businessId = null;
    expect(await body(await home())).toMatchInlineSnapshot(`
      {
        "business": {
          "name": null,
          "niche": null,
          "website_url": null,
        },
        "loop": {
          "nextAction": {
            "cta": "Set up business",
            "description": "Paste the website URL. The agent reads it and writes from that description, not from a blank page.",
            "href": "/settings/business",
            "id": "hasBusiness",
            "kind": "onboarding",
            "title": "Set up the site this loop is for",
          },
          "replies": {
            "detail": "None posted in the last 7 days.",
            "href": "/today",
            "metric": "nothing waiting",
            "postedLast7Days": 0,
            "status": "todo",
            "title": "Replies",
            "waiting": 0,
          },
          "stages": [
            {
              "detail": "The agent reads the site and proposes queries. An article is an output of that list, never the starting point.",
              "href": "/content/topics",
              "id": "research",
              "metric": "no keywords yet",
              "status": "todo",
              "title": "Research",
            },
            {
              "detail": "Keywords become one article a day on the calendar. Autopilot, if you turn it on, keeps that filled.",
              "href": "/content",
              "id": "plan",
              "metric": "calendar empty",
              "status": "todo",
              "title": "Plan",
            },
            {
              "detail": "Schedule a keyword and the daily job researches, writes and gates the article.",
              "href": "/content",
              "id": "produce",
              "metric": "not writing yet",
              "status": "todo",
              "title": "Produce",
            },
            {
              "detail": "WordPress or a webhook. Webflow and Shopify are listed as coming soon and are not connected.",
              "href": "/settings/integrations",
              "id": "publish",
              "metric": "site not connected",
              "status": "todo",
              "title": "Publish",
            },
            {
              "detail": "Rank and citation probes start after something is live. A missing number is not a zero.",
              "href": "/growth",
              "id": "measure",
              "metric": "not measured yet",
              "status": "todo",
              "title": "Measure",
            },
          ],
        },
        "unusedKeywords": [],
        "upcoming": [],
      }
    `);
  });
});
