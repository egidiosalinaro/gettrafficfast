import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { renderToStaticMarkup } from "react-dom/server";

const images = vi.hoisted(() => ({ fetchLlmImages: vi.fn() }));
vi.mock("@/lib/providers/llm/images", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/providers/llm/images")>()),
  fetchLlmImages: images.fetchLlmImages,
}));
vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock("@/lib/notifications/email", () => ({ operatorEmailAddress: () => null, sendNotificationEmail: vi.fn() }));

import { createBudget } from "@/lib/agents/contract";
import { DraftCorrectInput, buildDraftCorrectPrompt, draftCorrectAgent } from "@/lib/agents/draft-correct";
import { PlacementDraftInput, buildPlacementDraftPrompt, placementDraftAgent } from "@/lib/agents/placement-draft";
import { auditDraft, isAdvisory } from "@/lib/placements/audit";
import {
  IMAGE_NOT_READ_DETAIL,
  IMAGE_RULE,
  MEDIA_UNREAD_LINE,
  draftImagePlan,
  draftImagesRecord,
  parseMedia,
  showsUnreadImage,
  withImages,
  type PostMediaItem,
} from "@/lib/placements/media";
import { readXPostMedia } from "@/lib/placements/x-media";
import { xPostMediaState } from "@/lib/placements/x-search";
import { messageContent, requestBody } from "@/lib/providers/llm/anthropic";
import { contentParts } from "@/lib/providers/llm/gemini";
import { fetchLlmImage, sniffImageType } from "@/lib/providers/llm/images";
import { setLlmProvider } from "@/lib/providers/llm/registry";
import type { LLMProvider, LlmImage, LlmOptions, LlmStructuredResult, LlmTextResult } from "@/lib/providers/llm/types";
import { X_LOOKUP_USD_PER_POST, parseXPosts, type XApiClient } from "@/lib/providers/x/api";
import { embedHasMedia, parseOembed } from "@/lib/providers/x/oembed";
import { PostMedia } from "@/components/placements/reply-item";
import { LedgerFake, fakeXClient, xPost } from "./x-fake";

/**
 * The post's images (docs/PLACEMENTS.md, "The post's images", 2026-11-11).
 *
 * The real case: @cass_builds posted "hi guys, are these numbers normal for a twelve day old
 * project with a brand new domain? asking for a friend" with one image, a
 * screenshot of the numbers. The draft never saw it and asked for what it
 * showed. What is pinned: the image reaches the model call, the prompt
 * carries the rule, an image nobody read fails the advisory check and shows
 * a line on the card, the media are read from X's answer and from the embed,
 * and the by-id read for a hand-added post stays under the X cap.
 */

const CASS_TEXT = "quick sanity check: are these numbers normal for a twelve day old site on a fresh domain? asking for myself";
const CASS_IMAGE = "https://pbs.twimg.com/media/SampleShot1.jpg";
const BAD_DRAFT =
  "two weeks is really early for a new domain, so don't expect too much yet. it took a while for my blog articles to even get past 9 impressions a week. what kind of traffic are you seeing so far?";

const cassMedia: PostMediaItem[] = [
  { type: "photo", url: CASS_IMAGE, previewUrl: null, altText: null, width: 1200, height: 675 },
];

const PNG: LlmImage = { mimeType: "image/png", data: "iVBORw0KGgo=" };

const draftInput = (over: Record<string, unknown> = {}) =>
  PlacementDraftInput.parse({
    business: { name: "GetTrafficFast", domain: "https://gettrafficfa.st", niche: "AI SEO" },
    thread: { surface: "x", kind: "post", community: "@cass_builds", title: CASS_TEXT, excerpt: CASS_TEXT, author: "cass_builds" },
    angle: null,
    chosenByPerson: true,
    language: "en",
    variants: ["short_comment"],
    ...over,
  });

function stubLlm(value: unknown, seen: Array<{ prompt: string; options?: LlmOptions }>): LLMProvider {
  return {
    name: "stub",
    async generateText(): Promise<LlmTextResult> {
      throw new Error("not used");
    },
    async generateStructured<T>(prompt: string, schema: z.ZodType<T>, options?: LlmOptions): Promise<LlmStructuredResult<T>> {
      seen.push({ prompt, options });
      return { value: schema.parse(value), usage: { model: "stub", inputTokens: 900, outputTokens: 60, costUsd: 0.001 }, raw: "" };
    },
  };
}

const agentCtx = { userId: "user-1", businessId: "biz-1", jobId: "job-1", language: "en", runId: "run-1", budget: createBudget(1) };

beforeEach(() => {
  images.fetchLlmImages.mockReset();
});
afterEach(() => setLlmProvider(null));

describe("the cass_builds post: the drafter sees the screenshot", () => {
  it("hands the post's image to the draft call as an image input", async () => {
    images.fetchLlmImages.mockResolvedValue([{ ok: true, image: PNG }]);
    const seen: Array<{ prompt: string; options?: LlmOptions }> = [];
    setLlmProvider(stubLlm({ variants: [{ variant: "short_comment", body: "those numbers are fine for week two.", linkUrl: null, claims: [] }] }, seen));

    const plan = draftImagePlan({ media: cassMedia, unread: false });
    expect(plan).toEqual({ images: [{ url: CASS_IMAGE, altText: null }], unseen: 0, inPost: 1 });

    const result = await placementDraftAgent.run(draftInput({ images: plan.images, unseenImages: plan.unseen }), agentCtx);
    expect(images.fetchLlmImages).toHaveBeenCalledWith([CASS_IMAGE], expect.anything());
    expect(seen[0].options?.images).toEqual([PNG]);
    expect(seen[0].prompt).toContain("The post includes 1 image, given to you with this prompt.");
    expect(seen[0].prompt).toContain(IMAGE_RULE);
    expect(result.output.images).toEqual({ seen: 1, failed: 0, failures: [] });
    // Seen: the check passes, as a note.
    const record = draftImagesRecord(plan, result.output.images);
    expect(record).toEqual({ inPost: 1, seen: 1, note: null });
    expect(placementDraftAgent.version).toBe(23);
  });

  it("says the rule in the words the owner asked for, with the poster's alt text", () => {
    const prompt = buildPlacementDraftPrompt(
      draftInput({ images: [{ url: CASS_IMAGE, altText: "Search Console: 1.2k impressions, 31 clicks" }] })
    );
    expect(prompt).toContain(
      "The post includes 1 image, given to you with this prompt. Read them: numbers, charts and screenshots are what the post is about. Answer what they show; never ask for what the image already shows."
    );
    expect(prompt).toContain('Image 1, alt text by the poster: "Search Console: 1.2k impressions, 31 clicks"');
    // A post without images has no such lines.
    expect(buildPlacementDraftPrompt(draftInput())).not.toContain("image");
  });

  it("drafts without an image that does not load, tells the model it cannot see it, and records why", async () => {
    images.fetchLlmImages.mockResolvedValue([{ ok: false, reason: "http", detail: "the image answered 403" }]);
    const seen: Array<{ prompt: string; options?: LlmOptions }> = [];
    setLlmProvider(stubLlm({ variants: [{ variant: "short_comment", body: "week two is early either way.", linkUrl: null, claims: [] }] }, seen));
    const plan = draftImagePlan({ media: cassMedia, unread: false });

    const result = await placementDraftAgent.run(draftInput({ images: plan.images }), agentCtx);
    expect(seen[0].options?.images).toEqual([]);
    expect(seen[0].prompt).not.toContain("The post includes");
    expect(seen[0].prompt).toContain("The post has an image you cannot see.");
    expect(seen[0].prompt).toContain("do not ask the poster for what it probably shows");
    expect(result.output.images).toEqual({ seen: 0, failed: 1, failures: ["the image answered 403"] });
    expect(draftImagesRecord(plan, result.output.images)).toEqual({
      inPost: 1,
      seen: 0,
      note: "1 image did not load: the image answered 403",
    });
  });

  it("hands the image to Fix it too", async () => {
    images.fetchLlmImages.mockResolvedValue([{ ok: true, image: PNG }]);
    const seen: Array<{ prompt: string; options?: LlmOptions }> = [];
    setLlmProvider(stubLlm({ body: "those numbers look normal for week two.", claims: [] }, seen));
    const input = DraftCorrectInput.parse({
      business: { name: "GetTrafficFast", site: "https://gettrafficfa.st" },
      thread: { surface: "x", kind: "post", title: CASS_TEXT, excerpt: CASS_TEXT },
      variant: "short_comment",
      draft: BAD_DRAFT,
      reason: "look at the screenshot, he shows the numbers",
      aboutYou: "I run a blog that gets about 9 impressions a week.",
      images: [{ url: CASS_IMAGE, altText: null }],
    });
    const result = await draftCorrectAgent.run(input, { ...agentCtx, budget: createBudget(0.05) });
    expect(seen[0].options?.images).toEqual([PNG]);
    expect(seen[0].prompt).toContain(IMAGE_RULE);
    expect(buildDraftCorrectPrompt(input)).toContain("The post includes 1 image");
    expect(result.output.images).toEqual({ seen: 1, failed: 0, failures: [] });
    expect(draftCorrectAgent.version).toBe(6);
  });
});

describe("an image the draft could not see", () => {
  const auditCtx = {
    thread: { surface: "x", kind: "post", title: CASS_TEXT, excerpt: CASS_TEXT },
    business: { name: "GetTrafficFast", domains: ["gettrafficfa.st"], brandNames: [] },
    angle: null,
    expertise: [],
    writer: { aboutYou: "I run a blog that gets about 9 impressions a week." },
  };

  it("fails the advisory check Image not read, without changing the verdict", () => {
    // Added by hand with the X API off: the embed showed a picture, nobody read it.
    const plan = draftImagePlan({ media: null, unread: true });
    expect(plan).toEqual({ images: [], unseen: 1, inPost: null });
    const record = draftImagesRecord(plan, { seen: 0, failed: 0, failures: [] });
    const base = auditDraft({ variant: "short_comment", body: BAD_DRAFT, linkUrl: null, claims: [] }, auditCtx);
    const audit = withImages(base, record);

    const check = audit.checks.find((c) => c.id === "image_not_read")!;
    expect(check).toMatchObject({ label: "Image not read", status: "fail", advisory: true });
    expect(check.detail.startsWith(IMAGE_NOT_READ_DETAIL)).toBe(true);
    expect(IMAGE_NOT_READ_DETAIL).toBe("This post has an image the draft could not see. Look at it before you post.");
    expect(isAdvisory(check)).toBe(true);
    expect(audit.status).toBe(base.status);
    expect(audit.images).toEqual({ inPost: null, seen: 0, note: "X did not hand over the post's images" });
  });

  it("adds no check for a post without images, and a pass for one the draft saw", () => {
    const base = auditDraft({ variant: "short_comment", body: "fine.", linkUrl: null, claims: [] }, auditCtx);
    expect(withImages(base, draftImagesRecord(draftImagePlan({ media: [], unread: false }), null))).toBe(base);
    const seen = withImages(base, { inPost: 1, seen: 1, note: null });
    expect(seen.checks.find((c) => c.id === "image_not_read")).toMatchObject({ status: "pass", detail: "The draft saw the post's image." });
  });

  it("shows the line under the post on the card, with the post's link", () => {
    const html = renderToStaticMarkup(
      <PostMedia target={{ url: "https://x.com/cass_builds/status/1", media: null, mediaUnread: true, drafts: [] }} />
    );
    expect(html).toContain(MEDIA_UNREAD_LINE);
    expect(MEDIA_UNREAD_LINE).toBe("Has an image the draft could not see");
    expect(html).toContain('href="https://x.com/cass_builds/status/1"');
    expect(html).toContain("Open post");
    // A draft whose image did not load says it too, whatever the row's flag.
    expect(
      showsUnreadImage({ mediaUnread: false, drafts: [{ audit: { checks: [{ id: "image_not_read", status: "fail" }] } }] })
    ).toBe(true);
    expect(showsUnreadImage({ mediaUnread: false, drafts: [] })).toBe(false);
  });

  it("shows the post's first image as a small lazy thumbnail with no referrer, and no line when it was read", () => {
    const html = renderToStaticMarkup(
      <PostMedia target={{ url: "https://x.com/cass_builds/status/1", media: cassMedia, mediaUnread: false, drafts: [] }} />
    );
    expect(html).toContain(`src="${CASS_IMAGE}"`);
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('referrerPolicy="no-referrer"');
    expect(html).toContain("max-h-[200px]");
    expect(html).toContain("rounded-lg");
    expect(html).toContain(`href="${CASS_IMAGE}"`);
    expect(html).not.toContain(MEDIA_UNREAD_LINE);
    expect(renderToStaticMarkup(<PostMedia target={{ url: "u", media: null, mediaUnread: null, drafts: [] }} />)).toBe("");
  });
});

describe("the media from X", () => {
  it("reads includes.media by the post's media keys: a photo, a video's still, a key X did not describe", () => {
    const { posts } = parseXPosts({
      data: [
        { id: "1", text: CASS_TEXT, author_id: "9", attachments: { media_keys: ["3_1", "7_2", "3_9"] } },
        { id: "2", text: "no media here" },
      ],
      includes: {
        users: [{ id: "9", username: "cass_builds" }],
        media: [
          { media_key: "3_1", type: "photo", url: CASS_IMAGE, alt_text: " traffic ", width: 1200, height: 675 },
          { media_key: "7_2", type: "video", preview_image_url: "https://pbs.twimg.com/ext_tw_video_thumb/2/pu/img/a.jpg" },
          { media_key: "3_bad", type: "photo", url: "http://169.254.169.254/latest" },
        ],
      },
    });
    expect(posts[0].media).toEqual([
      { type: "photo", url: CASS_IMAGE, previewUrl: null, altText: "traffic", width: 1200, height: 675 },
      { type: "video", url: null, previewUrl: "https://pbs.twimg.com/ext_tw_video_thumb/2/pu/img/a.jpg", altText: null, width: null, height: null },
    ]);
    expect(posts[0].mediaUndescribed).toBe(1);
    expect(posts[1]).toMatchObject({ media: [], mediaUndescribed: 0 });

    // Stored: a key X did not describe is media nobody read.
    expect(xPostMediaState(posts[0])).toEqual({ media: parseMedia(posts[0].media), unread: true });
    expect(xPostMediaState(posts[1])).toBeNull();
    // A video goes to the drafter as its still.
    expect(draftImagePlan(xPostMediaState(posts[0])!).images.map((i) => i.url)).toEqual([
      CASS_IMAGE,
      "https://pbs.twimg.com/ext_tw_video_thumb/2/pu/img/a.jpg",
    ]);
  });

  it("asks the search for the media in the same call", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const { XApiClient } = await import("@/lib/providers/x/api");
    const client = new XApiClient({ token: "t", fetchImpl: fetchImpl as unknown as typeof fetch, log: () => {} });
    await client.searchRecent({ query: "seo", maxResults: 10, startTime: new Date("2026-11-11T00:00:00Z") });
    await client.lookup(["123"], undefined, { media: true });
    const [search, lookup] = fetchImpl.mock.calls.map((call) => new URL(String((call as unknown[])[0])).searchParams);
    expect(search.get("expansions")).toBe("author_id,attachments.media_keys,referenced_tweets.id,referenced_tweets.id.author_id,referenced_tweets.id.attachments.media_keys");
    expect(search.get("media.fields")).toBe("type,url,preview_image_url,alt_text,width,height");
    expect(lookup.get("expansions")).toBe("author_id,attachments.media_keys");
    expect(lookup.get("media.fields")).toBe("type,url,preview_image_url,alt_text,width,height");
  });
});

describe("the embed shows that a post has media", () => {
  const embed = (link: string) =>
    `<blockquote class="twitter-tweet"><p lang="en" dir="ltr">${CASS_TEXT} <a href="https://t.co/AbC">${link}</a></p>&mdash; woo (@cass_builds) <a href="https://twitter.com/cass_builds/status/1855000000000000000">November 11, 2026</a></blockquote>`;

  it("finds a pic.twitter.com or pic.x.com link, and keeps it out of the text", () => {
    expect(embedHasMedia(embed("pic.twitter.com/AbC123"))).toBe(true);
    expect(embedHasMedia(embed("pic.x.com/AbC123"))).toBe(true);
    expect(embedHasMedia(embed("example.com/notes"))).toBe(false);
    const post = parseOembed({ html: embed("pic.twitter.com/AbC123"), author_url: "https://twitter.com/cass_builds" });
    expect(post).toMatchObject({ text: CASS_TEXT, hasMedia: true, handle: "cass_builds" });
  });
});

describe("the by-id read of a hand-added post, under the X cap", () => {
  const NOW = new Date("2026-11-11T15:00:00.000Z");
  let quiet: Array<ReturnType<typeof vi.spyOn>>;
  beforeEach(() => {
    quiet = [vi.spyOn(console, "log").mockImplementation(() => {}), vi.spyOn(console, "warn").mockImplementation(() => {}), vi.spyOn(console, "error").mockImplementation(() => {})];
  });
  afterEach(() => quiet.forEach((spy) => spy.mockRestore()));

  const withMedia = (id: string) =>
    xPost(id, { media: [{ type: "photo", url: CASS_IMAGE, previewUrl: null, altText: null, width: 1200, height: 675 }] });

  it("reads the media for about $0.005, reserved and settled in the ledger", async () => {
    const db = new LedgerFake();
    const { client, lookup } = fakeXClient({
      lookup: (ids) => ({ posts: ids.map(withMedia), missingIds: [], billedPosts: ids.length, costUsd: ids.length * X_LOOKUP_USD_PER_POST }),
    });
    const read = await readXPostMedia({ supabase: db as never, client, statusId: "1855", capUsd: 20, now: NOW });
    expect(lookup).toHaveBeenCalledWith(["1855"], undefined, { media: true, references: true });
    expect(read).toEqual({ state: { media: cassMedia, unread: false }, refusal: null, message: null });
    expect(db.spend("2026-11-01")).toMatchObject({ cost_usd: 0.005, calls: 1, posts: 1 });
  });

  it("does not call X at the cap, and records the media as unread", async () => {
    const db = new LedgerFake({ provider_spend: [{ provider: "x-api", month: "2026-11-01", cost_usd: 19.999, calls: 1, posts: 1 }] });
    const { client, lookup } = fakeXClient();
    const read = await readXPostMedia({ supabase: db as never, client, statusId: "1855", capUsd: 20, now: NOW });
    expect(lookup).not.toHaveBeenCalled();
    expect(read).toMatchObject({ state: { media: null, unread: true }, refusal: "cap" });
  });

  it("records the media as unread when the X API is off, without a ledger row", async () => {
    const db = new LedgerFake();
    const read = await readXPostMedia({ supabase: db as never, client: null as XApiClient | null, statusId: "1855", now: NOW });
    expect(read).toMatchObject({ state: { media: null, unread: true }, refusal: "disabled" });
    expect(db.tables.provider_spend).toEqual([]);
  });
});

describe("the provider layer takes images, for both providers", () => {
  it("sends Claude a base64 image block before the text", () => {
    expect(messageContent("p", undefined)).toBe("p");
    expect(messageContent("p", { images: [PNG] })).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: PNG.data } },
      { type: "text", text: "p" },
    ]);
    const body = requestBody("claude-sonnet-5-5", "p", { tier: "quality", images: [PNG] }, true) as { messages: Array<{ content: unknown }> };
    expect(Array.isArray(body.messages[0].content)).toBe(true);
  });

  it("sends Gemini an inlineData part before the text", () => {
    expect(contentParts("p", { images: [] })).toBe("p");
    expect(contentParts("p", { images: [PNG] })).toEqual([{ inlineData: { mimeType: "image/png", data: PNG.data } }, { text: "p" }]);
  });

  it("fetches an image as bytes, and says why when it cannot", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
    expect(sniffImageType(png)).toBe("image/png");
    const ok = await fetchLlmImage(CASS_IMAGE, { fetchImpl: async () => new Response(png, { status: 200 }) });
    expect(ok).toEqual({ ok: true, image: { mimeType: "image/png", data: Buffer.from(png).toString("base64") } });
    expect(await fetchLlmImage(CASS_IMAGE, { fetchImpl: async () => new Response("no", { status: 403 }) })).toEqual({
      ok: false,
      reason: "http",
      detail: "the image answered 403",
    });
    expect(await fetchLlmImage(CASS_IMAGE, { fetchImpl: async () => new Response("<html>", { status: 200 }) })).toMatchObject({
      ok: false,
      reason: "not_an_image",
    });
    const timeout = await fetchLlmImage(CASS_IMAGE, {
      timeoutMs: 5,
      fetchImpl: (_url, init) =>
        new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("t"), { name: "AbortError" })))),
    });
    expect(timeout).toMatchObject({ ok: false, reason: "timeout" });
  });
});
