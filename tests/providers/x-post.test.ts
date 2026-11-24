import { describe, expect, it, vi } from "vitest";
import { XApiError } from "@/lib/providers/x/api";
import { X_POST_USD_PER_POST, classifyXPostFailure, createXPost, xPostUrl } from "@/lib/providers/x/post";

/**
 * The posting primitive: one POST /2/tweets as the connected account, and
 * what X's refusals mean. The 403 X gives a reply to someone who did not
 * mention or quote the account is `reply_not_allowed`, so the caller can
 * open X's composer instead.
 */

const REPLY_403 = JSON.stringify({
  title: "Forbidden",
  status: 403,
  detail: "Reply to this conversation is not allowed because you have not been mentioned or otherwise engaged by the author of the post you are replying to.",
});

describe("createXPost", () => {
  it("posts a reply with in_reply_to_tweet_id and bills one post", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: { id: "1860000000000000001", text: "Same here." } }), { status: 201 }));
    const result = await createXPost({ accessToken: "at", text: "Same here.", inReplyToId: "1850000000000000000", fetchImpl });
    expect(result).toEqual({ ok: true, id: "1860000000000000001", text: "Same here.", billedPosts: 1, costUsd: X_POST_USD_PER_POST });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.x.com/2/tweets");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ text: "Same here.", reply: { in_reply_to_tweet_id: "1850000000000000000" } });
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer at");
  });

  it("posts a post of the account's own with no reply field", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: { id: "1860000000000000002", text: "Shipped." } }), { status: 201 }));
    await createXPost({ accessToken: "at", text: "Shipped.", fetchImpl });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ text: "Shipped." });
  });

  it("answers a refused reply as reply_not_allowed, billed nothing", async () => {
    const fetchImpl = vi.fn(async () => new Response(REPLY_403, { status: 403 }));
    expect(await createXPost({ accessToken: "at", text: "Hi", inReplyToId: "1850000000000000000", fetchImpl })).toMatchObject({
      ok: false,
      kind: "reply_not_allowed",
      billedPosts: 0,
      costUsd: 0,
    });
  });

  it("refuses an id that is not a post without calling X", async () => {
    const fetchImpl = vi.fn();
    expect(await createXPost({ accessToken: "at", text: "Hi", inReplyToId: "not-an-id", fetchImpl })).toMatchObject({ ok: false, kind: "other" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("bills a post X may have made when it did not answer", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("timeout");
    });
    expect(await createXPost({ accessToken: "at", text: "Hi", fetchImpl: fetchImpl as never })).toMatchObject({ ok: false, kind: "other", billedPosts: 1 });
  });
});

describe("classifyXPostFailure", () => {
  it("maps X's answers to the kinds the caller acts on", () => {
    expect(classifyXPostFailure(401, "Unauthorized", null, false).kind).toBe("auth_expired");
    expect(classifyXPostFailure(429, "Too Many Requests", "1795000000", true)).toMatchObject({ kind: "rate_limited", resetAt: expect.any(String) });
    expect(classifyXPostFailure(403, REPLY_403, null, true).kind).toBe("reply_not_allowed");
    // The same words on a post that is not a reply are not a reply refusal.
    expect(classifyXPostFailure(403, REPLY_403, null, false).kind).toBe("other");
    expect(classifyXPostFailure(403, '{"detail":"You are not allowed to create a Tweet with duplicate content."}', null, false).kind).toBe("other");
  });

  it("throws billing as an XApiError, so the cap pauses every X call", () => {
    expect(() => classifyXPostFailure(402, "Payment Required", null, true)).toThrow(XApiError);
    try {
      classifyXPostFailure(403, '{"title":"CreditsDepleted"}', null, false);
    } catch (err) {
      expect((err as XApiError).kind).toBe("billing");
    }
  });

  it("links a post as x.com/<username>/status/<id>", () => {
    expect(xPostUrl("samrivdev", "1860000000000000001")).toBe("https://x.com/samrivdev/status/1860000000000000001");
  });
});
