import { describe, expect, it, vi } from "vitest";
import { XApiClient, parseXPosts } from "@/lib/providers/x/api";

/**
 * `searchReplies`, the search GTF uses to find the person's own reply in a
 * thread (lib/placements/reply-link.ts): recent search with the fields that
 * say where a post sits in its thread, the window's end only when X can take
 * it, billed per post like any search. And the parse: the thread fields are
 * read when X sends them and left unknown when the call did not ask.
 */

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("searchReplies", () => {
  it("asks for the thread fields and the author, in the window, and bills each post returned", async () => {
    const fetchImpl = vi.fn(async () =>
      json({
        data: [
          {
            id: "1855000000000000101",
            text: "@janedoe answer first, then the detail",
            author_id: "u1",
            created_at: "2026-11-13T10:01:00.000Z",
            conversation_id: "1855000000000000000",
            referenced_tweets: [{ type: "replied_to", id: "1855000000000000000" }],
          },
        ],
        includes: { users: [{ id: "u1", username: "Owner" }] },
        meta: { result_count: 1 },
      })
    ) as unknown as typeof fetch;
    const log = vi.fn();
    const api = new XApiClient({ token: "t", fetchImpl, log });
    const result = await api.searchReplies({
      query: "(conversation_id:1855000000000000000 OR in_reply_to_tweet_id:1855000000000000000) from:owner",
      maxResults: 10,
      startTime: new Date("2026-11-13T09:00:00.123Z"),
      endTime: new Date("2026-11-13T16:00:00.000Z"),
    });

    const url = new URL((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string);
    expect(url.pathname).toBe("/2/tweets/search/recent");
    expect(url.searchParams.get("query")).toContain("from:owner");
    expect(url.searchParams.get("max_results")).toBe("10");
    expect(url.searchParams.get("start_time")).toBe("2026-11-13T09:00:00Z");
    expect(url.searchParams.get("end_time")).toBe("2026-11-13T16:00:00Z");
    expect(url.searchParams.get("tweet.fields")).toContain("conversation_id");
    expect(url.searchParams.get("tweet.fields")).toContain("referenced_tweets");
    expect(url.searchParams.get("expansions")).toBe("author_id");

    expect(result.posts[0]).toMatchObject({
      id: "1855000000000000101",
      handle: "Owner",
      conversationId: "1855000000000000000",
      repliedToId: "1855000000000000000",
    });
    expect(result).toMatchObject({ billedPosts: 1, costUsd: 0.005 });
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ endpoint: "search_replies", posts: 1, est_cost_usd: 0.005 }));
  });

  it("leaves the end out while it is still ahead, and an empty answer costs nothing", async () => {
    const fetchImpl = vi.fn(async () => json({ meta: { result_count: 0 } })) as unknown as typeof fetch;
    const api = new XApiClient({ token: "t", fetchImpl, log: vi.fn() });
    const result = await api.searchReplies({ query: "from:owner", maxResults: 10, startTime: new Date("2026-11-13T09:00:00Z"), endTime: null });
    const url = new URL((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string);
    expect(url.searchParams.has("end_time")).toBe(false);
    expect(result).toMatchObject({ posts: [], billedPosts: 0, costUsd: 0 });
  });
});

describe("the thread fields", () => {
  it("are unknown (absent) on a call that did not ask, and null for a post that answers nothing", () => {
    const plain = parseXPosts({ data: [{ id: "1", text: "a post" }] }).posts[0];
    expect("conversationId" in plain).toBe(false);
    expect("repliedToId" in plain).toBe(false);

    const root = parseXPosts({ data: [{ id: "2", text: "a post", conversation_id: "2" }] }).posts[0];
    expect(root).toMatchObject({ conversationId: "2", repliedToId: null });

    const quote = parseXPosts({
      data: [{ id: "3", text: "a quote", conversation_id: "3", referenced_tweets: [{ type: "quoted", id: "9" }] }],
    }).posts[0];
    expect(quote.repliedToId).toBeNull();
  });
});
