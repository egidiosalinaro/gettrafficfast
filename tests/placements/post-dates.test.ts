import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Discussion, DiscoveryProvider } from "@/lib/providers/discovery/types";
import { setLlmProvider } from "@/lib/providers/llm/registry";
import type { LLMProvider } from "@/lib/providers/llm/types";
import type { StepContext } from "@/lib/jobs/types";
import { discoverWith, placementDiscoveryWorkflow } from "@/lib/jobs/workflows/placement-discovery";
import { BACKFILL_ROWS_PER_RUN, dateUndatedTargets, withUrlDate } from "@/lib/placements/post-dates";
import { PostDateLookup } from "@/lib/providers/post-dates";
import { inView, isExpired, orderInbox, undatedTooLong, type ViewRow } from "@/lib/placements/inbox-view";
import { rowMeta } from "@/components/placements/reply-logic";
import { FakeSupabase } from "../support/fake-supabase";

/**
 * 2026-11-13, the owner: "Found for you" shows a flood of "date unknown",
 * and the last discovery surfaced X posts from 5 October as if new. A web
 * search result had a date only when Google printed one, the URL was never
 * read, and an undated row was aged from when it was found. Now every found
 * row is dated by the cheapest exact method there is, before the rules, and
 * an unknown date is never fresh.
 */

const DAY = 86_400_000;
/** 2026-10-05T14:30:00Z, as an X snowflake. */
const OCT_5_STATUS = "2107116094878658617";
const FOUND_ON = new Date("2026-11-12T09:00:00Z");

const BUSINESS = {
  id: "biz-1",
  user_id: "user-1",
  name: "GetTrafficFast",
  niche: "AI SEO content",
  website_url: "https://gettrafficfa.st",
  content_language: "en",
  aeo_settings: {},
  voice_settings: {},
};

function db(targets: Array<Record<string, unknown>> = []): FakeSupabase {
  return new FakeSupabase({
    businesses: [{ ...BUSINESS }],
    keywords: [{ business_id: "biz-1", keyword: "ai seo", created_at: "2026-09-01" }],
    entities: [],
    placement_targets: targets,
    agent_runs: [],
    jobs: [{ id: "job-1", status: "running", result: null }],
  });
}

function ctx(fake: FakeSupabase): StepContext {
  const input = { businessId: "biz-1" };
  return {
    job: {
      id: "job-1",
      user_id: "user-1",
      article_id: null,
      type: "placement-discovery",
      input,
      status: "running",
      current_step: null,
      attempts: 1,
      max_attempts: 3,
      last_error: null,
    },
    supabase: fake as unknown as SupabaseClient,
    input,
    outputs: {},
    deadline: Date.now() + 120_000,
  };
}

const step = (name: string) => placementDiscoveryWorkflow.steps.find((s) => s.name === name)!;

const xPost = (over: Partial<Discussion> = {}): Discussion => ({
  externalId: `status:${OCT_5_STATUS}`,
  surface: "x",
  kind: "post",
  url: `https://x.com/someone/status/${OCT_5_STATUS}`,
  title: "Anyone else seeing ai seo traffic move to answer engines?",
  excerpt: "Our ai seo pages get cited less every week.",
  community: "@someone",
  author: "someone",
  createdAt: null,
  createdAtPrecision: null,
  score: null,
  commentCount: null,
  ...over,
});

function webSearch(found: Discussion[]): DiscoveryProvider {
  return { name: "web-search", search: async () => found };
}

/** A model that records being asked, and must not be. */
function watchedLlm(): { provider: LLMProvider; calls: () => number } {
  let calls = 0;
  const provider: LLMProvider = {
    name: "watched",
    async generateText() {
      calls += 1;
      throw new Error("no model call expected");
    },
    async generateStructured() {
      calls += 1;
      throw new Error("no model call expected");
    },
  };
  return { provider, calls: () => calls };
}

afterEach(() => {
  setLlmProvider(null);
  vi.unstubAllGlobals();
});

describe("dating at discovery, before the rules", () => {
  it("stores an X post with the instant its id carries, over the engine's printed bound", async () => {
    const fake = db();
    await discoverWith({
      supabase: fake as unknown as SupabaseClient,
      provider: webSearch([
        xPost(),
        // Google said "1 day ago": the id says 5 October.
        xPost({
          externalId: "status:2107116094878658618",
          url: "https://x.com/other/status/2107116094878658618",
          title: "A second post about ai seo and answer engines",
          createdAt: "2026-11-11T09:00:00Z",
          createdAtPrecision: "day",
        }),
      ]),
      business: BUSINESS,
      queries: ["ai seo"],
      now: FOUND_ON,
    });
    expect(fake.tables.placement_targets).toHaveLength(2);
    for (const row of fake.tables.placement_targets) {
      expect(row).toMatchObject({ posted_at: "2026-10-05T14:30:00.000Z", posted_at_precision: null });
      // Its stored window recomputed from the real date: 60 days for a post.
      expect(row.fresh_until).toBe(new Date(Date.parse("2026-10-05T14:30:00Z") + 60 * DAY).toISOString());
    }
  });

  it("keeps the engine's date where the URL carries none", () => {
    const reddit = xPost({ surface: "reddit", kind: "thread", url: "https://www.reddit.com/r/SEO/comments/1abc/x/", createdAt: "2026-10-01T00:00:00Z", createdAtPrecision: "month" });
    expect(withUrlDate(reddit, FOUND_ON)).toBe(reddit);
  });

  it("rejects a 5 October X post found on 12 November as stale, without a model call", async () => {
    const fake = db();
    await discoverWith({
      supabase: fake as unknown as SupabaseClient,
      provider: webSearch([xPost()]),
      business: BUSINESS,
      queries: ["ai seo"],
      now: FOUND_ON,
    });
    const watched = watchedLlm();
    setLlmProvider(watched.provider);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));

    const dates = await step("dates").run(ctx(fake));
    expect(dates).toMatchObject({ newRows: 0 });
    const rules = await step("rules").run(ctx(fake));
    expect(rules).toMatchObject({ rejected: 1, byRule: { stale: 1 } });
    const row = fake.tables.placement_targets[0];
    expect(row).toMatchObject({ status: "rejected", qualified_by: "rules:stale" });
    expect(row.qualify_reason).toMatch(/past the 2-day window to reply to an X post/);

    const qualify = await step("qualify").run(ctx(fake));
    expect(qualify).toMatchObject({ judged: 0 });
    expect(watched.calls()).toBe(0);
    expect(fake.tables.agent_runs).toHaveLength(0);
  });

  it("dates an undated find through the platform's free API in the dates step, before the rules judge it", async () => {
    const created = new Date(Date.now() - 2 * DAY).toISOString();
    const fake = db([
      {
        id: "hn-old",
        business_id: "biz-1",
        user_id: "user-1",
        surface: "hackernews",
        kind: "thread",
        url: "https://news.ycombinator.com/item?id=111",
        title: "Ask HN: how do you get cited by AI answer engines for ai seo?",
        excerpt: "",
        community: "Hacker News",
        posted_at: null,
        posted_at_precision: null,
        score: null,
        comment_count: null,
        found_for: "ai seo",
        status: "discovered",
        created_at: created,
        last_seen_at: created,
      },
    ]);
    // Posted 90 days ago: past the 60-day window for a question site.
    const posted = Math.floor((Date.now() - 90 * DAY) / 1000);
    const fetchMock = vi.fn(async (url: string) =>
      url.includes("hacker-news.firebaseio.com/v0/item/111.json") ? Response.json({ id: 111, time: posted }) : new Response("{}", { status: 404 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const watched = watchedLlm();
    setLlmProvider(watched.provider);

    const dates = await step("dates").run(ctx(fake));
    expect(dates).toMatchObject({ newRows: 1, dated: { hackernews_api: 1 }, unknown: 0, requests: { hackernews: 1 } });
    expect(fake.tables.placement_targets[0].posted_at).toBe(new Date(posted * 1000).toISOString());

    const rules = await step("rules").run(ctx(fake));
    expect(rules).toMatchObject({ byRule: { stale: 1 } });
    expect(watched.calls()).toBe(0);
  });
});

describe("the backfill", () => {
  const open = (i: number, over: Record<string, unknown> = {}) => ({
    id: `open-${i}`,
    business_id: "biz-1",
    user_id: "user-1",
    surface: "x",
    kind: "post",
    url: `https://x.com/someone/status/${(BigInt(OCT_5_STATUS) + BigInt(i) * (BigInt(DAY) << BigInt(22))).toString()}`,
    title: `Post ${i}`,
    posted_at: null,
    posted_at_precision: null,
    status: "qualified",
    created_at: new Date(Date.parse("2026-10-06T00:00:00Z") + i * DAY).toISOString(),
    ...over,
  });

  it("dates up to its cap of open undated rows per run, oldest find first, and touches nothing else", async () => {
    const rows = [
      open(4),
      open(1),
      open(3, { status: "drafted" }),
      open(2, { status: "approved" }),
      open(0, { status: "published_manually" }),
      open(5, { status: "rejected" }),
      open(6, { posted_at: "2026-10-30T00:00:00Z" }),
      open(7, { business_id: "biz-other" }),
    ];
    const fake = db(rows);
    const lookup = new PostDateLookup({ fetch: vi.fn() as unknown as typeof fetch });
    const out = await dateUndatedTargets({
      supabase: fake as unknown as SupabaseClient,
      businessId: "biz-1",
      lookup,
      now: FOUND_ON,
      backfillLimit: 3,
    });
    expect(out).toMatchObject({ newRows: 0, backfillRows: 3, dated: { x_snowflake: 3 }, unknown: 0 });
    const by = (id: string) => fake.tables.placement_targets.find((t) => t.id === id)!;
    // The three oldest finds among open rows: 1, 2, 3. Row 4 waits for the next run.
    expect(by("open-1").posted_at).toBe("2026-10-06T14:30:00.000Z");
    expect(by("open-2").posted_at).toBe("2026-10-07T14:30:00.000Z");
    expect(by("open-3").posted_at).toBe("2026-10-08T14:30:00.000Z");
    expect(by("open-4").posted_at).toBeNull();
    // Not open, already dated, or another site's: left as they were.
    expect(by("open-0").posted_at).toBeNull();
    expect(by("open-5").posted_at).toBeNull();
    expect(by("open-6").posted_at).toBe("2026-10-30T00:00:00Z");
    expect(by("open-7").posted_at).toBeNull();
    expect(BACKFILL_ROWS_PER_RUN).toBe(150);
  });

  it("replaces a search engine's rough date on an X post with the exact date from its URL", async () => {
    const fake = db([open(1, { posted_at: "2026-11-11T00:00:00.000Z", posted_at_precision: "week" })]);
    const out = await dateUndatedTargets({
      supabase: fake as unknown as SupabaseClient,
      businessId: "biz-1",
      lookup: new PostDateLookup({ fetch: vi.fn() as unknown as typeof fetch }),
      now: FOUND_ON,
    });
    const row = fake.tables.placement_targets[0];
    expect(row.posted_at).toBe("2026-10-06T14:30:00.000Z");
    expect(row.posted_at_precision).toBeNull();
    expect(out.dated).toMatchObject({ x_snowflake_redated: 1 });
  });

  it("moves a backfilled row past its window to Expired through the display rule", async () => {
    const fake = db([open(1)]);
    await dateUndatedTargets({
      supabase: fake as unknown as SupabaseClient,
      businessId: "biz-1",
      lookup: new PostDateLookup({ fetch: vi.fn() as unknown as typeof fetch }),
      now: FOUND_ON,
    });
    const row = fake.tables.placement_targets[0];
    const view: ViewRow = {
      status: row.status as string,
      surface: "x",
      kind: "post",
      postedAt: row.posted_at as string,
      createdAt: row.created_at as string,
      foundVia: "web-search",
      qualifiedBy: "agent",
      freshUntil: row.fresh_until as string,
    };
    expect(inView(view, "expired", FOUND_ON.getTime())).toBe(true);
    expect(row.status).toBe("qualified");
  });

  it("lets new finds take an API's cap before the backfill, and leaves what fails unknown", async () => {
    const hn = (id: string, status: string, created: string) => ({
      id,
      business_id: "biz-1",
      user_id: "user-1",
      surface: "hackernews",
      kind: "thread",
      url: `https://news.ycombinator.com/item?id=${id.replace(/\D/g, "")}`,
      title: id,
      posted_at: null,
      status,
      created_at: created,
    });
    const fake = db([
      hn("old1", "qualified", "2026-09-01T00:00:00Z"),
      hn("new2", "discovered", "2026-11-12T00:00:00Z"),
      hn("new3", "discovered", "2026-11-11T00:00:00Z"),
    ]);
    const urls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return String(input).endsWith("/3.json") ? new Response("nope", { status: 503 }) : Response.json({ time: 1762000000 });
    }) as typeof fetch;
    const out = await dateUndatedTargets({
      supabase: fake as unknown as SupabaseClient,
      businessId: "biz-1",
      lookup: new PostDateLookup({ fetch: fetchImpl, caps: { hackernews: 2 } }),
      now: FOUND_ON,
    });
    // Newest find first, then the next, then the cap: the backfill row waits.
    expect(urls).toEqual(["https://hacker-news.firebaseio.com/v0/item/2.json", "https://hacker-news.firebaseio.com/v0/item/3.json"]);
    expect(out).toMatchObject({ newRows: 2, backfillRows: 1, dated: { hackernews_api: 1 }, unknown: 2, skipped: { hackernews: 1 } });
    const by = (id: string) => fake.tables.placement_targets.find((t) => t.id === id)!;
    expect(by("new2").posted_at).toBe("2025-11-01T12:26:40.000Z");
    expect(by("new3").posted_at).toBeNull();
    expect(by("old1").posted_at).toBeNull();
  });
});

describe("an unknown date is never fresh", () => {
  const NOW = Date.parse("2026-11-12T12:00:00Z");
  const ago = (days: number) => new Date(NOW - days * DAY).toISOString();
  const found = (over: Partial<ViewRow> = {}): ViewRow => ({
    status: "qualified",
    foundVia: "web-search",
    qualifiedBy: "agent",
    freshUntil: null,
    snoozedUntil: null,
    surface: "x",
    kind: "post",
    postedAt: null,
    createdAt: ago(1),
    ...over,
  });

  it("is not aged from when it was found: an undated X post found yesterday stays in To reply", () => {
    // Until 2026-11-13 it counted as a day old; now it counts as unknown.
    expect(inView(found({ createdAt: ago(3) }), "to_reply", NOW)).toBe(true);
    expect(isExpired(found({ createdAt: ago(3) }), NOW)).toBe(false);
  });

  it("leaves To reply for Expired once it was found more than seven days ago, on every surface with an age", () => {
    for (const [surface, kind] of [["x", "post"], ["reddit", "thread"], ["github", "issue"], ["linkedin", "article"], ["quora", "thread"], ["x", "article"]]) {
      const row = found({ surface, kind, createdAt: ago(7.5) });
      expect(undatedTooLong(row, NOW)).toBe(true);
      expect(inView(row, "to_reply", NOW)).toBe(false);
      expect(inView(row, "expired", NOW)).toBe(true);
      expect(inView(found({ surface, kind, createdAt: ago(6.5) }), "to_reply", NOW)).toBe(true);
    }
  });

  it("leaves list articles, repositories, posts the person chose and dated rows to their own rules", () => {
    expect(isExpired(found({ surface: "web", kind: "listicle", createdAt: ago(40) }), NOW)).toBe(false);
    expect(isExpired(found({ surface: "github", kind: "repository", createdAt: ago(40) }), NOW)).toBe(false);
    expect(isExpired(found({ foundVia: "manual", qualifiedBy: "person", createdAt: ago(40) }), NOW)).toBe(false);
    expect(isExpired(found({ surface: "reddit", kind: "thread", postedAt: ago(10), createdAt: ago(40) }), NOW)).toBe(false);
  });

  it("says so on the row: date unknown, when it was found, expired", () => {
    const target = {
      surface: "x",
      kind: "post",
      community: "@someone",
      author: "someone",
      postedAt: null,
      postedAtPrecision: null,
      commentCount: null,
      status: "qualified",
      snoozedUntil: null,
      freshUntil: null,
      foundVia: "web-search",
      qualifiedBy: "agent",
      publishedAt: null,
    } as const;
    expect(rowMeta({ ...target, createdAt: ago(3), foundAt: ago(3) } as Parameters<typeof rowMeta>[0], NOW)).toBe("X · @someone · date unknown · found 3d ago");
    expect(rowMeta({ ...target, createdAt: ago(9), foundAt: ago(9) } as Parameters<typeof rowMeta>[0], NOW)).toMatch(/^X · @someone · date unknown · found .+ · expired$/);
  });

  it("orders undated rows after every dated one, the newest find first", () => {
    const rows = [
      { id: "undated-new", ...found({ createdAt: ago(0.5) }), qualifyScore: 99 },
      { id: "dated-old", ...found({ surface: "github", kind: "issue", postedAt: ago(60) }), qualifyScore: 10 },
      { id: "undated-old", ...found({ createdAt: ago(5) }), qualifyScore: 99 },
      { id: "dated-new", ...found({ postedAt: ago(0.2) }), qualifyScore: 10 },
    ];
    expect(orderInbox(rows).map((r) => r.id)).toEqual(["dated-new", "dated-old", "undated-new", "undated-old"]);
  });
});
