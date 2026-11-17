import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { XPost } from "@/lib/providers/x/oembed";
import { capturePublishedText, ensurePublishedText, replyWords } from "@/lib/placements/published-text";
import { mapTarget } from "@/lib/placements/read";
import { FakeSupabase } from "../support/fake-supabase";

/**
 * The text of a reply as published, read back from X. What is pinned: an X
 * status link is read through oEmbed and its words stored with the moment;
 * any other link is skipped without a call; a post X will not hand over, a
 * link changed meanwhile, the answered account's own post or a failing write
 * leave the row exactly as it was and never throw; and `ensurePublishedText`
 * reads at most `max` rows, newest first, and only the ones still missing.
 */

const NOW = new Date("2026-11-09T10:00:00.000Z");
const REPLY_URL = "https://x.com/owner/status/1855000000000000001";

const reply = (text: string, handle = "owner"): XPost => ({ text, authorName: "Owner", handle, postedOn: null });

function target(overrides: Record<string, unknown> = {}) {
  return {
    id: "t-1",
    status: "published_manually",
    author: "janedoe",
    published_url: REPLY_URL,
    published_text: null,
    published_text_at: null,
    ...overrides,
  };
}

function fakeAdmin(rows: Record<string, unknown>[]) {
  const db = new FakeSupabase({ placement_targets: rows });
  return { db, admin: db as unknown as SupabaseClient };
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

describe("capturePublishedText", () => {
  it("reads an X reply and stores its words, without the @handles X puts in front", async () => {
    const { db, admin } = fakeAdmin([target()]);
    const readPost = vi.fn(async () => reply("@janedoe Same here: I edit on X before posting.\n\nWorth it."));

    const result = await capturePublishedText(admin, "t-1", REPLY_URL, { readPost, now: NOW });

    expect(result).toEqual({
      ok: true,
      text: "Same here: I edit on X before posting.\n\nWorth it.",
      at: NOW.toISOString(),
    });
    expect(readPost).toHaveBeenCalledWith(REPLY_URL);
    expect(db.tables.placement_targets[0]).toMatchObject({
      published_text: "Same here: I edit on X before posting.\n\nWorth it.",
      published_text_at: NOW.toISOString(),
    });
  });

  it("skips a link that is not an X status, without a call or a write", async () => {
    for (const url of [
      "https://www.reddit.com/r/seo/comments/abc/title/def/",
      "https://x.com/owner",
      "https://example.com/owner/status/1855000000000000001",
    ]) {
      const { db, admin } = fakeAdmin([target({ published_url: url })]);
      const readPost = vi.fn(async () => reply("never read"));
      expect(await capturePublishedText(admin, "t-1", url, { readPost, now: NOW })).toEqual({ ok: false, reason: "not_x" });
      expect(readPost).not.toHaveBeenCalled();
      expect(db.calls).toEqual([]);
      expect(db.tables.placement_targets[0].published_text).toBeNull();
    }
  });

  it("leaves the row as it was when X does not hand the post over, and logs it", async () => {
    const { db, admin } = fakeAdmin([target()]);
    const unread = await capturePublishedText(admin, "t-1", REPLY_URL, { readPost: async () => null, now: NOW });
    const thrown = await capturePublishedText(admin, "t-1", REPLY_URL, {
      readPost: async () => {
        throw new TypeError("fetch failed");
      },
      now: NOW,
    });

    expect(unread).toEqual({ ok: false, reason: "unread" });
    expect(thrown).toEqual({ ok: false, reason: "unread" });
    expect(db.tables.placement_targets[0]).toMatchObject({ published_text: null, published_text_at: null });
    expect(db.calls.filter((c) => c.startsWith("update"))).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"reason":"unread"'));
    // The log names the target and the reason, never the text.
    expect(warn.mock.calls.join(" ")).not.toMatch(/edit on X/);
  });

  it("does not store a text read from a link the row no longer carries", async () => {
    const { db, admin } = fakeAdmin([target({ published_url: "https://x.com/owner/status/1855000000000000999" })]);
    const readPost = vi.fn(async () => reply("old link"));
    expect(await capturePublishedText(admin, "t-1", REPLY_URL, { readPost, now: NOW })).toEqual({
      ok: false,
      reason: "link_changed",
    });
    expect(readPost).not.toHaveBeenCalled();
    expect(db.tables.placement_targets[0].published_text).toBeNull();
  });

  it("refuses the answered account's own post: those are not the person's words", async () => {
    const { db, admin } = fakeAdmin([target({ author: "JaneDoe" })]);
    const result = await capturePublishedText(admin, "t-1", REPLY_URL, {
      readPost: async () => reply("A follow-up from the thread's author.", "janedoe"),
      now: NOW,
    });
    expect(result).toEqual({ ok: false, reason: "not_theirs" });
    expect(db.tables.placement_targets[0].published_text).toBeNull();
  });

  it("stores nothing when the reply is only @handles", async () => {
    const { db, admin } = fakeAdmin([target()]);
    const result = await capturePublishedText(admin, "t-1", REPLY_URL, { readPost: async () => reply("@janedoe @jack"), now: NOW });
    expect(result).toEqual({ ok: false, reason: "no_words" });
    expect(db.tables.placement_targets[0].published_text).toBeNull();
  });

  it("never throws when the database fails", async () => {
    const failing = {
      from: () => {
        throw new Error("connection reset");
      },
    } as unknown as SupabaseClient;
    await expect(
      capturePublishedText(failing, "t-1", REPLY_URL, { readPost: async () => reply("text"), now: NOW })
    ).resolves.toEqual({ ok: false, reason: "store_failed" });

    const erroring = {
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: "permission denied" } }) }) }),
      }),
    } as unknown as SupabaseClient;
    await expect(
      capturePublishedText(erroring, "t-1", REPLY_URL, { readPost: async () => reply("text"), now: NOW })
    ).resolves.toEqual({ ok: false, reason: "store_failed" });
  });
});

describe("replyWords", () => {
  it("drops only the leading run of @handles", () => {
    expect(replyWords("@a @b_c\nThanks @jack, that helped.")).toBe("Thanks @jack, that helped.");
    expect(replyWords("No mention here.")).toBe("No mention here.");
    expect(replyWords("@onlyme")).toBe("");
    expect(replyWords("email@example.com stays")).toBe("email@example.com stays");
  });
});

describe("a link that changes", () => {
  const OLD = "https://x.com/owner/status/1855000000000000099";
  const read = { published_text: "Text of the old link.", published_text_at: "2026-11-09T08:00:00.000Z" };

  it("clears the text read from the old link, even when the new one cannot be read", async () => {
    const { db, admin } = fakeAdmin([target(read)]);
    const result = await capturePublishedText(admin, "t-1", REPLY_URL, { previousUrl: OLD, readPost: async () => null, now: NOW });
    expect(result).toEqual({ ok: false, reason: "unread" });
    expect(db.tables.placement_targets[0]).toMatchObject({ published_text: null, published_text_at: null });
  });

  it("keeps the text when the same link is saved again and X does not answer", async () => {
    const { db, admin } = fakeAdmin([target(read)]);
    await capturePublishedText(admin, "t-1", REPLY_URL, { previousUrl: REPLY_URL, readPost: async () => null, now: NOW });
    expect(db.tables.placement_targets[0]).toMatchObject(read);
  });

  it("never clears a row that carries yet another link by now", async () => {
    const { db, admin } = fakeAdmin([target({ ...read, published_url: "https://x.com/owner/status/1855000000000000777" })]);
    await capturePublishedText(admin, "t-1", REPLY_URL, { previousUrl: OLD, readPost: async () => null, now: NOW });
    expect(db.tables.placement_targets[0]).toMatchObject(read);
  });
});

describe("mapTarget and publishedText", () => {
  const row = { id: "t-1", surface: "x", url: REPLY_URL, title: "t", status: "published_manually", created_at: NOW.toISOString() };

  it("carries the text only when the row was read with it, so absent never reads as not read", () => {
    expect(mapTarget({ ...row, published_text: "Mine." }).publishedText).toBe("Mine.");
    expect(mapTarget({ ...row, published_text: null })).toHaveProperty("publishedText", null);
    expect(mapTarget(row)).not.toHaveProperty("publishedText");
  });
});

describe("ensurePublishedText", () => {
  const link = (n: number) => `https://x.com/owner/status/18550000000000000${String(n).padStart(2, "0")}`;

  it("reads at most `max` rows still missing their text, in the order given, and returns them filled in", async () => {
    const rows = [
      target({ id: "has-text", published_url: link(10), published_text: "Already read." }),
      target({ id: "no-link", published_url: null }),
      target({ id: "reddit", published_url: "https://www.reddit.com/r/seo/comments/abc/t/def/" }),
      target({ id: "open", status: "drafted", published_url: link(11) }),
      target({ id: "a", published_url: link(1) }),
      target({ id: "b", published_url: link(2) }),
      target({ id: "c", published_url: link(3) }),
      target({ id: "d", published_url: link(4) }),
    ];
    const { db, admin } = fakeAdmin(rows.map((r) => ({ ...r })));
    const readPost = vi.fn(async (url: string) => reply(`@janedoe Words of ${url.slice(-2)}.`));

    const out = await ensurePublishedText(admin, rows, { max: 2, readPost, now: NOW });

    expect(readPost).toHaveBeenCalledTimes(2);
    expect(readPost.mock.calls.map(([url]) => url)).toEqual([link(1), link(2)]);
    expect(out.map((r) => r.id)).toEqual(rows.map((r) => r.id));
    expect(out.find((r) => r.id === "a")).toMatchObject({ published_text: "Words of 01.", published_text_at: NOW.toISOString() });
    expect(out.find((r) => r.id === "b")?.published_text).toBe("Words of 02.");
    expect(out.find((r) => r.id === "c")?.published_text).toBeNull();
    expect(out.find((r) => r.id === "has-text")?.published_text).toBe("Already read.");
    // Stored, too, so the next load does not ask X again.
    expect(db.tables.placement_targets.find((r) => r.id === "a")?.published_text).toBe("Words of 01.");
    expect(db.tables.placement_targets.find((r) => r.id === "c")?.published_text).toBeNull();
  });

  it("makes no call with max 0, and keeps a row X will not hand over for a later try", async () => {
    const rows = [target({ id: "a", published_url: link(1) })];
    const { admin } = fakeAdmin(rows.map((r) => ({ ...r })));
    const never = vi.fn(async () => reply("unused"));
    expect(await ensurePublishedText(admin, rows, { max: 0, readPost: never })).toEqual(rows);
    expect(never).not.toHaveBeenCalled();

    const out = await ensurePublishedText(admin, rows, { max: 3, readPost: async () => null });
    expect(out[0].published_text).toBeNull();
  });

  it("accepts rows without a status, and the database still decides whether they are posted", async () => {
    const rows = [{ id: "a", published_url: link(1), published_text: null }];
    const { admin } = fakeAdmin([target({ id: "a", published_url: link(1) })]);
    const out = await ensurePublishedText(admin, rows, { max: 1, readPost: async () => reply("Mine."), now: NOW });
    expect(out[0].published_text).toBe("Mine.");
  });
});
