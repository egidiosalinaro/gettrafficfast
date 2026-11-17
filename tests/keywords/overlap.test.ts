import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { FakeSupabase } from "../support/fake-supabase";

/**
 * Near-duplicates where keywords enter the pool and where the existing
 * clusters are reported (lib/keywords/overlap.ts, lib/keywords/manage.ts):
 * a new phrase that overlaps a keyword the site has, a published article or
 * an earlier phrase of the same call is not added and comes back with what
 * it overlaps, unless the caller overrides; suggestions leave them out; the
 * clusters come with Search Console's counts and the member to keep, and a
 * member nobody measured reads null, never 0.
 */

const mocks = vi.hoisted(() => ({ similar: vi.fn() }));
vi.mock("@/lib/research/keywords", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/research/keywords")>()),
  findSimilarKeywords: (...args: unknown[]) => mocks.similar(...args),
}));

import { addKeywords, suggestKeywords } from "@/lib/keywords/manage";
import { loadOverlappingTopics, pickKeeper, type OverlapMember } from "@/lib/keywords/overlap";

const USER = "user-1";
const SITE = "biz-1";
const OTHER_SITE = "biz-2";
const own = { user_id: USER, business_id: SITE };

const kw = (id: string, keyword: string, over: Record<string, unknown> = {}) => ({
  id,
  ...own,
  keyword,
  status: "available",
  article_id: null,
  ...over,
});
const art = (id: string, keywordId: string, over: Record<string, unknown> = {}) => ({
  id,
  ...own,
  keyword_id: keywordId,
  status: "published",
  published_url: `https://acme.test/${id}`,
  scheduled_date: "2026-10-01",
  title: null,
  ...over,
});
const metric = (articleId: string, day: string, impressions: number, clicks: number, position: number | null) => ({
  ...own,
  article_id: articleId,
  captured_on: day,
  source: "search_console",
  impressions,
  clicks,
  position,
});

let db: FakeSupabase;
const client = () => db as unknown as SupabaseClient;
const add = (keywords: string[], allowDuplicates?: boolean) =>
  addKeywords({ supabase: client(), userId: USER, businessId: SITE, keywords: keywords.map((keyword) => ({ keyword })), allowDuplicates });
const stored = () => db.tables.keywords.filter((k) => k.business_id === SITE).map((k) => k.keyword);

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.similar.mockReset();
  db = new FakeSupabase({
    businesses: [{ id: SITE, user_id: USER, niche: "ecommerce email", description: "", content_language: "en" }],
    keywords: [
      kw("k-cart", "abandoned cart email", { status: "published", article_id: "a-cart" }),
      kw("k-push", "web push notifications for online store"),
      // Another site of the same account: never compared.
      kw("k-other", "rfm analysis", { business_id: OTHER_SITE }),
    ],
    articles: [
      art("a-cart", "k-cart", { title: "Abandoned Cart Email: 9 Examples That Recover Sales" }),
      // A published article whose keyword is gone: its title still covers the topic.
      art("a-orphan", "", { keyword_id: null, title: "Welcome Email Series for Ecommerce: A Complete Guide" }),
    ],
  });
});

describe("adding keywords", () => {
  it("does not add a near-duplicate of a keyword the site has, and says what it overlaps", async () => {
    const result = await add(["web push notifications for online stores", "rfm analysis"]);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.keywords.map((k) => k.keyword)).toEqual(["rfm analysis"]);
    expect(result.duplicates).toEqual([
      {
        keyword: "web push notifications for online stores",
        reason: "same_words",
        why: expect.any(String),
        duplicateOfPhrase: null,
        duplicateOf: expect.objectContaining({ keywordId: "k-push", keyword: "web push notifications for online store", status: "available", articleId: null }),
      },
    ]);
    expect(result.message).toContain("1 keyword was not added");
    expect(stored()).not.toContain("web push notifications for online stores");
  });

  it("names the published article when the overlapped keyword has one", async () => {
    const result = await add(["abandoned cart emails"]);
    expect(result).toMatchObject({
      ok: true,
      keywords: [],
      duplicates: [{ duplicateOf: { keywordId: "k-cart", articleId: "a-cart", publishedUrl: "https://acme.test/a-cart", status: "published" } }],
    });
    expect(stored()).toHaveLength(2);
  });

  it("does not add a phrase a published article's title already covers", async () => {
    const result = await add(["welcome email series ecommerce"]);
    expect(result).toMatchObject({
      ok: true,
      keywords: [],
      duplicates: [{ reason: "title_covers", duplicateOf: { keywordId: null, articleId: "a-orphan", articleTitle: expect.stringContaining("Welcome Email Series") } }],
    });
  });

  it("keeps the first of two near-duplicates in one call and reports the second against it", async () => {
    const result = await add(["rfm analysis", "what is rfm analysis", "rfm analysis for ecommerce"]);
    if (!result.ok) throw new Error("expected ok");
    expect(result.keywords.map((k) => k.keyword)).toEqual(["rfm analysis"]);
    expect(result.duplicates.map((d) => [d.keyword, d.duplicateOf, d.duplicateOfPhrase])).toEqual([
      ["what is rfm analysis", null, "rfm analysis"],
      ["rfm analysis for ecommerce", null, "rfm analysis"],
    ]);
  });

  it("adds them all with the explicit override", async () => {
    const result = await add(["web push notifications for online stores", "abandoned cart emails"], true);
    expect(result).toMatchObject({ ok: true, duplicates: [], message: null });
    expect(stored()).toEqual(expect.arrayContaining(["web push notifications for online stores", "abandoned cart emails"]));
  });

  it("never compares with another site's keywords", async () => {
    // "rfm analysis" is site 2's keyword; site 1 may have its own.
    const result = await add(["rfm analysis for ecommerce"]);
    expect(result).toMatchObject({ ok: true, duplicates: [] });
    expect(stored()).toContain("rfm analysis for ecommerce");
  });

  it("answers 500 and adds nothing when the site's topics cannot be read", async () => {
    const from = db.from.bind(db);
    db.from = ((table: string) =>
      table === "articles" ? { select: () => ({ eq: async () => ({ data: null, error: { message: "boom" } }) }) } : from(table)) as never;
    expect(await add(["brand new topic"])).toMatchObject({ ok: false, status: 500 });
    expect(stored()).toHaveLength(2);
  });
});

describe("suggesting keywords", () => {
  it("leaves out ideas that overlap a topic the site has, and lists them apart", async () => {
    mocks.similar.mockResolvedValue([
      { keyword: "abandoned cart email examples" },
      { keyword: "browse abandonment email" },
      { keyword: "browse abandonment emails" },
      { keyword: "abandoned cart email" },
    ]);
    const result = await suggestKeywords({
      supabase: client(),
      admin: () => client(),
      userId: USER,
      businessId: SITE,
      seeds: ["cart"],
      fromBusiness: false,
      source: "test",
    });
    if (!result.ok) throw new Error("expected ok");
    expect(result.suggestions.map((s) => s.keyword)).toEqual(["browse abandonment email"]);
    expect(result.duplicates.map((d) => [d.keyword, d.duplicateOf?.keywordId ?? d.duplicateOfPhrase])).toEqual([
      ["abandoned cart email examples", "k-cart"],
      ["browse abandonment emails", "browse abandonment email"],
    ]);
  });
});

describe("the existing clusters", () => {
  beforeEach(() => {
    db.tables.keywords.push(
      kw("k-cart2", "abandoned cart emails", { status: "published", article_id: "a-cart2" }),
      kw("k-cart3", "abandoned cart email examples", { status: "queued", article_id: "a-cart3" }),
      kw("k-push2", "web push notifications for online stores"),
      kw("k-cited", "how to get cited by ChatGPT", { status: "published", article_id: "a-cited" }),
      kw("k-traffic", "get traffic from ChatGPT", { status: "published", article_id: "a-traffic" })
    );
    db.tables.articles.push(
      art("a-cart2", "k-cart2"),
      art("a-cart3", "k-cart3", { status: "queued", published_url: null, scheduled_date: "2026-11-20" }),
      art("a-cited", "k-cited"),
      art("a-traffic", "k-traffic")
    );
    db.tables.content_metrics = [
      metric("a-cart", "2026-11-01", 100, 2, 12),
      metric("a-cart", "2026-11-02", 300, 5, 8),
      metric("a-cart2", "2026-11-01", 40, 0, 31),
      // A SERP row is not Search Console: never counted as impressions.
      { ...metric("a-cart2", "2026-11-03", 9999, 0, 1), source: "serp" },
    ];
    const top = (n: number) => ({
      results: Array.from({ length: 10 }, (_, i) => ({ position: i + 1, url: i < n ? `https://rival.test/p${i}` : `https://other${n}.test/p${i}` })),
    });
    db.tables.serp_snapshots = [
      { ...own, keyword_id: "k-cited", captured_at: "2026-11-01T00:00:00Z", results: top(10) },
      { ...own, keyword_id: "k-traffic", captured_at: "2026-11-02T00:00:00Z", results: top(7) },
    ];
  });

  it("lists each cluster with its articles, Search Console's counts and the member to keep", async () => {
    const read = await loadOverlappingTopics(client(), SITE);
    if (!read.ok) throw new Error("expected ok");
    expect(read.clusters.map((c) => c.members.map((m) => m.keywordId))).toEqual([
      ["k-cart", "k-cart2", "k-cart3"],
      ["k-cited", "k-traffic"],
      ["k-push", "k-push2"],
    ]);

    const [cart, chatgpt, push] = read.clusters;
    expect(cart.members[0]).toEqual({
      keywordId: "k-cart",
      keyword: "abandoned cart email",
      status: "published",
      article: { id: "a-cart", status: "published", title: expect.any(String), publishedUrl: "https://acme.test/a-cart", scheduledDate: "2026-10-01" },
      // 100 at position 12 and 300 at position 8: weighted, (1200 + 2400) / 400.
      searchConsole: { impressions: 400, clicks: 7, position: 9, days: 2 },
    });
    expect(cart.members[1].searchConsole).toEqual({ impressions: 40, clicks: 0, position: 31, days: 1 });
    // On the calendar, not published: measured by nobody, so null, never 0.
    expect(cart.members[2].searchConsole).toEqual({ impressions: null, clicks: null, position: null, days: 0 });
    expect(cart).toMatchObject({ keeperKeywordId: "k-cart", keeperBasis: "most_impressions" });
    expect(cart.recommendation).toContain("400");

    // Joined by their results pages alone (7 of the top 10), and unmeasured.
    expect(chatgpt).toMatchObject({ reasons: ["same_serp"], keeperKeywordId: null, keeperBasis: "not_measured" });
    // Neither is written: there is nothing to keep yet.
    expect(push).toMatchObject({ reasons: ["same_words"], keeperKeywordId: null, keeperBasis: "nothing_published" });
    expect(push.members.every((m) => m.article === null && m.searchConsole === null)).toBe(true);
  });

  it("changes nothing", async () => {
    const before = JSON.stringify(db.tables);
    await loadOverlappingTopics(client(), SITE);
    expect(JSON.stringify(db.tables)).toBe(before);
    expect(db.calls.filter((c) => !c.startsWith("select:"))).toEqual([]);
  });

  it("answers no cluster for a site with none", async () => {
    expect(await loadOverlappingTopics(client(), OTHER_SITE)).toEqual({ ok: true, clusters: [] });
  });
});

describe("the member to keep", () => {
  const member = (id: string, sc: OverlapMember["searchConsole"], published = true): OverlapMember => ({
    keywordId: id,
    keyword: id,
    status: "published",
    article: { id: `a-${id}`, status: published ? "published" : "queued", title: null, publishedUrl: published ? `https://acme.test/${id}` : null, scheduledDate: null },
    searchConsole: sc,
  });
  const sc = (impressions: number, position: number | null) => ({ impressions, clicks: 0, position, days: 3 });
  const unmeasured = { impressions: null, clicks: null, position: null, days: 0 };

  it("is the one with the most impressions", () => {
    expect(pickKeeper([member("a", sc(10, 3)), member("b", sc(90, 40))])).toMatchObject({ keeperKeywordId: "b", keeperBasis: "most_impressions" });
  });

  it("is the better position when impressions tie", () => {
    expect(pickKeeper([member("a", sc(50, 22)), member("b", sc(50, 7.5)), member("c", sc(50, null))])).toMatchObject({
      keeperKeywordId: "b",
      keeperBasis: "best_position",
    });
  });

  it("is a measured article over one nobody measured, even at zero impressions", () => {
    expect(pickKeeper([member("a", unmeasured), member("b", sc(0, null))])).toMatchObject({ keeperKeywordId: "b" });
  });

  it("is the only published one, whatever was measured", () => {
    expect(pickKeeper([member("a", unmeasured), member("b", unmeasured, false)])).toMatchObject({ keeperKeywordId: "a", keeperBasis: "only_published" });
  });

  it("is nobody when no published article was measured: nothing is guessed", () => {
    expect(pickKeeper([member("a", unmeasured), member("b", unmeasured)])).toMatchObject({ keeperKeywordId: null, keeperBasis: "not_measured" });
  });
});
