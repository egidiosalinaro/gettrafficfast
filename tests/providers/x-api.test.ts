import { describe, expect, it, vi } from "vitest";
import {
  X_LOOKUP_USD_PER_POST,
  X_SEARCH_USD_PER_POST,
  X_USER_LOOKUP_USD_PER_USER,
  XApiClient,
  XApiError,
  classifyXFailure,
  isXApiEnabled,
  lookupWorstCaseUsd,
  searchWorstCaseUsd,
  userLookupWorstCaseUsd,
  xApiClientFromEnv,
  xMonthlyCapUsd,
} from "@/lib/providers/x/api";

/**
 * The X API client: opt-in twice (the flag AND the token), read-only, every
 * failure classified the way the cap and the pause act on it, one log line
 * per call with the posts returned and the estimated cost. X itself is
 * never reached: every call goes through a fake fetch.
 */

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });

function client(fetchImpl: typeof fetch, log = vi.fn()) {
  return { api: new XApiClient({ token: "test-token", fetchImpl, log }), log };
}

describe("opt-in", () => {
  it("is off with the token alone, off with the flag alone, on with both", () => {
    expect(isXApiEnabled({ X_API_BEARER_TOKEN: "t" })).toBe(false);
    expect(isXApiEnabled({ X_API_ENABLED: "1" })).toBe(false);
    expect(isXApiEnabled({ X_API_ENABLED: "0", X_API_BEARER_TOKEN: "t" })).toBe(false);
    expect(isXApiEnabled({ X_API_ENABLED: "1", X_API_BEARER_TOKEN: "t" })).toBe(true);
    expect(isXApiEnabled({ X_API_ENABLED: "true", X_API_BEARER_TOKEN: "t" })).toBe(true);
  });

  it("builds no client when the platform has not opted in, whatever key is there", () => {
    expect(xApiClientFromEnv({ X_API_BEARER_TOKEN: "t" })).toBeNull();
    expect(xApiClientFromEnv({ X_API_ENABLED: "1", X_API_BEARER_TOKEN: "t" })).toBeInstanceOf(XApiClient);
  });

  it("reads the monthly cap, $20 by default, and never lifts it on a typo", () => {
    expect(xMonthlyCapUsd({})).toBe(20);
    expect(xMonthlyCapUsd({ X_API_MONTHLY_CAP_USD: "35" })).toBe(35);
    expect(xMonthlyCapUsd({ X_API_MONTHLY_CAP_USD: "lots" })).toBe(20);
    expect(xMonthlyCapUsd({ X_API_MONTHLY_CAP_USD: "-5" })).toBe(20);
    expect(xMonthlyCapUsd({ X_API_MONTHLY_CAP_USD: "0" })).toBe(0);
  });

  it("prices the worst case from one unit price per endpoint", () => {
    expect(X_SEARCH_USD_PER_POST).toBe(0.005);
    expect(X_LOOKUP_USD_PER_POST).toBe(0.005);
    expect(searchWorstCaseUsd(20)).toBe(0.1);
    // X's floor is 10 results: asking for fewer is billed as 10 at worst.
    expect(searchWorstCaseUsd(3)).toBe(0.05);
    expect(lookupWorstCaseUsd(100)).toBe(0.5);
    expect(lookupWorstCaseUsd(250)).toBe(0.5);
  });
});

describe("classified failures", () => {
  it("401 and 403 are configuration, 429 carries its reset, 402 and depleted credits are billing", () => {
    expect(classifyXFailure(401, "Unauthorized", null).kind).toBe("configuration");
    expect(classifyXFailure(403, "client-not-enrolled", null).kind).toBe("configuration");
    const limited = classifyXFailure(429, "Too Many Requests", "1794400000");
    expect(limited.kind).toBe("rate_limit");
    expect(limited.resetAt).toBe(new Date(1794400000 * 1000).toISOString());
    expect(classifyXFailure(402, "Payment Required", null).kind).toBe("billing");
    expect(classifyXFailure(403, '{"title":"CreditsDepleted","detail":"Your credits are depleted"}', null).kind).toBe("billing");
    expect(classifyXFailure(500, "oops", null).kind).toBe("http");
  });

  it("a call that never answers is a timeout, and is logged with no cost", async () => {
    const never: typeof fetch = (_url, init) =>
      new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
    const log = vi.fn();
    const api = new XApiClient({ token: "t", fetchImpl: never, timeoutMs: 5, log });
    await expect(api.lookup(["1"])).rejects.toMatchObject({ kind: "timeout" });
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ outcome: "timeout", posts: 0, est_cost_usd: 0 }));
  });

  it("a 429 from X is thrown as a rate limit with the reset time", async () => {
    const fetchImpl = vi.fn(async () => new Response("Too Many Requests", { status: 429, headers: { "x-rate-limit-reset": "1794400000" } }));
    const { api } = client(fetchImpl as unknown as typeof fetch);
    const err = await api.searchRecent({ query: "aeo", maxResults: 10, startTime: new Date() }).catch((e) => e);
    expect(err).toBeInstanceOf(XApiError);
    expect(err.kind).toBe("rate_limit");
    expect(err.resetAt).toBe(new Date(1794400000 * 1000).toISOString());
  });
});

describe("recent search", () => {
  it("asks for the last hours with the Bearer token, reads posts and authors, and logs one line with the cost", async () => {
    const fetchImpl = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>(async () =>
      json({
        data: [
          {
            id: "1855000000000000001",
            text: "How do you get cited by ChatGPT?",
            author_id: "u1",
            created_at: "2026-11-11T08:00:00.000Z",
            public_metrics: { reply_count: 3, like_count: 10, retweet_count: 1, quote_count: 0, impression_count: 900 },
          },
          { id: "1855000000000000002", text: "short", note_tweet: { text: "A long post, whole." } },
        ],
        includes: { users: [{ id: "u1", username: "janedoe", name: "Jane" }] },
        meta: { result_count: 2 },
      })
    );
    const { api, log } = client(fetchImpl as unknown as typeof fetch);
    const result = await api.searchRecent({ query: '"ai seo" lang:en -is:retweet', maxResults: 20, startTime: new Date("2026-11-11T01:00:00.000Z") });

    const [url, init] = fetchImpl.mock.calls[0];
    const parsed = new URL(String(url));
    expect(parsed.origin + parsed.pathname).toBe("https://api.x.com/2/tweets/search/recent");
    expect(parsed.searchParams.get("max_results")).toBe("20");
    expect(parsed.searchParams.get("start_time")).toBe("2026-11-11T01:00:00Z");
    expect(parsed.searchParams.get("expansions")).toBe("author_id,attachments.media_keys,referenced_tweets.id,referenced_tweets.id.author_id,referenced_tweets.id.attachments.media_keys");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
    expect(init?.method ?? "GET").toBe("GET");

    expect(result.billedPosts).toBe(2);
    expect(result.costUsd).toBe(0.01);
    expect(result.posts[0]).toMatchObject({ handle: "janedoe", metrics: { replies: 3, likes: 10, impressions: 900, bookmarks: null } });
    expect(result.posts[1]).toMatchObject({ text: "A long post, whole.", handle: null, metrics: { replies: null, likes: null } });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ endpoint: "search_recent", outcome: "ok", posts: 2, est_cost_usd: 0.01 }));
  });

  it("refuses a query over X's 512 characters before calling", async () => {
    const fetchImpl = vi.fn();
    const { api } = client(fetchImpl as unknown as typeof fetch);
    await expect(api.searchRecent({ query: "a".repeat(513), maxResults: 10, startTime: new Date() })).rejects.toMatchObject({ kind: "invalid" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("lookup by ids", () => {
  it("batches the ids in one call and lists what X did not return", async () => {
    const fetchImpl = vi.fn(async () =>
      json({
        data: [{ id: "11", text: "my reply", public_metrics: { impression_count: 1200, like_count: 8, reply_count: 2 } }],
        errors: [{ resource_id: "12", title: "Not Found Error" }],
      })
    );
    const { api } = client(fetchImpl as unknown as typeof fetch);
    const result = await api.lookup(["11", "12", "13", "11", "not-an-id"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(new URL(String((fetchImpl.mock.calls[0] as unknown[])[0])).searchParams.get("ids")).toBe("11,12,13");
    expect(result.missingIds.sort()).toEqual(["12", "13"]);
    expect(result.costUsd).toBe(0.005);
    expect(result.posts[0].metrics).toEqual({ impressions: 1200, likes: 8, replies: 2, reposts: null, quotes: null, bookmarks: null });
  });

  it("asks nothing for no ids, and refuses more than 100", async () => {
    const fetchImpl = vi.fn();
    const { api } = client(fetchImpl as unknown as typeof fetch);
    expect(await api.lookup([])).toMatchObject({ posts: [], costUsd: 0 });
    await expect(api.lookup(Array.from({ length: 101 }, (_, i) => String(i + 1)))).rejects.toMatchObject({ kind: "invalid" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("user lookup by username", () => {
  it("asks for one account's public numbers, billed $0.01 for the user returned", async () => {
    expect(X_USER_LOOKUP_USD_PER_USER).toBe(0.01);
    expect(userLookupWorstCaseUsd()).toBe(0.01);
    const fetchImpl = vi.fn(async () =>
      json({
        data: {
          id: "1500000000000000000",
          username: "SamRivDev",
          name: "Samriv",
          public_metrics: { followers_count: 2310, following_count: 310, tweet_count: 5120, listed_count: 7, like_count: 900 },
        },
      })
    );
    const { api, log } = client(fetchImpl as unknown as typeof fetch);
    const result = await api.userByUsername("@samrivdev");

    const [url, init] = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit]);
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://api.x.com/2/users/by/username/samrivdev");
    expect(parsed.searchParams.get("user.fields")).toBe("public_metrics");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
    expect(result).toEqual({
      account: { id: "1500000000000000000", handle: "SamRivDev", metrics: { followers: 2310, following: 310, posts: 5120, listed: 7 } },
      billedPosts: 1,
      costUsd: 0.01,
    });
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ endpoint: "user_by_username", outcome: "ok", users: 1, est_cost_usd: 0.01 }));
  });

  it("answers no account, billed nothing, when X knows no such handle, and nulls for numbers X did not send", async () => {
    const notFound = vi.fn(async () =>
      json({ errors: [{ value: "gone", detail: "Could not find user with username: [gone].", title: "Not Found Error" }] })
    );
    const { api } = client(notFound as unknown as typeof fetch);
    expect(await api.userByUsername("gone")).toEqual({ account: null, billedPosts: 0, costUsd: 0 });

    const partial = vi.fn(async () => json({ data: { id: "1", username: "quiet", public_metrics: { followers_count: 0 } } }));
    const { api: other } = client(partial as unknown as typeof fetch);
    expect((await other.userByUsername("quiet")).account?.metrics).toEqual({ followers: 0, following: null, posts: null, listed: null });
  });

  it("refuses what is not a handle before calling, and classifies X's refusals as every call does", async () => {
    const fetchImpl = vi.fn();
    const { api } = client(fetchImpl as unknown as typeof fetch);
    await expect(api.userByUsername("not a handle")).rejects.toMatchObject({ kind: "invalid" });
    await expect(api.userByUsername("a".repeat(16))).rejects.toMatchObject({ kind: "invalid" });
    expect(fetchImpl).not.toHaveBeenCalled();

    const limited = vi.fn(async () => new Response("Too Many Requests", { status: 429, headers: { "x-rate-limit-reset": "1794400000" } }));
    const { api: busy } = client(limited as unknown as typeof fetch);
    await expect(busy.userByUsername("samriv")).rejects.toMatchObject({ kind: "rate_limit" });
    const odd = vi.fn(async () => json({ data: { username: "no-id" } }));
    const { api: strange } = client(odd as unknown as typeof fetch);
    await expect(strange.userByUsername("samriv")).rejects.toMatchObject({ kind: "invalid" });
  });
});
