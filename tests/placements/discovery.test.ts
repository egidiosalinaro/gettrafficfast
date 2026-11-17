import { describe, expect, it } from "vitest";
import {
  parseRedditListing,
  withinAge,
  type RedditListing,
} from "@/lib/providers/discovery/reddit";
import { buildQueries, prefilter } from "@/lib/placements/discovery";
import type { Discussion } from "@/lib/providers/discovery/types";

/**
 * Discovery is the cheap step that decides what the expensive steps will cost.
 * Everything here is about what it refuses to pass on: threads that would put
 * a customer's brand somewhere they do not want it, threads nobody reads, and
 * queries too broad to ever win.
 */

/** The fields of a single thread, derived from the listing contract itself. */
type ThreadData = NonNullable<
  NonNullable<NonNullable<RedditListing["data"]>["children"]>[number]["data"]
>;

const thread = (over: Partial<ThreadData> = {}) => ({
  data: {
    children: [
      {
        data: {
          id: "abc",
          title: "How do you season a cast iron pan properly?",
          selftext: "I keep ruining mine.",
          permalink: "/r/cooking/comments/abc/how_do_you/",
          subreddit: "cooking",
          created_utc: 1_787_000_000,
          score: 42,
          num_comments: 17,
          ...over,
        },
      },
    ],
  },
});

describe("parseRedditListing", () => {
  it("maps a thread onto the platform shape", () => {
    const [discussion] = parseRedditListing(thread());
    expect(discussion).toMatchObject({
      externalId: "abc",
      surface: "reddit",
      url: "https://www.reddit.com/r/cooking/comments/abc/how_do_you/",
      community: "r/cooking",
      score: 42,
      commentCount: 17,
    });
    expect(discussion.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("drops NSFW threads whatever their relevance", () => {
    // No amount of topical fit makes up for putting a customer's brand there.
    expect(parseRedditListing(thread({ over_18: true }))).toEqual([]);
  });

  it("drops rows with no id, title or link", () => {
    expect(parseRedditListing(thread({ id: undefined }))).toEqual([]);
    expect(parseRedditListing(thread({ title: undefined }))).toEqual([]);
    expect(parseRedditListing(thread({ permalink: undefined, url: undefined }))).toEqual([]);
  });

  it("truncates the excerpt instead of storing an essay", () => {
    const [discussion] = parseRedditListing(thread({ selftext: "x".repeat(5000) }));
    expect(discussion.excerpt.length).toBeLessThanOrEqual(600);
  });

  it("survives an empty listing", () => {
    expect(parseRedditListing({})).toEqual([]);
  });
});

describe("withinAge", () => {
  const now = new Date("2026-08-28T00:00:00Z");
  const at = (iso: string | null): Discussion => ({
    externalId: iso ?? "unknown", surface: "reddit", kind: "thread", url: "u", title: "t", excerpt: "",
    community: "r/x", author: null, createdAt: iso, score: 1, commentCount: 1,
  });

  it("drops threads older than the window", () => {
    const kept = withinAge([at("2026-08-01T00:00:00Z"), at("2024-01-01T00:00:00Z")], 90, now);
    expect(kept).toHaveLength(1);
    expect(kept[0].createdAt).toBe("2026-08-01T00:00:00Z");
  });

  it("keeps everything when no window is given", () => {
    expect(withinAge([at("2019-01-01T00:00:00Z")], undefined, now)).toHaveLength(1);
  });

  it("keeps a thread whose date the provider does not know", () => {
    // Unknown is not "ancient": the rules step flags it instead of guessing.
    expect(withinAge([at(null)], 90, now)).toHaveLength(1);
  });
});

describe("prefilter", () => {
  const d = (over: Partial<Discussion>): Discussion => ({
    externalId: "1", surface: "reddit", kind: "thread", url: "u",
    title: "How do I stop my sourdough collapsing?", excerpt: "",
    community: "r/x", author: null, createdAt: "2026-08-01T00:00:00Z", score: 5, commentCount: 3,
    ...over,
  });

  it("drops threads nobody engaged with", () => {
    // Qualification costs a model call per target: a dead thread must not
    // reach it.
    expect(prefilter([d({ commentCount: 0 })])).toEqual([]);
  });

  it("drops bare-link titles", () => {
    expect(prefilter([d({ title: "check this" })])).toEqual([]);
  });

  it("keeps a real question with replies", () => {
    expect(prefilter([d({})])).toHaveLength(1);
  });

  it("keeps a thread whose engagement is unknown, and any repository", () => {
    // A web search result has no comment count. "Unknown" must not read as 0.
    expect(prefilter([d({ commentCount: null, score: null })])).toHaveLength(1);
    expect(prefilter([d({ kind: "repository", commentCount: null, title: "awesome-email-tools" })])).toHaveLength(1);
  });
});

describe("buildQueries", () => {
  it("puts the customer's keywords before the broad niche", () => {
    // Specific queries find threads we can win; the category finds threads
    // where incumbents already are.
    const queries = buildQueries({
      keywords: ["cast iron seasoning"],
      entities: ["Lodge skillet"],
      niche: "cookware",
    });
    expect(queries).toEqual(["cast iron seasoning", "Lodge skillet", "cookware"]);
  });

  it("does not repeat the same query in different clothes", () => {
    const queries = buildQueries({
      keywords: ["  Cast Iron  "],
      entities: ["cast iron"],
      niche: null,
    });
    expect(queries).toEqual(["Cast Iron"]);
  });

  it("drops fragments too short to search for", () => {
    expect(buildQueries({ keywords: ["a", "ok"], entities: [], niche: null })).toEqual([]);
  });

  it("stops at the limit", () => {
    const queries = buildQueries(
      { keywords: Array.from({ length: 30 }, (_, i) => `keyword number ${i}`), entities: [], niche: null },
      5
    );
    expect(queries).toHaveLength(5);
  });

  it("returns nothing when the business told us nothing", () => {
    // The sweep must skip rather than search the empty string.
    expect(buildQueries({ keywords: [], entities: [], niche: null })).toEqual([]);
  });
});
