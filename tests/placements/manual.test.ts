import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { XPost } from "@/lib/providers/x/oembed";
import {
  ADDED_REASON,
  MANUAL_SOURCE,
  NOT_AN_X_POST,
  TEXT_NEEDED,
  addPostByHand,
  cleanPastedText,
  parseXStatusLink,
} from "@/lib/placements/manual";
import { PERSON_VERDICT } from "@/lib/placements/qualification";
import { statusWhenAddedByHand } from "@/lib/placements/workflow";
import { FakeSupabase } from "../support/fake-supabase";

/**
 * "Add a post from X". What is pinned: only a link to one post is accepted,
 * and it gets the identity discovery would give it; the text is X's when X
 * hands it over and the person's paste when it does not, and with neither
 * nothing is stored; the row is qualified by the person, with no score; a
 * post already stored is reused, reopened when it was turned down, and left
 * alone when a reply was already published; and only the insert goes
 * through the service role.
 */

const STATUS_ID = "1852000000000000000";
const POST_URL = `https://x.com/janedoe/status/${STATUS_ID}`;
const NOW = new Date("2024-10-31T18:00:00.000Z");

const POST: XPost = {
  text: "Shipping a new feature today 🚀\n\nBig thanks to @jack & the team.",
  authorName: "Jane Doe",
  handle: "janedoe",
  postedOn: "2024-10-31T00:00:00.000Z",
};

describe("parseXStatusLink", () => {
  it("accepts a post on X however the link was copied, with discovery's identity", () => {
    for (const raw of [
      POST_URL,
      `https://twitter.com/janedoe/status/${STATUS_ID}`,
      `https://mobile.twitter.com/janedoe/status/${STATUS_ID}?s=20&t=abc`,
      `https://www.x.com/janedoe/status/${STATUS_ID}/photo/1`,
      `  x.com/janedoe/status/${STATUS_ID}  `,
    ]) {
      const link = parseXStatusLink(raw);
      expect(link, raw).toMatchObject({
        ok: true,
        statusId: STATUS_ID,
        target: { surface: "x", kind: "post", externalId: `status:${STATUS_ID}`, url: POST_URL, author: "janedoe" },
      });
    }
    expect(parseXStatusLink(`https://x.com/i/web/status/${STATUS_ID}`)).toMatchObject({
      ok: true,
      target: { externalId: `status:${STATUS_ID}`, author: null },
    });
  });

  it("refuses anything that is not one post on X", () => {
    for (const raw of [
      "",
      "https://x.com/janedoe",
      "https://x.com/janedoe/article/123",
      "https://x.com/janedoe/status/notanumber",
      "https://www.reddit.com/r/SEO/comments/1abc2d/x/",
      "https://example.com/janedoe/status/123",
      "javascript:alert(1)",
      "not a link",
    ]) {
      expect(parseXStatusLink(raw), raw).toEqual({ ok: false, error: NOT_AN_X_POST });
    }
  });
});

describe("cleanPastedText", () => {
  it("keeps the line breaks and drops what a paste drags along", () => {
    expect(cleanPastedText("  line one  \r\n\r\n\r\n\r\nline two 🎉\t\r\n")).toBe("line one\n\nline two 🎉");
    expect(cleanPastedText(null)).toBe("");
  });
});

describe("statusWhenAddedByHand", () => {
  it("qualifies what nobody judged or what was turned down, keeps open rows, and leaves a published one", () => {
    expect(statusWhenAddedByHand("discovered")).toBe("qualified");
    expect(statusWhenAddedByHand("rejected")).toBe("qualified");
    expect(statusWhenAddedByHand("dismissed")).toBe("qualified");
    expect(statusWhenAddedByHand("drafted")).toBe("drafted");
    expect(statusWhenAddedByHand("approved")).toBe("approved");
    expect(statusWhenAddedByHand("published_manually")).toBeNull();
  });
});

describe("addPostByHand", () => {
  let db: FakeSupabase;
  let userTables: string[];
  let adminWrites: string[];
  let reads: string[];

  /** The person's client and the service role, over one fake database, each recording what it touched. */
  const clients = () => {
    const user = {
      from: (table: string) => {
        userTables.push(table);
        return db.from(table);
      },
    };
    const admin = {
      from: (table: string) => {
        adminWrites.push(table);
        return db.from(table);
      },
    };
    return { supabase: user as unknown as SupabaseClient, admin: admin as unknown as SupabaseClient };
  };

  const add = (over: { url?: string; pastedText?: string | null; post?: XPost | null } = {}) =>
    addPostByHand({
      ...clients(),
      userId: "user-1",
      businessId: "biz-1",
      url: over.url ?? POST_URL,
      pastedText: over.pastedText ?? null,
      readPost: async (url) => {
        reads.push(url);
        return over.post === undefined ? POST : over.post;
      },
      now: NOW,
    });

  const stored = (over: Record<string, unknown>) => ({
    id: "row-1",
    user_id: "user-1",
    business_id: "biz-1",
    surface: "x",
    kind: "post",
    external_id: `status:${STATUS_ID}`,
    url: POST_URL,
    title: "Shipping a new feature today",
    excerpt: "Shipping a new feature today",
    community: "@janedoe",
    author: "janedoe",
    found_via: "web-search",
    posted_at: "2024-10-31T18:00:00.000Z",
    posted_at_precision: "day",
    qualify_score: 82,
    qualify_reason: "Their topic.",
    qualify_angle: "Ship the smallest version first.",
    qualified_by: "agent",
    snoozed_until: null,
    dismissed_reason: null,
    ...over,
  });

  beforeEach(() => {
    db = new FakeSupabase({ placement_targets: [], placements: [] });
    userTables = [];
    adminWrites = [];
    reads = [];
  });

  afterEach(() => vi.unstubAllGlobals());

  it("reads the media of a post whose embed shows a picture, and stores them on the row (11 November 2026)", async () => {
    const photo = { type: "photo", url: "https://pbs.twimg.com/media/Gc1.jpg", previewUrl: null, altText: null, width: 1200, height: 675 };
    const readContext = vi.fn(async () => ({
      ok: true as const,
      media: { media: [photo], unread: false },
      referenced: { quoted: "none" as const, repliedTo: "none" as const },
    }));
    const result = await addPostByHand({
      ...clients(),
      userId: "user-1",
      businessId: "biz-1",
      url: POST_URL,
      readPost: async () => ({ ...POST, hasMedia: true }),
      readContext,
      now: NOW,
    });
    expect(readContext).toHaveBeenCalledWith(STATUS_ID);
    expect(db.tables.placement_targets[0]).toMatchObject({ media: [photo], media_unread: false });
    if (result.ok) expect(result.target).toMatchObject({ media: [photo], mediaUnread: false });

    // No picture in the embed: nothing is read, nothing is paid.
    db = new FakeSupabase({ placement_targets: [], placements: [] });
    const none = vi.fn();
    await addPostByHand({ ...clients(), userId: "user-1", businessId: "biz-1", url: POST_URL, readPost: async () => POST, readContext: none, now: NOW });
    expect(none).not.toHaveBeenCalled();
  });

  it("records the media as unread when the X API is off", async () => {
    vi.stubEnv("X_API_ENABLED", "");
    const result = await addPostByHand({
      ...clients(),
      userId: "user-1",
      businessId: "biz-1",
      url: POST_URL,
      readPost: async () => ({ ...POST, hasMedia: true }),
      now: NOW,
    });
    vi.unstubAllEnvs();
    expect(db.tables.placement_targets[0]).toMatchObject({ media: null, media_unread: true });
    if (result.ok) expect(result.target).toMatchObject({ media: null, mediaUnread: true });
  });

  it("stores the post read from X as a qualified row the person chose, with no score", async () => {
    const result = await add();
    expect(result).toMatchObject({ ok: true, outcome: "created", textFrom: "x", draftable: true });
    expect(reads).toEqual([POST_URL]);
    expect(db.tables.placement_targets).toHaveLength(1);
    const row = db.tables.placement_targets[0];
    expect(row).toMatchObject({
      user_id: "user-1",
      business_id: "biz-1",
      surface: "x",
      kind: "post",
      external_id: `status:${STATUS_ID}`,
      url: POST_URL,
      title: "Shipping a new feature today 🚀 Big thanks to @jack & the team.",
      excerpt: POST.text,
      community: "@janedoe",
      author: "janedoe",
      found_for: null,
      found_via: MANUAL_SOURCE,
      status: "qualified",
      qualify_score: null,
      qualify_reason: ADDED_REASON,
      qualify_angle: null,
      qualified_by: PERSON_VERDICT,
      qualified_at: NOW.toISOString(),
      // The id says exactly when: not the embed's day.
      posted_at: "2024-10-31T14:49:43.153Z",
      posted_at_precision: null,
      fresh_until: "2024-12-30T14:49:43.153Z",
      score: null,
      comment_count: null,
    });
    expect(typeof row.content_hash).toBe("string");
    // Only the insert went through the service role.
    expect(adminWrites).toEqual(["placement_targets"]);
    if (result.ok) expect(result.target).toMatchObject({ id: row.id, status: "qualified", qualifiedBy: PERSON_VERDICT, drafts: [] });
  });

  it("falls back to the text the person pasted when X does not hand the post over", async () => {
    const result = await add({ post: null, pastedText: "  Is anyone else seeing\r\nzero clicks from AI answers?  " });
    expect(result).toMatchObject({ ok: true, outcome: "created", textFrom: "pasted", draftable: true });
    expect(db.tables.placement_targets[0]).toMatchObject({
      title: "Is anyone else seeing zero clicks from AI answers?",
      excerpt: "Is anyone else seeing\nzero clicks from AI answers?",
      author: "janedoe",
      posted_at: "2024-10-31T14:49:43.153Z",
    });
  });

  it("prefers X's own text over a paste when both are there", async () => {
    await add({ pastedText: "my own summary" });
    expect(db.tables.placement_targets[0].excerpt).toBe(POST.text);
  });

  it("asks for the text, and stores nothing, when there is neither", async () => {
    expect(await add({ post: null })).toEqual({ ok: false, code: "text_needed", error: TEXT_NEEDED });
    expect(await add({ post: null, pastedText: "   \n " })).toMatchObject({ ok: false, code: "text_needed" });
    expect(db.tables.placement_targets).toHaveLength(0);
  });

  it("refuses a link that is not a post on X before asking X anything", async () => {
    expect(await add({ url: "https://x.com/janedoe" })).toEqual({ ok: false, code: "not_x_post", error: NOT_AN_X_POST });
    expect(reads).toEqual([]);
    expect(db.tables.placement_targets).toHaveLength(0);
  });

  it("names the account from the embed when the link carried none", async () => {
    await add({ url: `https://x.com/i/web/status/${STATUS_ID}` });
    expect(db.tables.placement_targets[0]).toMatchObject({ url: POST_URL, community: "@janedoe", author: "janedoe" });
  });

  it("is one row when the same post is added twice", async () => {
    await add();
    const again = await add({ url: `https://twitter.com/janedoe/status/${STATUS_ID}?s=20` });
    expect(again).toMatchObject({ ok: true, outcome: "already_open" });
    expect(db.tables.placement_targets).toHaveLength(1);
  });

  it("reuses an open row and keeps its status, verdict and drafts; no new draft over a written one", async () => {
    db.tables.placement_targets.push(stored({ status: "drafted", snoozed_until: "2099-01-01T00:00:00.000Z" }));
    db.tables.placements.push({ id: "d-1", target_id: "row-1", business_id: "biz-1", variant: "short_comment", body: "…", audit_status: "passed" });
    const result = await add();
    expect(result).toMatchObject({ ok: true, outcome: "already_open", textFrom: "stored", draftable: false });
    expect(db.tables.placement_targets).toHaveLength(1);
    expect(db.tables.placement_targets[0]).toMatchObject({
      status: "drafted",
      qualified_by: "agent",
      qualify_score: 82,
      found_via: "web-search",
      title: "Shipping a new feature today",
      snoozed_until: null,
      // A day read off a search result becomes the exact moment the id gives.
      posted_at: "2024-10-31T14:49:43.153Z",
      posted_at_precision: null,
    });
    // It already had its text and its account: X was not asked.
    expect(reads).toEqual([]);
    expect(adminWrites).toEqual([]);
    if (result.ok) expect(result.target.drafts.map((d) => d.id)).toEqual(["d-1"]);
  });

  it("offers a draft for an open row that has none yet", async () => {
    db.tables.placement_targets.push(stored({ status: "qualified" }));
    expect(await add()).toMatchObject({ ok: true, outcome: "already_open", draftable: true });
  });

  it("reopens a post that was turned down, as the person's verdict", async () => {
    db.tables.placement_targets.push(
      stored({ status: "rejected", qualified_by: "rules:stale", qualify_score: 0, qualify_reason: "Stale (90 days).", qualify_angle: null })
    );
    const result = await add();
    expect(result).toMatchObject({ ok: true, outcome: "reopened", draftable: true });
    expect(db.tables.placement_targets[0]).toMatchObject({
      status: "qualified",
      qualified_by: PERSON_VERDICT,
      qualified_at: NOW.toISOString(),
      qualify_score: null,
      qualify_reason: ADDED_REASON,
    });
    expect(adminWrites).toEqual([]);
  });

  it("reopens a dismissed post and clears the reason it was dismissed for", async () => {
    db.tables.placement_targets.push(stored({ status: "dismissed", dismissed_reason: "not now" }));
    expect(await add()).toMatchObject({ ok: true, outcome: "reopened", draftable: true });
    expect(db.tables.placement_targets[0]).toMatchObject({ status: "qualified", dismissed_reason: null, qualified_by: PERSON_VERDICT });
  });

  it("qualifies a post discovery found and nobody judged yet, filling in what the search did not know", async () => {
    db.tables.placement_targets.push(
      stored({ status: "discovered", excerpt: null, author: null, posted_at: null, posted_at_precision: null, qualify_score: null, qualified_by: null })
    );
    const result = await add();
    expect(result).toMatchObject({ ok: true, outcome: "reopened", textFrom: "x", draftable: true });
    expect(db.tables.placement_targets[0]).toMatchObject({
      status: "qualified",
      qualified_by: PERSON_VERDICT,
      excerpt: POST.text,
      author: "janedoe",
      posted_at: "2024-10-31T14:49:43.153Z",
      // The first sighting's title stays.
      title: "Shipping a new feature today",
    });
  });

  it("leaves a published post exactly as it is, without asking X", async () => {
    const row = stored({ status: "published_manually", published_url: "https://x.com/me/status/1900000000000000000" });
    db.tables.placement_targets.push(row);
    const before = { ...row };
    const result = await add();
    expect(result).toMatchObject({ ok: true, outcome: "published", draftable: false });
    expect(db.tables.placement_targets[0]).toEqual(before);
    expect(reads).toEqual([]);
  });

  it("reads the post through X's oEmbed by default, and falls back to the paste when fetch fails", async () => {
    const html =
      '<blockquote class="twitter-tweet"><p lang="en" dir="ltr">Who else is replying from an X List?<br>Asking for real 👀</p>' +
      `&mdash; Jane Doe (@janedoe) <a href="https://twitter.com/janedoe/status/${STATUS_ID}">October 31, 2024</a></blockquote>`;
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ html, author_name: "Jane Doe", author_url: "https://twitter.com/janedoe" }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const first = await addPostByHand({ ...clients(), userId: "user-1", businessId: "biz-1", url: POST_URL, now: NOW });
    expect(first).toMatchObject({ ok: true, outcome: "created", textFrom: "x" });
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toMatch(/^https:\/\/publish\.twitter\.com\/oembed\?/);
    expect(db.tables.placement_targets[0].excerpt).toBe("Who else is replying from an X List?\nAsking for real 👀");

    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    const other = `https://x.com/someone/status/1852000000000000001`;
    const second = await addPostByHand({
      ...clients(),
      userId: "user-1",
      businessId: "biz-1",
      url: other,
      pastedText: "What the person pasted.",
      now: NOW,
    });
    expect(second).toMatchObject({ ok: true, outcome: "created", textFrom: "pasted" });
    expect(db.tables.placement_targets[1]).toMatchObject({ excerpt: "What the person pasted.", author: "someone" });
  });
});
