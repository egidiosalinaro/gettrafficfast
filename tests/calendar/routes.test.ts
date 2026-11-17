import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "../support/fake-supabase";

/**
 * The calendar routes, end to end through their handlers on the fake client:
 *
 *  - adding to the calendar (one or in bulk) is a paid action, because every
 *    queued article is one the generation cron pays to write: a lapsed
 *    account gets the paywall's 402 and nothing is scheduled;
 *  - both adds put keywords on the site's first free days after today, the
 *    rule they now share (lib/calendar/schedule.ts);
 *  - changes by id (remove, re-queue, reschedule) find an article only on the
 *    selected site, not on any site of the same user.
 */

const m = vi.hoisted(() => ({
  db: null as unknown as FakeSupabase,
  user: { id: "user-1" } as { id: string } | null,
  businessId: "biz-1" as string | null,
  subscribed: true,
  rpc: [] as Array<{ fn: string; args: unknown }>,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => m.db.from(table),
    rpc: async (fn: string, args: unknown) => {
      m.rpc.push({ fn, args });
      return { data: null, error: null };
    },
    auth: { getUser: async () => ({ data: { user: m.user } }) },
  }),
}));
vi.mock("@/lib/subscription", () => ({ hasActiveSubscription: async () => m.subscribed }));
vi.mock("@/lib/tenancy", () => ({
  NO_BUSINESS_RESPONSE: { error: "No site set up yet. Add your business first.", code: "no_business" },
  selectedBusinessId: async () => m.businessId,
}));

import { POST as add } from "@/app/api/calendar/add/route";
import { POST as addBulk } from "@/app/api/calendar/add-bulk/route";
import { POST as remove } from "@/app/api/calendar/remove/route";
import { POST as requeue } from "@/app/api/calendar/requeue/route";
import { POST as reschedule } from "@/app/api/calendar/reschedule/route";

const post = (path: string, body: unknown) =>
  new Request(`https://gettrafficfa.st${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as never;

function seed() {
  return new FakeSupabase({
    keywords: [
      { id: "kw-1", user_id: "user-1", business_id: "biz-1", keyword: "seo", status: "available", article_id: null },
      { id: "kw-2", user_id: "user-1", business_id: "biz-1", keyword: "aeo", status: "available", article_id: null },
      { id: "kw-3", user_id: "user-1", business_id: "biz-1", keyword: "geo", status: "available", article_id: null },
      // The same user's other site.
      { id: "kw-9", user_id: "user-1", business_id: "biz-2", keyword: "other", status: "available", article_id: null },
    ],
    articles: [
      { id: "a-10", user_id: "user-1", business_id: "biz-1", keyword_id: "kw-x", scheduled_date: "2026-11-10", status: "queued" },
      { id: "a-12", user_id: "user-1", business_id: "biz-1", keyword_id: "kw-y", scheduled_date: "2026-11-12", status: "failed" },
      // Taken on the other site only: free for biz-1.
      { id: "a-20", user_id: "user-1", business_id: "biz-2", keyword_id: "kw-9", scheduled_date: "2026-11-11", status: "failed" },
    ],
  });
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-11-09T10:00:00Z"), toFake: ["Date"] });
  vi.spyOn(console, "error").mockImplementation(() => {});
  m.db = seed();
  m.user = { id: "user-1" };
  m.businessId = "biz-1";
  m.subscribed = true;
  m.rpc = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const articlesOf = (business: string) =>
  m.db.tables.articles.filter((a) => a.business_id === business);

describe("POST /api/calendar/add", () => {
  it("answers 402 to a lapsed account and schedules nothing", async () => {
    m.subscribed = false;
    const res = await add(post("/api/calendar/add", { keywordId: "kw-1" }));
    expect(res.status).toBe(402);
    expect((await res.json()).code).toBe("subscription_required");
    expect(m.db.tables.articles).toHaveLength(3);
    expect(m.db.tables.keywords[0].article_id).toBeNull();
  });

  it("answers 401 signed out and 409 without a site", async () => {
    m.user = null;
    expect((await add(post("/api/calendar/add", { keywordId: "kw-1" }))).status).toBe(401);
    m.user = { id: "user-1" };
    m.businessId = null;
    expect((await add(post("/api/calendar/add", { keywordId: "kw-1" }))).status).toBe(409);
  });

  it("puts the keyword on the site's first free day after today and links it", async () => {
    const res = await add(post("/api/calendar/add", { keywordId: "kw-1" }));
    expect(res.status).toBe(200);
    const { article } = await res.json();
    // 11-10 is taken on this site; 11-11 is taken only on the other one.
    expect(article).toMatchObject({ business_id: "biz-1", keyword_id: "kw-1", scheduled_date: "2026-11-11", status: "queued" });
    expect(m.db.tables.keywords[0]).toMatchObject({ status: "queued", article_id: article.id });
  });

  it("does not schedule a keyword of another site", async () => {
    const res = await add(post("/api/calendar/add", { keywordId: "kw-9" }));
    expect(res.status).toBe(404);
    expect(articlesOf("biz-1")).toHaveLength(2);
  });
});

describe("POST /api/calendar/add-bulk", () => {
  it("answers 402 to a lapsed account and schedules nothing", async () => {
    m.subscribed = false;
    const res = await addBulk(post("/api/calendar/add-bulk", { keywordIds: ["kw-1", "kw-2"] }));
    expect(res.status).toBe(402);
    expect(m.db.tables.articles).toHaveLength(3);
  });

  it("fills the site's free days in order, one keyword each, and skips other sites' keywords", async () => {
    const res = await addBulk(post("/api/calendar/add-bulk", { keywordIds: ["kw-1", "kw-2", "kw-3", "kw-9"] }));
    expect(res.status).toBe(200);
    expect((await res.json()).added).toBe(3);
    const seeded = new Set(["a-10", "a-12", "a-20"]);
    const added = articlesOf("biz-1")
      .filter((a) => !seeded.has(String(a.id)))
      .map((a) => [a.keyword_id, a.scheduled_date]);
    expect(added).toEqual([
      ["kw-1", "2026-11-11"],
      ["kw-2", "2026-11-13"],
      ["kw-3", "2026-11-14"],
    ]);
    expect(m.db.tables.keywords.find((k) => k.id === "kw-9")?.article_id).toBeNull();
    for (const id of ["kw-1", "kw-2", "kw-3"]) {
      expect(m.db.tables.keywords.find((k) => k.id === id)?.status).toBe("queued");
    }
  });
});

describe("changes by id are scoped to the selected site", () => {
  it("remove: an article of another site of the same user is not found and stays", async () => {
    const res = await remove(post("/api/calendar/remove", { articleId: "a-20" }));
    expect(res.status).toBe(404);
    expect(m.db.tables.articles.some((a) => a.id === "a-20")).toBe(true);
  });

  it("remove: the selected site's article goes and its keyword is free again", async () => {
    m.db.tables.keywords[0].article_id = "a-10";
    m.db.tables.keywords[0].status = "queued";
    m.db.tables.articles[0].keyword_id = "kw-1";
    const res = await remove(post("/api/calendar/remove", { articleId: "a-10" }));
    expect(res.status).toBe(200);
    expect(m.db.tables.articles.some((a) => a.id === "a-10")).toBe(false);
    expect(m.db.tables.keywords[0]).toMatchObject({ status: "available", article_id: null });
  });

  it("re-queue: another site's failed article is not found and stays failed", async () => {
    const other = await requeue(post("/api/calendar/requeue", { articleId: "a-20" }));
    expect(other.status).toBe(404);
    expect(m.db.tables.articles.find((a) => a.id === "a-20")?.status).toBe("failed");

    const own = await requeue(post("/api/calendar/requeue", { articleId: "a-12" }));
    expect(own.status).toBe(200);
    expect(m.db.tables.articles.find((a) => a.id === "a-12")?.status).toBe("queued");
  });

  it("reschedule: another site's article is not found and never reaches move_article", async () => {
    const other = await reschedule(post("/api/calendar/reschedule", { articleId: "a-20", targetDate: "2026-11-20" }));
    expect(other.status).toBe(404);
    expect(m.rpc).toEqual([]);

    const own = await reschedule(post("/api/calendar/reschedule", { articleId: "a-10", targetDate: "2026-11-20" }));
    expect(own.status).toBe(200);
    expect(m.rpc).toEqual([{ fn: "move_article", args: { p_article_id: "a-10", p_target_date: "2026-11-20" } }]);
  });

  it("each answers 409 without a site", async () => {
    m.businessId = null;
    expect((await remove(post("/api/calendar/remove", { articleId: "a-10" }))).status).toBe(409);
    expect((await requeue(post("/api/calendar/requeue", { articleId: "a-12" }))).status).toBe(409);
    expect((await reschedule(post("/api/calendar/reschedule", { articleId: "a-10", targetDate: "2026-11-20" }))).status).toBe(409);
  });
});
