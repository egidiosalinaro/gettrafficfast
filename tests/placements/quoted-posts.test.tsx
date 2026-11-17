import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { XApiClient, X_LOOKUP_USD_PER_POST, lookupWorstCaseUsd, parseXPosts, searchWorstCaseUsd } from "@/lib/providers/x/api";
import { parseOembed, type XPost } from "@/lib/providers/x/oembed";
import { refreshTarget, resolveXShortLink } from "@/lib/providers/x/short-link";
import { safeFetch, type Transport } from "@/lib/providers/safe-fetch";
import { buildPlacementDraftPrompt, PlacementDraftInput } from "@/lib/agents/placement-draft";
import { buildDraftCorrectPrompt, DraftCorrectInput } from "@/lib/agents/draft-correct";
import { postImagesRule } from "@/lib/placements/media";
import {
  LINK_UNREAD_LINE,
  QUOTE_UNREAD_LINE,
  excerptWithReferenced,
  looksLikeReply,
  parseReferenced,
  quoteHintFromEmbed,
  quotedImageInputs,
  referencedFromXApi,
  referencedPostsRule,
  referencedUnreadLine,
  referencedView,
  type ReferencedPost,
  type ReferencedPosts,
} from "@/lib/placements/referenced";
import { backfillReferencedPosts, readQuoteFromEmbed } from "@/lib/placements/x-referenced";
import { readXPostContext } from "@/lib/placements/x-media";
import { searchXForBusiness } from "@/lib/placements/x-search";
import { xDiscoveryWorkflow } from "@/lib/jobs/workflows/x-discovery";
import type { StepContext } from "@/lib/jobs/types";
import { addPostByHand } from "@/lib/placements/manual";
import { mapTarget, type PlacementTargetRecord } from "@/lib/placements/read";
import { PostReferences } from "@/components/placements/post-preview";
import { ReplyItem } from "@/components/placements/reply-item";
import { LedgerFake, fakeXClient, xPost } from "./x-fake";
import { FakeSupabase } from "../support/fake-supabase";

/**
 * The post a post quotes, and the post it replies to (2026-11-14). On
 * 14 November 2026 @hank_ships posted "Naming is the hardest part of shipping", quoting
 * @listing_bot's automated "Pet Portrait AI is now listed for
 * sale…": the joke is all in the quoted post. What is pinned: X's included
 * posts are parsed and counted as posts read; the free path finds the quoted
 * post through the embed's t.co link and oEmbed; a quoted post nobody could
 * read is recorded as unread, never as absent; the drafter and Fix it are
 * told "The post quotes @listing_bot: «…»" apart from the post; the card nests
 * the quoted post like X does.
 */

const HANK_ID = "1989000000000000001";
const QUOTE_ID = "1988900000000000002";
const HANK_TEXT = "Naming is the hardest part of shipping";
const QUOTE_TEXT =
  "Pet Portrait AI is now listed for sale · MRR: $1.4k/mo · Revenue (30d): $1.6k · Asking: $20k\n\nhttps://listings.example.com/startup/pet-portrait";
const QUOTE_URL = `https://x.com/listing_bot/status/${QUOTE_ID}`;
const NOW = new Date("2026-11-14T15:00:00.000Z");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

let quiet: Array<ReturnType<typeof vi.spyOn>>;
beforeEach(() => {
  quiet = (["log", "warn", "error"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
});
afterEach(() => quiet.forEach((spy) => spy.mockRestore()));

/** X's answer for Hank's post with its quote expanded, as documented for `referenced_tweets.id`. */
const HANK_PAYLOAD = {
  data: [
    {
      id: HANK_ID,
      text: `${HANK_TEXT} https://t.co/QuOtE1`,
      author_id: "u-hank",
      created_at: "2026-11-14T12:00:00.000Z",
      referenced_tweets: [{ type: "quoted", id: QUOTE_ID }],
    },
  ],
  includes: {
    users: [
      { id: "u-hank", username: "hank_ships", name: "Hank Maker" },
      { id: "u-trust", username: "listing_bot", name: "ListingBot" },
    ],
    tweets: [
      {
        id: QUOTE_ID,
        text: "Pet Portrait AI is now listed for sale…",
        note_tweet: { text: QUOTE_TEXT },
        author_id: "u-trust",
        created_at: "2026-11-14T10:30:00.000Z",
        attachments: { media_keys: ["3_1"] },
      },
    ],
    media: [{ media_key: "3_1", type: "photo", url: "https://pbs.twimg.com/media/PetPortrait.jpg", width: 1200, height: 630 }],
  },
};

const quotedRead = (): ReferencedPost => ({
  id: QUOTE_ID,
  url: QUOTE_URL,
  text: QUOTE_TEXT,
  authorName: "ListingBot",
  handle: "listing_bot",
  postedAt: "2026-11-14T10:30:00.000Z",
  postedAtPrecision: null,
  media: [{ type: "photo", url: "https://pbs.twimg.com/media/PetPortrait.jpg", previewUrl: null, altText: null, width: 1200, height: 630 }],
  mediaUnread: false,
  note: null,
});

describe("X's included posts", () => {
  it("parses the quoted post from includes.tweets: its whole text, author, time and photo", () => {
    const { posts, included } = parseXPosts(HANK_PAYLOAD, { references: true });
    expect(included).toBe(1);
    expect(posts[0].references).toEqual([
      {
        relation: "quoted",
        id: QUOTE_ID,
        post: {
          id: QUOTE_ID,
          text: QUOTE_TEXT,
          authorId: "u-trust",
          handle: "listing_bot",
          authorName: "ListingBot",
          createdAt: "2026-11-14T10:30:00.000Z",
          media: [{ type: "photo", url: "https://pbs.twimg.com/media/PetPortrait.jpg", previewUrl: null, altText: null, width: 1200, height: 630 }],
          mediaUndescribed: 0,
        },
      },
    ]);
    expect(referencedFromXApi(posts[0])).toEqual({ quoted: quotedRead(), repliedTo: "none" });
  });

  it("records a referenced post X did not include as unread, and a call that did not ask as unknown", () => {
    const { posts } = parseXPosts(
      { data: [{ id: "5", text: "replying", referenced_tweets: [{ type: "replied_to", id: "4" }, { type: "retweeted", id: "3" }] }] },
      { references: true }
    );
    const state = referencedFromXApi(posts[0]);
    expect(state?.quoted).toBe("none");
    expect(state?.repliedTo).toMatchObject({ id: "4", text: null, url: "https://x.com/i/web/status/4" });
    expect(referencedFromXApi(parseXPosts({ data: [{ id: "5", text: "x" }] }).posts[0])).toBeNull();
  });

  it("asks the search and the lookup for the referenced posts, and bills them as posts read", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(HANK_PAYLOAD), { status: 200 }));
    const api = new XApiClient({ token: "t", fetchImpl: fetchImpl as unknown as typeof fetch, log: () => {} });
    const found = await api.searchRecent({ query: "naming", maxResults: 10, startTime: NOW });
    const looked = await api.lookup([HANK_ID], undefined, { references: true });
    for (const call of fetchImpl.mock.calls) {
      const params = new URL(String((call as unknown[])[0])).searchParams;
      expect(params.get("expansions")).toContain("referenced_tweets.id,referenced_tweets.id.author_id,referenced_tweets.id.attachments.media_keys");
      expect(params.get("tweet.fields")).toContain("referenced_tweets");
    }
    // Hank's post and the quote: two posts read.
    expect(found).toMatchObject({ billedPosts: 2, costUsd: 0.01 });
    expect(looked).toMatchObject({ billedPosts: 2, costUsd: 0.01 });
    // The worst case reserves the two a post may reference.
    expect(searchWorstCaseUsd(20, { references: true })).toBe(0.3);
    expect(lookupWorstCaseUsd(1, { references: true })).toBe(0.015);
  });
});

describe("the X search", () => {
  it("records on each kept post what it quotes, from the same answer", async () => {
    const db = new LedgerFake({ placement_targets: [] });
    const included = { id: QUOTE_ID, text: QUOTE_TEXT, authorId: "u9", handle: "listing_bot", authorName: "ListingBot", createdAt: null, media: [], mediaUndescribed: 0 };
    const { client } = fakeXClient({
      searches: [[xPost("101", { handle: "hank_ships", text: HANK_TEXT, references: [{ relation: "quoted", id: QUOTE_ID, post: included }] }), xPost("103", { references: [] })]],
    });
    await searchXForBusiness({
      supabase: db as never,
      client,
      business: { id: "site", user_id: "user", content_language: "en", niche: "SaaS" },
      keywords: ["naming"],
      entities: [],
      brandNames: [],
      now: NOW,
    });
    const row = (id: string) => db.tables.placement_targets.find((r) => r.external_id === `status:${id}`);
    expect(row("101")?.referenced_posts).toMatchObject({ quoted: { handle: "listing_bot", text: QUOTE_TEXT, url: QUOTE_URL }, repliedTo: "none" });
    expect(row("103")?.referenced_posts).toEqual({ quoted: "none", repliedTo: "none" });
  });
});

describe("the X search's pre-filter", () => {
  it("spares a post quoting a post GTF read the shape rules, never the advert rule", async () => {
    const posted = new Date(Date.now() - 3_600_000).toISOString();
    const row = (id: string, text: string, referenced: unknown) => ({
      id,
      user_id: "user",
      business_id: "site",
      surface: "x",
      kind: "post",
      found_via: "x_search",
      status: "discovered",
      qualify_score: null,
      fresh_until: "2099-01-01T00:00:00.000Z",
      url: `https://x.com/a/status/${id}`,
      external_id: `status:${id}`,
      title: text,
      excerpt: text,
      posted_at: posted,
      comment_count: 0,
      found_for: "naming",
      referenced_posts: referenced,
    });
    const db = new LedgerFake({
      businesses: [{ id: "site", user_id: "user", name: "GetTrafficFast", niche: "SEO", website_url: "https://gettrafficfa.st", content_language: "en", aeo_settings: {}, voice_settings: { findPostsOnX: true } }],
      placement_targets: [
        // Hank's quote: a few words and the quote's link, the shape of a link share.
        row("1", `${HANK_TEXT} https://t.co/QuOtE1`, { quoted: quotedRead(), repliedTo: "none" }),
        // The same words with nothing read beside them: still a link share.
        row("2", `${HANK_TEXT} https://t.co/QuOtE1`, { quoted: "none", repliedTo: "none" }),
        // An advert stays an advert, quote or not.
        row("3", "FREE Early Access to our AI tool! Fill out the form and our team will reach out. https://t.co/a", { quoted: quotedRead(), repliedTo: "none" }),
      ],
    });
    const ctx = {
      job: { id: "job-1", user_id: "user", article_id: null, type: "x-post-discovery", input: { businessId: "site" }, status: "running", current_step: null, attempts: 1, max_attempts: 2, last_error: null },
      supabase: db as never,
      input: { businessId: "site" },
      outputs: {},
    } as StepContext;
    const out = await xDiscoveryWorkflow.steps.find((s) => s.name === "rules")!.run(ctx);
    expect(out).toMatchObject({ considered: 3, rejected: 2, byRule: { x_link_share: 1, x_promo: 1 } });
    const status = (id: string) => db.tables.placement_targets.find((r) => r.id === id)?.status;
    expect([status("1"), status("2"), status("3")]).toEqual(["discovered", "rejected", "rejected"]);
  });
});

describe("the embed's link to the quoted post (free path)", () => {
  const embed = (link: { href: string; text: string }) =>
    `<blockquote class="twitter-tweet"><p lang="en" dir="ltr">${HANK_TEXT} <a href="${link.href}">${link.text}</a></p>&mdash; Hank Maker (@hank_ships) <a href="https://twitter.com/hank_ships/status/${HANK_ID}?ref_src=twsrc%5Etfw">November 14, 2026</a></blockquote>`;
  const hank = (link = { href: "https://t.co/QuOtE1", text: "https://t.co/QuOtE1" }) =>
    parseOembed({ html: embed(link), author_name: "Hank Maker", author_url: "https://twitter.com/hank_ships" }) as XPost;

  it("finds the quote: a link naming a post on X, a short link shown as one, or the last short link", () => {
    expect(quoteHintFromEmbed(hank(), HANK_ID)).toEqual({ shortLink: "https://t.co/QuOtE1" });
    expect(quoteHintFromEmbed(hank({ href: "https://t.co/QuOtE1", text: "twitter.com/listing_bot/stat…" }), HANK_ID)).toEqual({
      shortLink: "https://t.co/QuOtE1",
    });
    expect(quoteHintFromEmbed(hank({ href: QUOTE_URL, text: "x.com/listing_bot/status/…" }), HANK_ID)).toEqual({ statusId: QUOTE_ID, url: QUOTE_URL });
    expect(quoteHintFromEmbed({ links: [{ href: "https://twitter.com/jack", text: "@jack" }] }, HANK_ID)).toBeNull();
    expect(looksLikeReply({ text: "@inkwell_ivy this is the way" })).toBe(true);
    expect(looksLikeReply({ text: HANK_TEXT })).toBe(false);
  });

  it("follows the t.co link to the post on X and reads it through oEmbed, for free", async () => {
    const resolveShortLink = vi.fn(async () => `${QUOTE_URL}?s=20`);
    const readPost = vi.fn(async () => ({ text: QUOTE_TEXT, authorName: "ListingBot", handle: "listing_bot", postedOn: "2026-11-14T00:00:00.000Z", hasMedia: true }));
    const slot = await readQuoteFromEmbed({ shortLink: "https://t.co/QuOtE1" }, { resolveShortLink, readPost, now: NOW });
    expect(readPost).toHaveBeenCalledWith(QUOTE_URL);
    expect(slot).toMatchObject({
      id: QUOTE_ID,
      url: QUOTE_URL,
      text: QUOTE_TEXT,
      handle: "listing_bot",
      // The id says when, exactly; the embed carries no image, so the image is unread.
      postedAtPrecision: null,
      media: [],
      mediaUnread: true,
    });
  });

  it("never invents the quote: a link that does not open, or a post X will not embed, is unread; a link elsewhere quotes nothing", async () => {
    const readPost = vi.fn(async () => null);
    expect(await readQuoteFromEmbed({ shortLink: "https://t.co/QuOtE1" }, { resolveShortLink: async () => null, readPost })).toMatchObject({
      id: null,
      text: null,
      note: "the post's link could not be opened",
    });
    expect(await readQuoteFromEmbed({ shortLink: "https://t.co/QuOtE1" }, { resolveShortLink: async () => QUOTE_URL, readPost })).toMatchObject({
      id: QUOTE_ID,
      handle: "listing_bot",
      text: null,
    });
    expect(await readQuoteFromEmbed({ shortLink: "https://t.co/QuOtE1" }, { resolveShortLink: async () => "https://listings.example.com/startup/nose-job", readPost })).toBe(
      "none"
    );
    expect(await readQuoteFromEmbed(null)).toBe("none");
  });

  it("reads where a t.co link points without going there, through safeFetch", async () => {
    const seen: string[] = [];
    const transport: Transport = async (url) => {
      seen.push(url.toString());
      return new Response(null, { status: 301, headers: { location: QUOTE_URL } });
    };
    const publicLookup = async () => [{ address: "104.244.42.1", family: 4 }];
    const fetchImpl = (input: string, init: RequestInit) => safeFetch(input, init, { transport, lookupAll: publicLookup, maxRedirects: 0 });
    expect(await resolveXShortLink("https://t.co/QuOtE1", { fetchImpl })).toBe(QUOTE_URL);
    // Only t.co was asked: the post on X was never fetched.
    expect(seen).toEqual(["https://t.co/QuOtE1"]);
    // A browser gets a refresh page instead of the redirect.
    expect(refreshTarget(`<html><head><meta http-equiv="refresh" content="0;URL=${QUOTE_URL}"></head></html>`, "https://t.co/x")).toBe(QUOTE_URL);
    // Anything but a t.co link is not asked.
    const never = vi.fn();
    expect(await resolveXShortLink("https://evil.example/QuOtE1", { fetchImpl: never })).toBeNull();
    expect(never).not.toHaveBeenCalled();
  });
});

describe("what the drafter and Fix it are told", () => {
  const base = {
    business: { name: "GetTrafficFast", domain: "gettrafficfa.st", niche: "AI SEO" },
    thread: { surface: "x", kind: "post", community: "@hank_ships", title: HANK_TEXT, excerpt: HANK_TEXT, author: "hank_ships" },
    language: "en",
    variants: ["short_comment"],
  };

  it("quotes the quoted post apart from the post, so the reading sees the joke", () => {
    const input = PlacementDraftInput.parse({ ...base, referenced: { quoted: quotedRead(), repliedTo: "none" } });
    const prompt = buildPlacementDraftPrompt(input);
    expect(prompt).toContain(`Opening: ${HANK_TEXT}`);
    expect(prompt).toContain("The post quotes @listing_bot (ListingBot): «Pet Portrait AI is now listed for sale");
    expect(prompt).toContain("you reply to @hank_ships, who posted the words above about it");
    expect(prompt).toContain("read them together before you decide the tone");
    // The quote comes before the reading is asked for.
    expect(prompt.indexOf("The post quotes @listing_bot")).toBeLessThan(prompt.indexOf('"reading" first'));

    const fix = buildDraftCorrectPrompt(
      DraftCorrectInput.parse({
        business: { name: "GetTrafficFast", site: "https://gettrafficfa.st" },
        thread: { surface: "x", kind: "post", title: HANK_TEXT, excerpt: HANK_TEXT, author: "hank_ships" },
        referenced: { quoted: quotedRead(), repliedTo: null },
        variant: "short_comment",
        draft: "naming is hard",
        reason: "It is a joke about the name",
      })
    );
    expect(fix).toContain("The post quotes @listing_bot (ListingBot): «Pet Portrait");
  });

  it("says when the quoted post could not be read, and the post being answered", () => {
    const unread = referencedPostsRule({ quoted: { ...quotedRead(), text: null, note: "X did not hand over the quoted post" }, repliedTo: null }, "hank_ships");
    expect(unread).toContain("The post quotes another post by @listing_bot that could not be read. Do not guess what it says");
    expect(referencedPostsRule({ quoted: { ...quotedRead(), id: null, url: null, handle: null, text: null }, repliedTo: null }, "hank_ships")).toContain(
      "The post ends with a link that could not be opened"
    );
    const reply = referencedPostsRule({ quoted: "none", repliedTo: { ...quotedRead(), text: "What should I name my AI pet portrait app?" } }, "hank_ships");
    expect(reply).toContain("The post is a reply. The post it replies to, by @listing_bot (ListingBot): «What should I name my AI pet portrait app?»");
    expect(referencedPostsRule({ quoted: "none", repliedTo: "none" }, "hank_ships")).toBeNull();
    expect(referencedPostsRule(null, "hank_ships")).toBeNull();
  });

  it("hands the quoted post's photo in a free image slot, named as the quoted post's", () => {
    const state: ReferencedPosts = { quoted: quotedRead(), repliedTo: "none" };
    expect(quotedImageInputs(state, 2)).toEqual([{ url: "https://pbs.twimg.com/media/PetPortrait.jpg", altText: null, from: "quoted" }]);
    expect(quotedImageInputs(state, 0)).toEqual([]);
    expect(postImagesRule([{ altText: null, from: "quoted" }], 0)).toBe(
      "Image 1 is the quoted post's, given to you with this prompt: read it as part of what the post quotes."
    );
    expect(postImagesRule([{ altText: null }, { altText: "the listing", from: "quoted" }], 0)).toContain(
      "Image 2 is the quoted post's, given to you with this prompt after the post's own"
    );
  });

  it("gives the checks the quoted text beside the post, so a reply about the quote is on topic", () => {
    expect(excerptWithReferenced(HANK_TEXT, { quoted: quotedRead(), repliedTo: "none" })).toBe(
      `${HANK_TEXT}\n\nQuoting @listing_bot (ListingBot): ${QUOTE_TEXT}`
    );
    expect(excerptWithReferenced(HANK_TEXT, null)).toBe(HANK_TEXT);
  });
});

describe("the record and the unread flag", () => {
  it("reads the stored slots: not known, none, read, unread", () => {
    expect(referencedView(null)).toEqual({ quotedPost: null, quoteUnread: null, repliedToPost: null, repliedToUnread: null });
    const read = referencedView(parseReferenced({ quoted: quotedRead(), repliedTo: "none" }));
    expect(read).toMatchObject({ quotedPost: { id: QUOTE_ID }, quoteUnread: false, repliedToPost: null, repliedToUnread: false });
    const unread = referencedView(parseReferenced({ quoted: { ...quotedRead(), text: null }, repliedTo: null }));
    expect(unread).toMatchObject({ quoteUnread: true, repliedToUnread: null });
    expect(referencedUnreadLine(unread)).toBe(QUOTE_UNREAD_LINE);
    expect(referencedUnreadLine(referencedView({ quoted: { ...quotedRead(), id: null, text: null }, repliedTo: null }))).toBe(LINK_UNREAD_LINE);
    // A bad slot is not known, never "none".
    expect(parseReferenced({ quoted: { text: 5 }, repliedTo: "none" })).toEqual({ quoted: null, repliedTo: "none" });
    expect(parseReferenced("nope")).toBeNull();
  });

  it("maps the column onto the record, and leaves the fields out when it was not read", () => {
    const row = { id: "t", surface: "x", title: HANK_TEXT, status: "drafted" };
    expect(mapTarget({ ...row, referenced_posts: { quoted: quotedRead(), repliedTo: "none" } }, [])).toMatchObject({ quotedPost: { handle: "listing_bot" }, quoteUnread: false });
    expect("quotedPost" in mapTarget(row, [])).toBe(false);
  });
});

describe("a post added by hand", () => {
  const POST_URL = `https://x.com/hank_ships/status/${HANK_ID}`;
  const MARC: XPost = {
    text: HANK_TEXT,
    authorName: "Hank Maker",
    handle: "hank_ships",
    postedOn: "2026-11-14T00:00:00.000Z",
    hasMedia: false,
    links: [{ href: "https://t.co/QuOtE1", text: "https://t.co/QuOtE1" }],
  };
  let db: FakeSupabase;
  const clients = () => ({ supabase: db as unknown as SupabaseClient, admin: db as unknown as SupabaseClient });
  beforeEach(() => {
    db = new FakeSupabase({ placement_targets: [], placements: [] });
  });

  it("with the X API: one read by id returns the quote, stored and on the card", async () => {
    const readContext = vi.fn(async () => ({
      ok: true as const,
      media: { media: [], unread: false },
      referenced: { quoted: quotedRead(), repliedTo: "none" as const },
    }));
    const readQuote = vi.fn();
    const result = await addPostByHand({ ...clients(), userId: "u", businessId: "b", url: POST_URL, readPost: async () => MARC, readContext, readQuote, now: NOW });
    expect(readContext).toHaveBeenCalledWith(HANK_ID);
    expect(readQuote).not.toHaveBeenCalled();
    expect(db.tables.placement_targets[0].referenced_posts).toEqual({ quoted: quotedRead(), repliedTo: "none" });
    if (result.ok) expect(result.target).toMatchObject({ quotedPost: { text: QUOTE_TEXT }, quoteUnread: false, repliedToUnread: false });
  });

  it("without it (off, capped, failing): the quote is read for free, and a post with no link costs nothing", async () => {
    const readContext = vi.fn(async () => ({ ok: false as const, refusal: "disabled" as const, message: "off" }));
    const readQuote = vi.fn(async () => quotedRead());
    await addPostByHand({ ...clients(), userId: "u", businessId: "b", url: POST_URL, readPost: async () => MARC, readContext, readQuote, now: NOW });
    expect(readQuote).toHaveBeenCalledWith({ shortLink: "https://t.co/QuOtE1" });
    // The free path cannot tell whether it is a reply: not known.
    expect(db.tables.placement_targets[0].referenced_posts).toEqual({ quoted: quotedRead(), repliedTo: null });

    db = new FakeSupabase({ placement_targets: [], placements: [] });
    const paid = vi.fn();
    await addPostByHand({ ...clients(), userId: "u", businessId: "b", url: POST_URL, readPost: async () => ({ ...MARC, links: [] }), readContext: paid, now: NOW });
    expect(paid).not.toHaveBeenCalled();
    expect(db.tables.placement_targets[0].referenced_posts).toEqual({ quoted: "none", repliedTo: null });
  });

  it("records the quote as unread when nothing could read it", async () => {
    const result = await addPostByHand({
      ...clients(),
      userId: "u",
      businessId: "b",
      url: POST_URL,
      readPost: async () => MARC,
      readContext: async () => ({ ok: false, refusal: "cap", message: "cap" }),
      readQuote: async () => {
        throw new Error("t.co timed out");
      },
      now: NOW,
    });
    if (result.ok) expect(result.target).toMatchObject({ quoteUnread: true, quotedPost: { id: null, text: null } });
  });

  it("the metered read asks for the referenced posts in the same call, under the cap", async () => {
    const ledger = new LedgerFake();
    const { client, lookup } = fakeXClient({
      lookup: (ids) => ({
        posts: ids.map((id) => xPost(id, { references: [{ relation: "quoted", id: QUOTE_ID, post: null }] })),
        missingIds: [],
        billedPosts: ids.length,
        costUsd: ids.length * X_LOOKUP_USD_PER_POST,
      }),
    });
    const read = await readXPostContext({ supabase: ledger as never, client, statusId: HANK_ID, capUsd: 20, now: NOW });
    expect(lookup).toHaveBeenCalledWith([HANK_ID], undefined, { media: true, references: true });
    expect(read).toMatchObject({ ok: true, referenced: { quoted: { id: QUOTE_ID, text: null }, repliedTo: "none" } });
  });
});

describe("the backfill of open posts of the last 3 days", () => {
  const SITE = "site-api";
  const OTHER = "site-free";
  const row = (id: string, business: string, status: string, created: string, over: Record<string, unknown> = {}) => ({
    id,
    business_id: business,
    surface: "x",
    external_id: `status:${id.replace(/\D/g, "")}`,
    url: `https://x.com/someone/status/${id.replace(/\D/g, "")}`,
    status,
    created_at: created,
    referenced_posts: null,
    ...over,
  });

  it("reads the open rows with nothing recorded: metered for the sites taking part, free for the rest, and says the numbers", async () => {
    const db = new LedgerFake({
      placement_targets: [
        row("t111", SITE, "drafted", "2026-11-13T09:00:00.000Z"),
        row("t222", SITE, "qualified", "2026-11-14T09:00:00.000Z"),
        // Posted, too old, or already known: left alone.
        row("t333", SITE, "published_manually", "2026-11-14T09:00:00.000Z"),
        row("t444", SITE, "drafted", "2026-11-09T09:00:00.000Z"),
        row("t555", SITE, "drafted", "2026-11-14T09:00:00.000Z", { referenced_posts: { quoted: "none", repliedTo: "none" } }),
        row("t666", OTHER, "drafted", "2026-11-14T08:00:00.000Z"),
      ],
    });
    const { client, lookup } = fakeXClient({
      lookup: (ids) => ({
        // 222 quotes Pet Portrait; 111 X does not return.
        posts: ids
          .filter((id) => id === "222")
          .map((id) => xPost(id, { references: [{ relation: "quoted", id: QUOTE_ID, post: { id: QUOTE_ID, text: QUOTE_TEXT, authorId: "u", handle: "listing_bot", authorName: "ListingBot", createdAt: null, media: [], mediaUndescribed: 0 } }] })),
        missingIds: ["111"],
        billedPosts: 2,
        costUsd: 0.01,
      }),
    });
    const readPost = vi.fn(async () => ({ text: HANK_TEXT, authorName: null, handle: "someone", postedOn: null, links: [] }));
    const out = await backfillReferencedPosts({ admin: db as never, client, apiBusinessIds: [SITE], now: NOW, capUsd: 20, readers: { readPost } });

    expect(lookup).toHaveBeenCalledWith(["222", "111"], undefined, { references: true });
    expect(out).toMatchObject({ candidates: 3, api: { asked: 2, returned: 1, costUsd: 0.01 }, embed: 1, recorded: 3, quoting: 1 });
    const state = (id: string) => db.tables.placement_targets.find((r) => r.id === id)?.referenced_posts;
    expect(state("t222")).toMatchObject({ quoted: { handle: "listing_bot", text: QUOTE_TEXT }, repliedTo: "none" });
    expect(state("t111")).toEqual({ quoted: null, repliedTo: null });
    expect(state("t666")).toEqual({ quoted: "none", repliedTo: null });
    expect(state("t333")).toBeNull();
    expect(state("t444")).toBeNull();
    // Reserved at worst (2 posts and two referenced each), settled to what was read.
    expect(db.spend("2026-11-01")).toMatchObject({ cost_usd: 0.01, calls: 1, posts: 2 });
  });

  it("at the cap, the sites taking part are read for free instead", async () => {
    const db = new LedgerFake({
      provider_spend: [{ provider: "x-api", month: "2026-11-01", cost_usd: 19.99, calls: 1, posts: 1 }],
      placement_targets: [row("t222", SITE, "drafted", "2026-11-14T09:00:00.000Z")],
    });
    const { client, lookup } = fakeXClient();
    const out = await backfillReferencedPosts({
      admin: db as never,
      client,
      apiBusinessIds: [SITE],
      now: NOW,
      capUsd: 20,
      readers: { readPost: async () => null },
    });
    expect(lookup).not.toHaveBeenCalled();
    expect(out).toMatchObject({ api: { skipped: expect.stringContaining("cap") }, embed: 1, recorded: 1 });
  });
});

describe("the card", () => {
  const NOW_MS = NOW.getTime();
  const marcTarget = (over: Partial<PlacementTargetRecord> = {}): PlacementTargetRecord => ({
    id: "t-1",
    surface: "x",
    kind: "post",
    url: `https://x.com/hank_ships/status/${HANK_ID}`,
    title: HANK_TEXT,
    excerpt: HANK_TEXT,
    community: "@hank_ships",
    author: "hank_ships",
    postedAt: "2026-11-14T12:00:00.000Z",
    postedAtPrecision: null,
    score: null,
    commentCount: null,
    foundFor: null,
    foundVia: "manual",
    status: "qualified",
    qualifyScore: null,
    qualifyReason: null,
    qualifyAngle: null,
    qualifiedBy: "person",
    qualifiedAt: null,
    topic: null,
    intent: null,
    freshUntil: null,
    snoozedUntil: null,
    reviewNote: null,
    dismissedReason: null,
    publishedUrl: null,
    publishedAt: null,
    publishedNote: null,
    aeoQueryId: null,
    selectedPlacementId: null,
    lastSeenAt: null,
    createdAt: "2026-11-14T12:30:00.000Z",
    drafts: [],
    quotedPost: quotedRead(),
    quoteUnread: false,
    repliedToPost: null,
    repliedToUnread: false,
    ...over,
  });

  it("nests the quoted post under the text, one link to it on X: name, handle, age, text, photo", () => {
    const html = renderToStaticMarkup(<PostReferences target={marcTarget()} now={NOW_MS} />);
    expect(html).toContain(`href="${QUOTE_URL}"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain("ListingBot");
    expect(html).toContain("@listing_bot");
    expect(html).toContain("· 4h");
    expect(html).toContain("Pet Portrait AI is now listed for sale");
    expect(html).toContain("line-clamp-4");
    expect(html).toContain("min-h-11");
    expect(html).toContain('src="https://pbs.twimg.com/media/PetPortrait.jpg"');
    expect(html).toContain('"no-referrer"');
  });

  it("is in the open item of Replies and Today, under the post", () => {
    const html = renderToStaticMarkup(
      <ReplyItem
        target={marcTarget()}
        now={NOW_MS}
        business={{ name: "GetTrafficFast", domain: "gettrafficfa.st" }}
        busy={false}
        replied={false}
        onRepliedChange={() => {}}
        onDraft={() => {}}
        onAction={() => {}}
        onMarkPublished={async () => null}
        onSaveDraft={async () => ({ ok: false as const, error: "x" })}
        onSaveOwnReply={async () => ({ ok: false as const, error: "x" })}
        onCorrectDraft={async () => ({ ok: false as const, error: "x" })}
        onPromoteNote={async () => ({ ok: false as const, error: "x" })}
      />
    );
    expect(html.indexOf(HANK_TEXT)).toBeLessThan(html.indexOf("data-quoted-post"));
  });

  it("says when the quoted post could not be read, and shows nothing when there is none", () => {
    const unread = renderToStaticMarkup(
      <PostReferences target={marcTarget({ quotedPost: { ...quotedRead(), text: null }, quoteUnread: true })} now={NOW_MS} />
    );
    expect(unread).toContain(QUOTE_UNREAD_LINE);
    expect(unread).not.toContain("data-quoted-post");
    expect(unread).toContain(`href="${QUOTE_URL}"`);
    expect(renderToStaticMarkup(<PostReferences target={marcTarget({ quotedPost: null, quoteUnread: false })} now={NOW_MS} />)).toBe("");
  });

  it("reads in both themes from tokens only", () => {
    const source = readFileSync(path.join(root, "components/placements/post-preview.tsx"), "utf8");
    const box = source.slice(source.indexOf("export function QuotedPostBox"));
    expect(box).toContain("border-border bg-card");
    expect(box).not.toMatch(/bg-white|text-black/);
  });
});

describe("20261114180000_placement_referenced_posts.sql", () => {
  const sql = readFileSync(path.join(root, "supabase/migrations/20261114180000_placement_referenced_posts.sql"), "utf8");
  const code = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .replace(/\s+/g, " ");

  it("adds one nullable column if it is missing, and applies without a confirmation", () => {
    expect(code).toContain("alter table public.placement_targets add column if not exists referenced_posts jsonb;");
    expect(code).not.toMatch(/not null|\bdefault\b|\bdrop\b|\btruncate\b|\bdelete from\b|\brevoke\b|\bupdate\b|policy/i);
  });
});
