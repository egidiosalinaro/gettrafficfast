import { describe, expect, it } from "vitest";
import {
  POST_DATE_CAPS,
  PostDateLookup,
  parseDevToArticle,
  parseGitHubIssue,
  parseHackerNewsItem,
  parseRedditPost,
  parseStackExchangeQuestions,
  postDateKey,
  type PostDateRequest,
} from "@/lib/providers/post-dates";

/**
 * The keyless APIs that say when a post was made (2026-11-13). Payloads are
 * shaped as each platform documents them; every failure leaves the date
 * unknown, never "now".
 */

const NOW = new Date("2026-11-12T12:00:00Z");
const now = () => NOW;

describe("parsers", () => {
  it("Hacker News: `time` in Unix seconds, a deleted item included", () => {
    expect(parseHackerNewsItem({ by: "pg", id: 1, time: 1160418111, type: "story" }, NOW)).toBe("2006-10-09T18:21:51.000Z");
    expect(parseHackerNewsItem({ deleted: true, id: 2, time: 1760000000, type: "comment" }, NOW)).toBe("2025-10-09T08:53:20.000Z");
    expect(parseHackerNewsItem(null, NOW)).toBeNull();
    expect(parseHackerNewsItem({ id: 3 }, NOW)).toBeNull();
    expect(parseHackerNewsItem({ time: "1760000000" }, NOW)).toBeNull();
  });

  it("Stack Exchange: question id to `creation_date`; a missing question is absent", () => {
    const dates = parseStackExchangeQuestions(
      {
        items: [
          { question_id: 11227809, creation_date: 1340805096, title: "Why is processing a sorted array faster" },
          { question_id: 4567, creation_date: "soon" },
        ],
        has_more: false,
        quota_max: 300,
        quota_remaining: 298,
      },
      NOW
    );
    expect([...dates.entries()]).toEqual([["11227809", "2012-06-27T13:51:36.000Z"]]);
    expect(parseStackExchangeQuestions({ error_id: 502, error_name: "throttle_violation" }, NOW).size).toBe(0);
  });

  it("DEV: `published_at`; an unpublished article has none", () => {
    expect(parseDevToArticle({ type_of: "article", id: 1, published_at: "2026-10-20T08:15:00Z" }, NOW)).toBe("2026-10-20T08:15:00.000Z");
    expect(parseDevToArticle({ type_of: "article", id: 1, published_at: null }, NOW)).toBeNull();
    expect(parseDevToArticle({ error: "not found", status: 404 }, NOW)).toBeNull();
  });

  it("Reddit: the t3 child's `created_utc`, from the comments page's first listing", () => {
    const page = [
      { kind: "Listing", data: { children: [{ kind: "t3", data: { id: "1gq4b1z", created_utc: 1731500000.0 } }] } },
      { kind: "Listing", data: { children: [{ kind: "t1", data: { id: "c1", created_utc: 1731600000 } }] } },
    ];
    expect(parseRedditPost(page, "1GQ4B1Z", NOW)).toBe("2024-11-13T12:13:20.000Z");
    expect(parseRedditPost(page, "other", NOW)).toBeNull();
    expect(parseRedditPost({ message: "Forbidden", error: 403 }, "1gq4b1z", NOW)).toBeNull();
  });

  it("GitHub: the issue's `created_at`", () => {
    expect(parseGitHubIssue({ number: 12, created_at: "2026-09-01T10:00:00Z" }, NOW)).toBe("2026-09-01T10:00:00.000Z");
    expect(parseGitHubIssue({ message: "Not Found" }, NOW)).toBeNull();
  });

  it("refuses an instant before 2005 or more than a day ahead", () => {
    expect(parseHackerNewsItem({ time: 0 }, NOW)).toBeNull();
    expect(parseHackerNewsItem({ time: NOW.getTime() / 1000 + 2 * 86_400 }, NOW)).toBeNull();
    expect(parseDevToArticle({ published_at: "1999-01-01T00:00:00Z" }, NOW)).toBeNull();
  });
});

type Responder = (url: string, init?: RequestInit) => Promise<Response> | Response;

function fakeFetch(respond: Responder) {
  const urls: string[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    return respond(url, init);
  }) as typeof fetch;
  return { impl, urls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("PostDateLookup", () => {
  it("dates each source with one request per post, Stack Exchange batched per site", async () => {
    const { impl, urls } = fakeFetch((url) => {
      if (url.includes("hacker-news")) return json({ id: 1, time: 1760000000 });
      if (url.includes("api.stackexchange.com")) {
        return json({ items: [{ question_id: 11, creation_date: 1760000000 }, { question_id: 12, creation_date: 1760086400 }] });
      }
      if (url.includes("dev.to")) return json({ published_at: "2026-10-20T08:15:00Z" });
      if (url.includes("reddit.com")) return json([{ kind: "Listing", data: { children: [{ kind: "t3", data: { id: "abc", created_utc: 1762000000 } }] } }]);
      if (url.includes("api.github.com")) return json({ created_at: "2026-09-01T10:00:00Z" });
      return json({}, 404);
    });
    const lookup = new PostDateLookup({ fetch: impl, now });
    const requests: PostDateRequest[] = [
      { source: "hackernews", id: "1" },
      { source: "stackexchange", site: "stackoverflow.com", id: "11" },
      { source: "stackexchange", site: "stackoverflow.com", id: "12" },
      { source: "devto", user: "maya", slug: "post-1a" },
      { source: "reddit", id: "abc" },
      { source: "github", repo: "acme/tool", number: "12" },
    ];
    const dates = await lookup.dateAll(requests);
    expect(dates.size).toBe(6);
    expect(dates.get(postDateKey(requests[2]))).toBe("2025-10-10T08:53:20.000Z");
    expect(urls.filter((u) => u.includes("stackexchange"))).toEqual([
      "https://api.stackexchange.com/2.3/questions/11;12?site=stackoverflow.com&pagesize=100",
    ]);
    expect(urls).toContain("https://hacker-news.firebaseio.com/v0/item/1.json");
    expect(urls).toContain("https://dev.to/api/articles/maya/post-1a");
    expect(urls).toContain("https://www.reddit.com/comments/abc.json?limit=1&raw_json=1");
    expect(urls).toContain("https://api.github.com/repos/acme/tool/issues/12");
    expect(lookup.stats.requests).toMatchObject({ hackernews: 1, stackexchange: 1, devto: 1, reddit: 1, github: 1 });
  });

  it("leaves the date unknown on a timeout, an HTTP error or a payload without the field", async () => {
    const { impl } = fakeFetch((url, init) => {
      if (url.endsWith("/1.json")) {
        // Never answers: only the timeout ends it.
        return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
      }
      if (url.endsWith("/2.json")) return json({}, 500);
      if (url.endsWith("/3.json")) return json(null);
      return json({ time: 1760000000 });
    });
    const lookup = new PostDateLookup({ fetch: impl, now, timeoutMs: 20 });
    const dates = await lookup.dateAll(["1", "2", "3", "4"].map((id) => ({ source: "hackernews" as const, id })));
    expect([...dates.keys()]).toEqual(["hackernews:4"]);
    expect(lookup.stats.failed.hackernews).toBe(3);
  });

  it("never throws on a network failure", async () => {
    const { impl } = fakeFetch(() => {
      throw new TypeError("fetch failed");
    });
    const lookup = new PostDateLookup({ fetch: impl, now });
    await expect(lookup.dateAll([{ source: "devto", user: "a", slug: "b" }])).resolves.toEqual(new Map());
  });

  it("stops a source for the run at its first refusal, and the others carry on", async () => {
    const { impl, urls } = fakeFetch((url) => (url.includes("reddit") ? json({ message: "Too Many Requests" }, 429) : json({ time: 1760000000 })));
    const lookup = new PostDateLookup({ fetch: impl, now });
    // One at a time through the pool's four workers: the first refusal
    // stops the Reddit requests not yet sent.
    const reddit = Array.from({ length: 8 }, (_, i) => ({ source: "reddit" as const, id: `r${i}` }));
    const dates = await lookup.dateAll([...reddit, { source: "hackernews", id: "9" }]);
    expect(dates.get("hackernews:9")).toBeDefined();
    expect(urls.filter((u) => u.includes("reddit")).length).toBeLessThanOrEqual(4);
    expect(lookup.stats.skipped.reddit).toBeGreaterThanOrEqual(4);
  });

  it("asks no source more than its cap per run, and a post once", async () => {
    const { impl, urls } = fakeFetch(() => json({ time: 1760000000 }));
    const lookup = new PostDateLookup({ fetch: impl, now, caps: { hackernews: 3 } });
    const asked = Array.from({ length: 6 }, (_, i) => ({ source: "hackernews" as const, id: String(i) }));
    const first = await lookup.dateAll([...asked, asked[0]]);
    expect(urls).toHaveLength(3);
    expect([...first.keys()]).toEqual(["hackernews:0", "hackernews:1", "hackernews:2"]);
    expect(lookup.stats.skipped.hackernews).toBe(3);
    // Asked again in the same run: the cache answers, nothing is sent.
    const again = await lookup.dateAll([asked[1]]);
    expect(again.get("hackernews:1")).toBe("2025-10-09T08:53:20.000Z");
    expect(urls).toHaveLength(3);
  });

  it("keeps Stack Exchange far below its 300 requests a day", () => {
    // 25 sites on a cron day, every one using its whole cap.
    expect(POST_DATE_CAPS.stackexchange * 25).toBeLessThanOrEqual(100);
  });

  it("starts nothing after its deadline", async () => {
    const { impl, urls } = fakeFetch(() => json({ time: 1760000000 }));
    const lookup = new PostDateLookup({ fetch: impl, now, deadline: Date.now() - 1 });
    const dates = await lookup.dateAll([{ source: "hackernews", id: "1" }]);
    expect(dates.size).toBe(0);
    expect(urls).toHaveLength(0);
    expect(lookup.stats.skipped.hackernews).toBe(1);
  });

  it("sends the GitHub token when the deployment has one", async () => {
    let auth: string | null = null;
    const { impl } = fakeFetch((_, init) => {
      auth = new Headers(init?.headers).get("authorization");
      return json({ created_at: "2026-09-01T10:00:00Z" });
    });
    await new PostDateLookup({ fetch: impl, now, githubToken: "t0k" }).dateAll([{ source: "github", repo: "a/b", number: "1" }]);
    expect(auth).toBe("Bearer t0k");
  });
});
