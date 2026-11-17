import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock("@/lib/notifications/email", () => ({ operatorEmailAddress: () => null, sendNotificationEmail: vi.fn() }));

import {
  X_MAX_REPLIES,
  X_SEARCH_SOURCE,
  buildXQueries,
  dayIndexOf,
  filterXPosts,
  ownXHandle,
  searchXForBusiness,
  xPostAsTarget,
  xQueryExclusions,
  xQueryFilters,
  xSearchTerm,
  xSearchTerms,
} from "@/lib/placements/x-search";
import { XApiError, type XApiClient } from "@/lib/providers/x/api";
import { LedgerFake, fakeXClient, xPost } from "./x-fake";

/**
 * Finding fresh posts on X: the queries come from what the site is about
 * and rotate, at most three a run; what comes back is deduplicated by post
 * id, and the authors the owner answered this week, the owner's own posts
 * and the crowded posts are left out; what stays is stored as the rows
 * discovery stores, found via x_search, fresh for a day.
 */

const NOW = new Date("2026-11-11T13:20:00.000Z");
const SITE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "11111111-1111-4111-8111-111111111111";

let quiet: Array<ReturnType<typeof vi.spyOn>>;
beforeEach(() => {
  quiet = (["log", "warn", "error"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
});
afterEach(() => quiet.forEach((spy) => spy.mockRestore()));

describe("query building", () => {
  it("turns a topic into a plain term, quoted when it is a phrase, operators stripped", () => {
    expect(xSearchTerm("AEO")).toBe("aeo");
    expect(xSearchTerm("Answer Engine Optimization")).toBe('"answer engine optimization"');
    expect(xSearchTerm('get cited by "ChatGPT"')).toBe('"get cited by chatgpt"');
    expect(xSearchTerm("-spam from:me")).toBe('"spam from me"');
    expect(xSearchTerm("SEO and AEO")).toBe('"seo and aeo"');
    // Too long for an exact phrase anyone wrote, and a bare operator: left out.
    expect(xSearchTerm("SEO and AEO for small businesses")).toBeNull();
    expect(xSearchTerm("OR")).toBeNull();
    expect(xSearchTerm("  ")).toBeNull();
  });

  it("keeps short topics as written, never a one-word entity, never the business's own names", () => {
    expect(
      xSearchTerms({
        keywords: ["AI SEO", "answer engine optimization"],
        entities: ["GetTrafficFast", "ChatGPT", "ai seo"],
        brandNames: ["GetTrafficFast"],
        niche: "SEO for SaaS",
      })
    ).toEqual(['"ai seo"', '"answer engine optimization"', '"seo for saas"']);
    // A one-word keyword is the site's own word ("aeo"); a one-word entity is a brand or a buzzword.
    expect(xSearchTerms({ keywords: ["AEO"], entities: ["Perplexity", "AI"], brandNames: [] })).toEqual(["aeo"]);
  });

  it("cuts long keywords and questions into the phrases people write, the most shared first (the owner's site, 2026-11-14)", () => {
    const terms = xSearchTerms({
      keywords: [
        "Can AI-generated content rank well in SEO?",
        "What are the best AI tools for writing blog posts and articles?",
        "Reduce content writing costs",
        "AI content strategy for Google ranking",
        "Replace SEO agency with AI content",
        "Eliminate content writing costs AI",
        "How to automate content marketing",
        "AI powered content generation software",
        "AI driven organic traffic growth",
        "Best AI SEO content tool",
        "AI content strategy platform",
        "AI agent for content marketing",
        "AI content for answer engines",
        "get more organic traffic with AI",
        "AI content agency alternative",
        "best AI tools for SEO content creation",
        "AI SEO content writer",
      ],
      entities: ["answer engine optimization", "ChatGPT", "Perplexity", "AI agents", "AI", "SEO", "organic traffic", "Keyword Research", "AI-generated SEO blog posts", "AI content engine"],
      brandNames: ["GetTrafficFast"],
      niche: "AI SEO Content",
    });
    expect(terms.slice(0, 4)).toEqual(['"ai content"', '"seo content"', '"organic traffic"', '"ai seo"']);
    expect(terms).toEqual(expect.arrayContaining(['"content strategy"', '"content marketing"', '"content writing"', '"blog posts"', '"ai tools"']));
    // Never a buzzword alone, never a seam between two words, never the brief's joints.
    for (const bad of ["chatgpt", "perplexity", "ai", "seo", '"writing costs"', '"content rank"', '"costs ai"', '"strategy platform"', '"ai powered"']) {
      expect(terms).not.toContain(bad);
    }
  });

  it("asks at most three searches: topics AND question phrases, the language, no reposts, no replies, no ads, never the owner", () => {
    const terms = Array.from({ length: 20 }, (_, i) => `topic${i}`);
    const queries = buildXQueries({ terms, language: "en-US", ownHandle: "samriv", dayIndex: 0 });
    expect(queries).toHaveLength(3);
    const [first] = queries;
    expect(first.topics).toBe("(topic0 OR topic1 OR topic2 OR topic3)");
    expect(first.query.startsWith('(topic0 OR topic1 OR topic2 OR topic3) ("how do i" OR "how do you" OR "anyone know"')).toBe(true);
    expect(first.query).toContain(" lang:en -is:retweet -is:reply -from:samriv -is:nullcast -giveaway -airdrop -wts -wtb ");
    expect(first.query).toContain('-"link in bio" -"dm me"');
    for (const q of queries) expect(q.query.length).toBeLessThanOrEqual(512);
    // The fallback is the same search without the exclusions.
    expect(first.plain).toBe(first.query.split(" -is:nullcast")[0]);
    expect(first.plain).not.toContain("giveaway");
    expect(xQueryFilters("it", null)).toBe("lang:it -is:retweet -is:reply");
    expect(xQueryExclusions()[0]).toBe("-is:nullcast");
  });

  it("asks in the site's language, and the topics alone in a language it has no phrases for", () => {
    const [it_] = buildXQueries({ terms: ['"traffico organico"'], language: "it", dayIndex: 0, queries: 1 });
    expect(it_.query).toContain('"qualcuno sa"');
    expect(it_.query).toContain("lang:it");
    const [ja] = buildXQueries({ terms: ["seo"], language: "ja", dayIndex: 0, queries: 1 });
    expect(ja.query.startsWith("seo lang:ja -is:retweet -is:reply -is:nullcast")).toBe(true);
  });

  it("writes only operators X documents for recent search, and nothing a topic can turn into one", () => {
    const terms = xSearchTerms({ keywords: ['from:spam -is:verified "OR" url:x.com', "has:links OR bio:seo"], entities: [], brandNames: [] });
    const queries = buildXQueries({ terms, language: "en", ownHandle: "me", dayIndex: 0 });
    const operators = new Set<string>();
    for (const q of queries) for (const m of q.query.matchAll(/(?:^|\s)-?([a-z_]+):\S*/g)) operators.add(m[1]);
    expect([...operators].sort()).toEqual(["from", "is", "lang"]);
    for (const q of queries) {
      for (const m of q.query.matchAll(/-?is:(\w+)/g)) expect(["retweet", "reply", "nullcast"]).toContain(m[1]);
      // `is:nullcast` is only ever negated, beside a positive term.
      expect(q.query).not.toMatch(/(^|\s)is:nullcast/);
      expect(q.query.trim().startsWith("-")).toBe(false);
      // Quotes are balanced: an unbalanced one would make X read the rest as a phrase.
      expect((q.query.match(/"/g) ?? []).length % 2).toBe(0);
    }
  });

  it("rotates: the next day starts where today stopped, so every topic is searched in turn", () => {
    const terms = Array.from({ length: 20 }, (_, i) => `t${i}`);
    const today = buildXQueries({ terms, language: "en", dayIndex: 0 });
    const tomorrow = buildXQueries({ terms, language: "en", dayIndex: 1 });
    expect(today.map((q) => q.topics).join(" ")).toContain("t0 ");
    expect(tomorrow[0].topics.startsWith("(t12 OR")).toBe(true);
    expect(dayIndexOf(new Date("1970-01-03T05:00:00Z"))).toBe(2);
  });

  it("asks nothing when the site has said nothing about itself", () => {
    expect(buildXQueries({ terms: [], language: "en", dayIndex: 3 })).toEqual([]);
  });

  it("keeps a search under 512 characters: topics go first, then exclusions, then phrases", () => {
    const long = Array.from({ length: 4 }, (_, i) => `"${"word".repeat(20)}${i}"`);
    const [query] = buildXQueries({ terms: long, language: "en", dayIndex: 0, queries: 1 });
    expect(query.query.length).toBeLessThanOrEqual(512);
    expect(query.topics).toBe(long[0]);
    expect(query.query).toContain('"how do i"');

    const huge = [`"${"word".repeat(70)}"`];
    const [tight] = buildXQueries({ terms: huge, language: "en", dayIndex: 0, queries: 1 });
    expect(tight.query.length).toBeLessThanOrEqual(512);
    expect(tight.query).toContain("word");
    expect(tight.query).toContain("lang:en -is:retweet -is:reply");
  });

  it("reads the owner's handle off the links of the replies they posted", () => {
    expect(ownXHandle(["https://x.com/Samriv/status/1", "https://twitter.com/samriv/status/2", "https://x.com/other/status/3", null])).toBe("samriv");
    expect(ownXHandle(["https://x.com/i/web/status/1"])).toBeNull();
  });
});

describe("filtering", () => {
  const ctx = { existingIds: new Set(["10"]), recentAuthors: new Set(["answered"]), ownHandle: "Samriv" };

  it("drops what is stored already, the authors answered this week, the owner, the crowded and the empty", () => {
    const posts = [
      xPost("10"),
      xPost("11"),
      xPost("11"),
      xPost("12", { handle: "Answered" }),
      xPost("13", { handle: "samriv" }),
      xPost("14", { metrics: { impressions: null, likes: 900, replies: X_MAX_REPLIES + 1, reposts: null, quotes: null, bookmarks: null } }),
      xPost("15", { metrics: { impressions: null, likes: null, replies: null, reposts: null, quotes: null, bookmarks: null } }),
      xPost("16", { text: "  " }),
      xPost("17", { metrics: { impressions: null, likes: 1, replies: X_MAX_REPLIES, reposts: null, quotes: null, bookmarks: null } }),
    ];
    const { keep, skipped } = filterXPosts(posts, ctx);
    // Unknown replies are not "few" or "many": kept. Exactly 50 is not over 50.
    expect(keep.map((p) => p.id)).toEqual(["11", "15", "17"]);
    expect(skipped).toEqual({ duplicate: 2, recentAuthor: 1, own: 1, crowded: 1, empty: 1 });
  });

  it("stores a post as discovery's row: x, post, status id, found via x_search, fresh for 24 hours from the post", () => {
    const row = xPostAsTarget(xPost("1855000000000000001", { handle: "janedoe", createdAt: "2026-11-11T08:00:00.000Z" }), '"ai seo"');
    expect(row).toMatchObject({
      externalId: "status:1855000000000000001",
      surface: "x",
      kind: "post",
      url: "https://x.com/janedoe/status/1855000000000000001",
      community: "@janedoe",
      author: "janedoe",
      createdAt: "2026-11-11T08:00:00.000Z",
      createdAtPrecision: null,
      commentCount: 2,
      foundFor: '"ai seo"',
      foundVia: X_SEARCH_SOURCE,
      freshUntil: "2026-11-12T08:00:00.000Z",
    });
  });
});

describe("one site's daily search", () => {
  const business = { id: SITE, user_id: USER, content_language: "en", niche: "SEO for SaaS" };

  function seed() {
    return new LedgerFake({
      placement_targets: [
        // Stored already: found again, not stored twice.
        { id: "t1", user_id: USER, business_id: SITE, surface: "x", external_id: "status:100", status: "qualified", title: "x", content_hash: "h1" },
        // The owner answered @recent four days ago, through a reply on their own account.
        {
          id: "t2",
          user_id: USER,
          business_id: SITE,
          surface: "x",
          external_id: "status:50",
          author: "recent",
          status: "published_manually",
          published_at: "2026-11-07T10:00:00.000Z",
          published_url: "https://x.com/samriv/status/60",
          title: "y",
          content_hash: "h2",
        },
      ],
    });
  }

  it("searches under the cap, stores what survives the filter, and records the cost", async () => {
    const db = seed();
    const { client, searchRecent } = fakeXClient({
      searches: [[xPost("100"), xPost("101"), xPost("102", { handle: "recent" })], [xPost("103")], []],
    });
    const out = await searchXForBusiness({
      supabase: db as never,
      client,
      business,
      keywords: ["AI SEO", "answer engine optimization", "llms.txt", "content briefs", "topical authority"],
      entities: ["ChatGPT"],
      brandNames: ["GetTrafficFast"],
      now: NOW,
    });

    expect(searchRecent).toHaveBeenCalledTimes(out.queries.length);
    expect(out.queries.length).toBeLessThanOrEqual(3);
    expect(out.queries[0]).toContain("-from:samriv");
    expect((searchRecent.mock.calls[0] as unknown as [{ startTime: Date; maxResults: number }])[0]).toMatchObject({
      maxResults: 10,
      startTime: new Date("2026-11-11T01:20:00.000Z"),
    });
    expect(out).toMatchObject({ returned: 4, stored: 2, stopped: null, costUsd: 0.02 });
    expect(out.skipped).toMatchObject({ duplicate: 1, recentAuthor: 1 });

    const stored = db.tables.placement_targets.filter((r) => r.found_via === X_SEARCH_SOURCE);
    expect(stored.map((r) => r.external_id).sort()).toEqual(["status:101", "status:103"]);
    expect(stored[0]).toMatchObject({ surface: "x", kind: "post", status: "discovered", fresh_until: "2026-11-12T08:00:00.000Z" });
    // What a post was found for is the topics, not the phrases or the filters.
    expect(String(stored[0].found_for)).not.toContain("how do i");
    expect(String(stored[0].found_for)).not.toContain("lang:");
    expect(db.spend("2026-11-01")).toMatchObject({ cost_usd: 0.02, posts: 4 });
  });

  it("sends the search once without the exclusions when X refuses the query (400), and bills nothing for the refusal", async () => {
    const db = seed();
    const searchRecent = vi.fn(async (params: { query: string }) => {
      if (params.query.includes("-is:nullcast")) throw new XApiError('X API failed (400): {"title":"Invalid Request"}', "http", { status: 400 });
      return { posts: [xPost("201")], missingIds: [], billedPosts: 1, costUsd: 0.005 };
    });
    const out = await searchXForBusiness({
      supabase: db as never,
      client: { searchRecent } as unknown as XApiClient,
      business,
      keywords: ["AI SEO"],
      entities: [],
      brandNames: [],
      now: NOW,
    });
    expect(out.queries).toHaveLength(1);
    expect(searchRecent).toHaveBeenCalledTimes(2);
    const second = (searchRecent.mock.calls[1] as unknown as [{ query: string }])[0].query;
    expect(second).not.toContain("-is:nullcast");
    expect(second).toContain('"how do i"');
    expect(out).toMatchObject({ calls: 1, returned: 1, stored: 1, stopped: null, costUsd: 0.005 });
    expect(out.notes[0]).toContain("searched again without the exclusions");
    expect(db.spend("2026-11-01")).toMatchObject({ cost_usd: 0.005, posts: 1 });
  });

  it("does not retry a search X refused for another reason", async () => {
    const db = seed();
    const searchRecent = vi.fn(async () => {
      throw new XApiError("X API failed (503): unavailable", "http", { status: 503 });
    });
    const out = await searchXForBusiness({
      supabase: db as never,
      client: { searchRecent } as unknown as XApiClient,
      business,
      keywords: ["AI SEO"],
      entities: [],
      brandNames: [],
      now: NOW,
    });
    expect(searchRecent).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ calls: 0, stored: 0, stopped: null });
  });

  it("stops at the cap: no search is made once the next one would cross it", async () => {
    const db = seed();
    db.tables.provider_spend.push({ provider: "x-api", month: "2026-11-01", cost_usd: 19.97, calls: 1, posts: 1 });
    const { client, searchRecent } = fakeXClient({ searches: [[xPost("101")]] });
    const out = await searchXForBusiness({ supabase: db as never, client, business, keywords: ["AI SEO"], entities: [], brandNames: [], now: NOW });
    expect(searchRecent).not.toHaveBeenCalled();
    expect(out).toMatchObject({ calls: 0, stored: 0, stopped: "cap" });
    expect(out.notes[0]).toContain("this month's allowance for X is used up");
  });
});
