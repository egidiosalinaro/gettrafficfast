import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { FakeSupabase } from "../support/fake-supabase";
import { scheduleKeywords, scheduleOverlap } from "@/lib/calendar/manage";

/**
 * Scheduling never puts two articles on one topic (lib/calendar/manage.ts):
 * a keyword whose near-duplicate is already scheduled, being written or
 * published is left in the pool with a reason, and of two duplicates in one
 * call the first is the one scheduled. A near-duplicate that only sits in
 * the pool blocks nothing.
 */

const USER = "user-1";
const SITE = "biz-1";
const own = { user_id: USER, business_id: SITE };
const NOW = new Date("2026-11-10T10:00:00Z");

const kw = (id: string, keyword: string, over: Record<string, unknown> = {}) => ({ id, ...own, keyword, status: "available", article_id: null, ...over });

let db: FakeSupabase;
const client = () => db as unknown as SupabaseClient;
const schedule = (keywordIds: string[]) => scheduleKeywords({ supabase: client(), userId: USER, businessId: SITE, keywordIds, now: NOW });
const keyword = (id: string) => db.tables.keywords.find((k) => k.id === id);

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  db = new FakeSupabase({
    keywords: [
      kw("k-published", "abandoned cart email", { status: "published", article_id: "a-published" }),
      kw("k-generating", "welcome email series", { status: "queued", article_id: "a-generating" }),
      kw("k-queued", "rfm analysis", { status: "queued", article_id: "a-queued" }),
      kw("k-cart2", "abandoned cart emails"),
      kw("k-welcome2", "welcome series emails"),
      kw("k-rfm2", "what is RFM analysis"),
      kw("k-push", "web push notifications for online store"),
      kw("k-push2", "web push notifications for online stores"),
      kw("k-fresh", "sms marketing for ecommerce"),
    ],
    articles: [
      { id: "a-published", ...own, keyword_id: "k-published", status: "published", published_url: "https://acme.test/cart", scheduled_date: "2026-10-01", title: "Abandoned Cart Email" },
      { id: "a-generating", ...own, keyword_id: "k-generating", status: "generating", published_url: null, scheduled_date: "2026-11-10" },
      { id: "a-queued", ...own, keyword_id: "k-queued", status: "queued", published_url: null, scheduled_date: "2026-11-12" },
    ],
  });
});

describe("scheduleKeywords", () => {
  it("refuses a keyword whose near-duplicate is published, being written or scheduled, each with its reason", async () => {
    const result = await schedule(["k-cart2", "k-welcome2", "k-rfm2", "k-fresh"]);
    if (!result.ok) throw new Error("expected ok");
    expect(result.added).toBe(1);
    expect(result.articles.map((a) => a.keywordId)).toEqual(["k-fresh"]);
    expect(result.overlapping.map((o) => [o.keywordId, o.duplicateOf.keywordId])).toEqual([
      ["k-cart2", "k-published"],
      ["k-welcome2", "k-generating"],
      ["k-rfm2", "k-queued"],
    ]);
    expect(result.overlapping[0].reason).toContain('"abandoned cart emails" overlaps "abandoned cart email", which is already published');
    expect(result.overlapping[2].reason).toContain("already on the calendar");
    expect(result.message).toContain("3 were left out");
    // Left exactly as they were: in the pool, with no article.
    for (const id of ["k-cart2", "k-welcome2", "k-rfm2"]) expect(keyword(id)).toMatchObject({ status: "available", article_id: null });
    expect(db.tables.articles).toHaveLength(4);
  });

  it("schedules the first of two duplicates given in one call, and refuses the second against it", async () => {
    const result = await schedule(["k-push2", "k-push"]);
    if (!result.ok) throw new Error("expected ok");
    expect(result.articles.map((a) => a.keywordId)).toEqual(["k-push2"]);
    expect(result.overlapping).toMatchObject([{ keywordId: "k-push", duplicateOf: { keywordId: "k-push2" } }]);
    expect(keyword("k-push")).toMatchObject({ status: "available", article_id: null });
  });

  it("is not blocked by a near-duplicate that only sits in the pool", async () => {
    const result = await schedule(["k-push"]);
    expect(result).toMatchObject({ ok: true, added: 1, overlapping: [] });
  });

  it("answers added 0, not an error, when every keyword overlaps", async () => {
    const result = await schedule(["k-cart2"]);
    expect(result).toMatchObject({ ok: true, added: 0, articles: [], overlapping: [{ keywordId: "k-cart2" }] });
    expect(db.tables.articles).toHaveLength(3);
  });

  it("refuses on the results page too, when both keywords have a stored snapshot", async () => {
    const top = (n: number) => ({
      results: Array.from({ length: 10 }, (_, i) => ({ url: i < n ? `https://rival.test/p${i}` : `https://other${n}.test/p${i}` })),
    });
    db.tables.serp_snapshots = [
      { ...own, keyword_id: "k-published", captured_at: "2026-11-01T00:00:00Z", results: top(10) },
      { ...own, keyword_id: "k-fresh", captured_at: "2026-11-02T00:00:00Z", results: top(6) },
    ];
    const result = await schedule(["k-fresh"]);
    expect(result).toMatchObject({ ok: true, added: 0, overlapping: [{ keywordId: "k-fresh", duplicateOf: { keywordId: "k-published", reason: "same_serp" } }] });
  });
});

describe("scheduleOverlap, the single add's check", () => {
  it("names what a keyword overlaps, or null when it may be scheduled", async () => {
    expect(await scheduleOverlap(client(), SITE, "k-cart2")).toMatchObject({ keywordId: "k-cart2", duplicateOf: { keywordId: "k-published", publishedUrl: "https://acme.test/cart" } });
    expect(await scheduleOverlap(client(), SITE, "k-fresh")).toBeNull();
    expect(await scheduleOverlap(client(), SITE, "k-push")).toBeNull();
  });
});
