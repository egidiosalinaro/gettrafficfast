import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "../support/fake-supabase";

/**
 * GET /api/calendar/get reads through lib/calendar/read.ts, the function
 * `list_calendar` and `get_article` share. Pinned: the route's answer,
 * captured before the read moved, bodies included, for the selected site
 * only and ordered by day.
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

import { GET as calendar } from "@/app/api/calendar/get/route";

const owned = { user_id: "user-1", business_id: "biz-1" };

const canonical = {
  schemaVersion: 1,
  articleId: "art-1",
  title: "AI SEO, plainly",
  bodyHtml: '<h2 id="what">What</h2><p>It is.</p>',
  headings: [{ level: 2, id: "what", text: "What" }],
  excerpt: "It is.",
  metaDescription: "It is.",
  wordCount: 2,
  slug: "ai-seo",
  keyword: "ai seo",
  language: "en",
  scheduledDate: "2026-11-10",
};

beforeEach(() => {
  m.businessId = "biz-1";
  m.db = new FakeSupabase({
    articles: [
      {
        id: "art-2",
        ...owned,
        scheduled_date: "2026-11-12",
        status: "queued",
        content: null,
        canonical: null,
        quality_report: null,
        published_url: null,
        last_error: null,
        keyword_id: "kw-2",
        keywords: [{ id: "kw-2", keyword: "aeo", search_volume: null }],
      },
      {
        id: "art-1",
        ...owned,
        scheduled_date: "2026-11-10",
        status: "published",
        content: "<p>legacy</p>",
        canonical,
        quality_report: { decision: "publish", ranAt: "2026-11-10T08:00:00.000Z", wordCount: 2, issues: [], stages: [] },
        published_url: "https://acme.test/ai-seo",
        last_error: null,
        keyword_id: "kw-1",
        keywords: { id: "kw-1", keyword: "ai seo", search_volume: 900 },
      },
      {
        id: "art-3",
        ...owned,
        scheduled_date: "2026-11-11",
        status: "failed",
        content: null,
        canonical: null,
        quality_report: null,
        published_url: null,
        last_error: "generation: timed out",
        keyword_id: null,
        keywords: null,
      },
      { id: "art-9", user_id: "user-1", business_id: "biz-2", scheduled_date: "2026-11-10", status: "queued", keywords: null },
    ],
  });
});

describe("GET /api/calendar/get", () => {
  it("answers exactly what it answered before the read moved to lib", async () => {
    const response = await calendar();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchInlineSnapshot(`
      {
        "articles": [
          {
            "canonical": {
              "articleId": "art-1",
              "bodyHtml": "<h2 id="what">What</h2><p>It is.</p>",
              "excerpt": "It is.",
              "headings": [
                {
                  "id": "what",
                  "level": 2,
                  "text": "What",
                },
              ],
              "keyword": "ai seo",
              "language": "en",
              "metaDescription": "It is.",
              "scheduledDate": "2026-11-10",
              "schemaVersion": 1,
              "slug": "ai-seo",
              "title": "AI SEO, plainly",
              "wordCount": 2,
            },
            "content": "<p>legacy</p>",
            "id": "art-1",
            "keyword": "ai seo",
            "keywordId": "kw-1",
            "lastError": null,
            "publishedUrl": "https://acme.test/ai-seo",
            "qualityReport": {
              "decision": "publish",
              "issues": [],
              "ranAt": "2026-11-10T08:00:00.000Z",
              "stages": [],
              "wordCount": 2,
            },
            "scheduledDate": "2026-11-10",
            "searchVolume": 900,
            "status": "published",
          },
          {
            "canonical": null,
            "content": null,
            "id": "art-3",
            "keyword": "",
            "keywordId": null,
            "lastError": "generation: timed out",
            "publishedUrl": null,
            "qualityReport": null,
            "scheduledDate": "2026-11-11",
            "searchVolume": null,
            "status": "failed",
          },
          {
            "canonical": null,
            "content": null,
            "id": "art-2",
            "keyword": "aeo",
            "keywordId": "kw-2",
            "lastError": null,
            "publishedUrl": null,
            "qualityReport": null,
            "scheduledDate": "2026-11-12",
            "searchVolume": null,
            "status": "queued",
          },
        ],
      }
    `);
  });

  it("answers an empty calendar with no site", async () => {
    m.businessId = null;
    const response = await calendar();
    expect(await response.json()).toEqual({ articles: [] });
  });

  it("answers one article of the site with ?articleId, in the same shape, for the Content screen's modal", async () => {
    const ID = "0f0f0f0f-0000-4000-8000-000000000001";
    const OTHER_SITE = "0f0f0f0f-0000-4000-8000-000000000009";
    m.db.tables.articles.push(
      { ...m.db.tables.articles[1], id: ID },
      { id: OTHER_SITE, user_id: "user-1", business_id: "biz-2", scheduled_date: "2026-11-10", status: "queued", keywords: null }
    );
    const one = await calendar(new Request(`https://gettrafficfa.st/api/calendar/get?articleId=${ID}`));
    const body = await one.json();
    expect(body.articles).toHaveLength(1);
    expect(body.articles[0]).toMatchObject({ id: ID, keyword: "ai seo", status: "published", canonical: { title: "AI SEO, plainly" } });
    // Another of the user's sites, or not an id at all: nothing.
    const other = await calendar(new Request(`https://gettrafficfa.st/api/calendar/get?articleId=${OTHER_SITE}`));
    expect(await other.json()).toEqual({ articles: [] });
    const junk = await calendar(new Request("https://gettrafficfa.st/api/calendar/get?articleId=art-1"));
    expect(await junk.json()).toEqual({ articles: [] });
  });
});
