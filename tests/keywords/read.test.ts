import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "../support/fake-supabase";

/**
 * GET /api/keywords/get reads through lib/keywords/read.ts, the function
 * `list_keywords` and `recommend_keywords` share. Pinned: the route's
 * answer, captured before the read moved: the selected site's pool, newest
 * first, `search` and `status` applied, each keyword with the link of its
 * live article.
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

import { GET as getKeywords } from "@/app/api/keywords/get/route";
import { bestPicks, sortKeywords } from "@/lib/keywords/picks";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const owned = { user_id: "user-1", business_id: "biz-1" };

function kw(id: string, keyword: string, created: string, over: Record<string, unknown> = {}) {
  return {
    id,
    ...owned,
    keyword,
    search_volume: 500,
    competition: "Medium",
    difficulty: 40,
    cpc: 1.2,
    opportunity: "High",
    status: "available",
    is_starred: false,
    article_id: null,
    created_at: created,
    ...over,
  };
}

beforeEach(() => {
  m.businessId = "biz-1";
  m.db = new FakeSupabase({
    keywords: [
      kw("kw-1", "AI SEO tools", "2026-10-01T00:00:00.000Z", { article_id: "art-1", status: "published" }),
      kw("kw-2", "aeo checklist", "2026-10-03T00:00:00.000Z", { article_id: "art-2", status: "scheduled" }),
      kw("kw-3", "seo for saas", "2026-10-02T00:00:00.000Z", { opportunity: "Low", difficulty: 70, search_volume: null }),
      kw("kw-9", "other site", "2026-10-04T00:00:00.000Z", { business_id: "biz-2" }),
    ],
    articles: [
      { id: "art-1", ...owned, published_url: "https://acme.test/ai-seo-tools" },
      { id: "art-2", ...owned, published_url: null },
    ],
  });
});

const get = async (query = "") => {
  const url = `https://gettrafficfa.st/api/keywords/get${query}`;
  const request = new Request(url) as unknown as { nextUrl: URL };
  request.nextUrl = new URL(url);
  const response = await getKeywords(request as never);
  expect(response.status).toBe(200);
  return response.json();
};

describe("GET /api/keywords/get", () => {
  it("answers exactly what it answered before the read moved to lib", async () => {
    expect(await get()).toMatchInlineSnapshot(`
      {
        "keywords": [
          {
            "article_id": "art-2",
            "business_id": "biz-1",
            "competition": "Medium",
            "cpc": 1.2,
            "created_at": "2026-10-03T00:00:00.000Z",
            "difficulty": 40,
            "id": "kw-2",
            "is_starred": false,
            "keyword": "aeo checklist",
            "opportunity": "High",
            "published_url": null,
            "search_volume": 500,
            "status": "scheduled",
            "user_id": "user-1",
          },
          {
            "article_id": null,
            "business_id": "biz-1",
            "competition": "Medium",
            "cpc": 1.2,
            "created_at": "2026-10-02T00:00:00.000Z",
            "difficulty": 70,
            "id": "kw-3",
            "is_starred": false,
            "keyword": "seo for saas",
            "opportunity": "Low",
            "published_url": null,
            "search_volume": null,
            "status": "available",
            "user_id": "user-1",
          },
          {
            "article_id": "art-1",
            "business_id": "biz-1",
            "competition": "Medium",
            "cpc": 1.2,
            "created_at": "2026-10-01T00:00:00.000Z",
            "difficulty": 40,
            "id": "kw-1",
            "is_starred": false,
            "keyword": "AI SEO tools",
            "opportunity": "High",
            "published_url": "https://acme.test/ai-seo-tools",
            "search_volume": 500,
            "status": "published",
            "user_id": "user-1",
          },
        ],
      }
    `);
  });

  it("filters by search, case-insensitively, and by status", async () => {
    const searched = (await get("?search=seo")) as { keywords: Array<{ id: string }> };
    expect(searched.keywords.map((k) => k.id)).toEqual(["kw-3", "kw-1"]);
    const scheduled = (await get("?status=scheduled")) as { keywords: Array<{ id: string }> };
    expect(scheduled.keywords.map((k) => k.id)).toEqual(["kw-2"]);
  });

  it("answers an empty pool with no site", async () => {
    m.businessId = null;
    expect(await get()).toEqual({ keywords: [] });
  });
});

describe("best picks and the sort (lib/keywords/picks.ts)", () => {
  const pool = [
    { id: "a", opportunity: "High", difficulty: 60, search_volume: 100, cpc: null, article_id: null },
    { id: "b", opportunity: "High", difficulty: 61, search_volume: null, cpc: 2, article_id: null },
    { id: "c", opportunity: "High", difficulty: 10, search_volume: 900, cpc: 1, article_id: "art-1" },
    { id: "d", opportunity: "Medium", difficulty: 5, search_volume: 50, cpc: 3, article_id: null },
    { id: "e", opportunity: "High", difficulty: 30, search_volume: 300, cpc: 0.5, article_id: null },
  ];

  it("keeps the page's rule: not on the calendar, High opportunity, difficulty 60 or less", () => {
    expect(bestPicks(pool).map((k) => k.id)).toEqual(["a", "e"]);
    // The rule the page applied inline before it called the function.
    expect(bestPicks(pool)).toEqual(
      pool.filter((k) => !k.article_id).filter((k) => k.opportunity === "High" && k.difficulty <= 60)
    );
  });

  it("sorts like the table: unknown values last whatever the direction", () => {
    expect(sortKeywords(pool, { column: "search_volume", dir: "desc" }).map((k) => k.id)).toEqual(["c", "e", "a", "d", "b"]);
    expect(sortKeywords(pool, { column: "search_volume", dir: "asc" }).map((k) => k.id)).toEqual(["d", "a", "e", "c", "b"]);
    expect(sortKeywords(pool, { column: "cpc", dir: "asc" }).map((k) => k.id)).toEqual(["e", "c", "b", "d", "a"]);
    expect(sortKeywords(pool, { column: "opportunity", dir: "desc" }).map((k) => k.id)).toEqual(["a", "b", "c", "e", "d"]);
    expect(sortKeywords(pool, null).map((k) => k.id)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("is what the Keywords page calls, not a copy of it", () => {
    const page = readFileSync(path.join(root, "app/(app)/content/topics/page.tsx"), "utf8");
    expect(page).toContain('from "@/lib/keywords/picks"');
    expect(page).not.toMatch(/opportunity === "High" && k\.difficulty <= 60/);
  });
});
