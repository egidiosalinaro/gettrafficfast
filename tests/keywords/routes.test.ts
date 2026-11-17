import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "../support/fake-supabase";

/**
 * PATCH /api/keywords/update writes only what the keywords page changes (the
 * star), validated, on a keyword of the selected site. It used to write the
 * body's `updates` object as is, so a direct call could set business_id,
 * article_id, status or user_id. DELETE /api/keywords/delete is scoped to the
 * selected site the same way.
 */

const m = vi.hoisted(() => ({
  db: null as unknown as FakeSupabase,
  user: { id: "user-1" } as { id: string } | null,
  businessId: "biz-1" as string | null,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => m.db.from(table),
    auth: { getUser: async () => ({ data: { user: m.user } }) },
  }),
}));
vi.mock("@/lib/tenancy", () => ({
  NO_BUSINESS_RESPONSE: { error: "No site set up yet. Add your business first.", code: "no_business" },
  selectedBusinessId: async () => m.businessId,
}));

import { PATCH as update } from "@/app/api/keywords/update/route";
import { DELETE as remove } from "@/app/api/keywords/delete/route";

const patch = (body: unknown) =>
  new Request("https://gettrafficfa.st/api/keywords/update", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }) as never;

const del = (ids: string) => {
  const url = `https://gettrafficfa.st/api/keywords/delete?ids=${ids}`;
  const req = new Request(url, { method: "DELETE" }) as unknown as { nextUrl: URL };
  req.nextUrl = new URL(url);
  return req as never;
};

const keyword = (id: string) => m.db.tables.keywords.find((k) => k.id === id);

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  m.user = { id: "user-1" };
  m.businessId = "biz-1";
  m.db = new FakeSupabase({
    keywords: [
      { id: "kw-1", user_id: "user-1", business_id: "biz-1", keyword: "seo", status: "available", is_starred: false, article_id: null },
      // The same user's other site.
      { id: "kw-2", user_id: "user-1", business_id: "biz-2", keyword: "aeo", status: "available", is_starred: false, article_id: null },
    ],
  });
});

describe("PATCH /api/keywords/update", () => {
  it("stars a keyword of the selected site, the body the keywords page sends", async () => {
    const res = await update(patch({ keywordId: "kw-1", updates: { is_starred: true } }));
    expect(res.status).toBe(200);
    expect((await res.json()).keyword).toMatchObject({ id: "kw-1", is_starred: true });
    expect(keyword("kw-1")?.is_starred).toBe(true);
  });

  it("refuses any field but the star, and writes nothing", async () => {
    for (const updates of [
      { is_starred: true, business_id: "biz-other" },
      { business_id: "biz-other" },
      { user_id: "user-2" },
      { status: "published" },
      { article_id: "a-1" },
      { is_starred: "yes" },
      {},
    ]) {
      const res = await update(patch({ keywordId: "kw-1", updates }));
      expect(res.status).toBe(400);
    }
    expect(keyword("kw-1")).toMatchObject({ business_id: "biz-1", user_id: "user-1", status: "available", is_starred: false, article_id: null });
  });

  it("answers 400 to a missing id or a body that is not JSON", async () => {
    expect((await update(patch({ updates: { is_starred: true } }))).status).toBe(400);
    expect((await update(patch("not json"))).status).toBe(400);
  });

  it("does not find a keyword of another site of the same user", async () => {
    const res = await update(patch({ keywordId: "kw-2", updates: { is_starred: true } }));
    expect(res.status).toBe(404);
    expect(keyword("kw-2")?.is_starred).toBe(false);
  });

  it("answers 401 signed out and 409 without a site", async () => {
    m.user = null;
    expect((await update(patch({ keywordId: "kw-1", updates: { is_starred: true } }))).status).toBe(401);
    m.user = { id: "user-1" };
    m.businessId = null;
    expect((await update(patch({ keywordId: "kw-1", updates: { is_starred: true } }))).status).toBe(409);
  });
});

describe("DELETE /api/keywords/delete", () => {
  it("deletes only the selected site's keywords among the ids given", async () => {
    const res = await remove(del("kw-1,kw-2"));
    expect(res.status).toBe(200);
    expect(keyword("kw-1")).toBeUndefined();
    expect(keyword("kw-2")).toBeDefined();
  });

  it("answers 409 without a site and deletes nothing", async () => {
    m.businessId = null;
    expect((await remove(del("kw-1"))).status).toBe(409);
    expect(m.db.tables.keywords).toHaveLength(2);
  });
});
