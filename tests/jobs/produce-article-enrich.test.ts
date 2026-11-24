import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import type { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { JobRow } from "@/lib/jobs/types";
import { produceArticleWorkflow } from "@/lib/jobs/workflows/produce-article";
import { readSkipNotes } from "@/lib/media/skips";
import { setImageProvider } from "@/lib/providers/images/registry";
import { ImageProvider, ImageProviderError, ImageRequest } from "@/lib/providers/images/types";
import { setLlmProvider } from "@/lib/providers/llm/registry";
import type { LLMProvider, LlmStructuredResult, LlmTextResult } from "@/lib/providers/llm/types";
import { setVideoProvider } from "@/lib/providers/video/registry";
import { FakeSupabase } from "../support/fake-supabase";

/**
 * The enrich step when media cannot be produced. In production 16 articles
 * were published with no image because the image account could not pay, and
 * nothing said so. What is pinned here: the article is still written, the
 * reason is on its document for the owner and on the step output for the
 * operator, the operator is told once, and after a billing refusal the next
 * article does not call the provider (or pay for a brief) for an hour.
 */

const sentry = vi.hoisted(() => ({ messages: [] as string[] }));
vi.mock("@sentry/nextjs", () => ({
  captureMessage: (message: string) => {
    sentry.messages.push(message);
  },
  captureException: () => {},
}));

const emails = vi.hoisted(() => ({ sent: [] as Array<{ to: string; subject: string }> }));
vi.mock("@/lib/notifications/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notifications/email")>()),
  operatorEmailAddress: () => "operator@example.test",
  sendNotificationEmail: async (input: { to: string; subject: string }) => {
    emails.sent.push(input);
    return true;
  },
}));

const usage = { model: "stub", inputTokens: 50, outputTokens: 100, costUsd: 0.001 };

const HERO = {
  scene: "A baker sliding a tray of loaves into a stone oven in a small bakery at dawn",
  alt: "A baker sliding loaves into a stone oven",
  caption: null,
};
const INLINE = {
  scene: "Hands shaping a round of dough on a floured wooden counter",
  alt: "Hands shaping dough on a floured counter",
  caption: null,
  headingId: "one",
};

function llm(plan: unknown): { provider: LLMProvider; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    provider: {
      name: "stub",
      async generateText(): Promise<LlmTextResult> {
        return { text: "", usage };
      },
      async generateStructured<T>(_prompt: string, schema: z.ZodType<T>): Promise<LlmStructuredResult<T>> {
        calls += 1;
        return { value: schema.parse(plan), usage, raw: "" };
      },
    },
  };
}

async function picture(): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({ create: { width: 1920, height: 1080, channels: 3, background: "#884422" } }).jpeg().toBuffer()
  );
}

function imageProvider(generate: (request: ImageRequest, call: number) => Promise<Uint8Array>) {
  const requests: ImageRequest[] = [];
  const provider: ImageProvider = {
    name: "imagen",
    async generate(request) {
      requests.push(request);
      const bytes = await generate(request, requests.length);
      return { bytes, mimeType: "image/jpeg", provider: "imagen", model: "some-image-model", costUsd: 0.039 };
    },
  };
  return { provider, requests };
}

const refuse402 = async (): Promise<Uint8Array> => {
  throw new ImageProviderError(
    'Image generation failed — some-image-model (402): {"error":{"message":"Your prepayment credits are depleted."}}',
    "imagen",
    undefined,
    { status: 402 }
  );
};

const BODY =
  '<p>Intro.</p><h2 id="one">Shaping</h2><p>Shape the dough by hand.</p>' +
  '<h2 id="two">Baking</h2><p>Bake it hot.</p>' +
  '<h2 id="three">Cooling</h2><p>Let it rest.</p><h2 id="four">Storing</h2><p>Keep it dry.</p>';

function canonical(articleId: string) {
  return {
    schemaVersion: 1,
    articleId,
    title: "How to bake sourdough",
    bodyHtml: BODY,
    headings: ["one", "two", "three", "four"].map((id) => ({ level: 2, id, text: id })),
    excerpt: "Intro.",
    metaDescription: "Intro.",
    wordCount: 20,
    slug: "how-to-bake-sourdough",
    keyword: "sourdough",
    language: "en",
    scheduledDate: null,
  };
}

function article(id: string) {
  return {
    id,
    user_id: "user-1",
    business_id: "biz-1",
    keyword_id: "kw-1",
    scheduled_date: "2026-11-10",
    status: "generating",
    keywords: { keyword: "sourdough" },
    canonical: canonical(id),
  };
}

function job(articleId: string): JobRow {
  return {
    id: `job-${articleId}`,
    user_id: "user-1",
    article_id: articleId,
    type: "produce-article",
    input: { articleId },
    status: "running",
    current_step: "enrich",
    attempts: 1,
    max_attempts: 3,
    last_error: null,
  };
}

const enrich = produceArticleWorkflow.steps.find((step) => step.name === "enrich")!;

describe("produce-article enrich", () => {
  let db: FakeSupabase;
  let uploads: string[];

  function seed(mediaSettings: Record<string, unknown>) {
    uploads = [];
    db = new FakeSupabase({
      articles: [article("article-1"), article("article-2")],
      businesses: [
        {
          id: "biz-1",
          name: "Crumb",
          niche: "Bakery",
          description: "A neighbourhood sourdough bakery",
          website_url: "https://crumb.example",
          content_language: "en",
          media_settings: mediaSettings,
        },
      ],
      media_assets: [],
      provider_pauses: [],
      operator_alerts: [],
    });
    (db as unknown as { storage: unknown }).storage = {
      from: () => ({
        upload: async (path: string) => {
          uploads.push(path);
          return { error: null };
        },
        getPublicUrl: (path: string) => ({ data: { publicUrl: `https://storage.example.com/${path}` } }),
      }),
    };
  }

  const run = (articleId: string) =>
    enrich.run({
      job: job(articleId),
      supabase: db as unknown as SupabaseClient,
      input: { articleId },
      outputs: {},
    }) as Promise<Record<string, unknown>>;

  const stored = (articleId: string) =>
    db.tables.articles.find((a) => a.id === articleId)!.canonical as {
      bodyHtml: string;
      media?: { hero: Record<string, unknown> | null; images: unknown[]; videos: unknown[] };
    };

  beforeEach(() => {
    sentry.messages.length = 0;
    emails.sent.length = 0;
    setVideoProvider(null);
    // The deployment has opted in to images (lib/providers/images/registry.ts).
    vi.stubEnv("IMAGES_ENABLED", "1");
  });

  afterEach(() => {
    setLlmProvider(null);
    setImageProvider("imagen", null);
    setVideoProvider(undefined);
    vi.unstubAllEnvs();
  });

  it("renders the hero only by default, as WebP with its size in the markup data", async () => {
    seed({ imagesEnabled: true, videosEnabled: false });
    // The model offers an in-article image anyway; the default cap is zero.
    const model = llm({ subject: "physical", hero: HERO, inline: [INLINE] });
    setLlmProvider(model.provider);
    const images = imageProvider(() => picture());
    setImageProvider("imagen", images.provider);

    const output = await run("article-1");

    expect(images.requests).toHaveLength(1);
    expect(output).toMatchObject({ hero: true, inline: 0, videos: 0, skips: [] });
    expect(uploads).toEqual(["user-1/article-1/hero.webp"]);

    const doc = stored("article-1");
    expect(doc.media?.hero).toMatchObject({
      url: "https://storage.example.com/user-1/article-1/hero.webp",
      alt: HERO.alt,
      width: 1600,
      height: 900,
    });
    expect(doc.media?.images).toEqual([]);
    expect(doc.bodyHtml).not.toContain("<figure");
    expect(readSkipNotes(doc)).toEqual([]);
    expect(db.tables.media_assets[0]).toMatchObject({ kind: "hero", width: 1600, height: 900 });
    // A physical business set to photography gets a photograph.
    expect(images.requests[0].prompt).toContain("Realistic professional photograph");
  });

  it("renders in-article images when the business set a cap, with width and height on the figure", async () => {
    seed({ imagesEnabled: true, videosEnabled: false, inlineImagesPerArticle: 2 });
    setLlmProvider(llm({ subject: "physical", hero: HERO, inline: [INLINE] }).provider);
    const images = imageProvider(() => picture());
    setImageProvider("imagen", images.provider);

    const output = await run("article-1");

    expect(output).toMatchObject({ hero: true, inline: 1 });
    expect(uploads).toEqual(["user-1/article-1/hero.webp", "user-1/article-1/inline-0.webp"]);
    expect(stored("article-1").bodyHtml).toContain(
      '<figure><img src="https://storage.example.com/user-1/article-1/inline-0.webp" alt="Hands shaping dough on a floured counter" width="1600" height="900" loading="lazy"'
    );
  });

  it("gives a business with nothing physical an editorial illustration, not a photograph", async () => {
    seed({ imagesEnabled: true, videosEnabled: false, style: "photographic" });
    setLlmProvider(llm({ subject: "digital", hero: HERO, inline: [] }).provider);
    const images = imageProvider(() => picture());
    setImageProvider("imagen", images.provider);

    await run("article-1");

    expect(images.requests[0].prompt).toContain("Clean editorial illustration");
    expect(images.requests[0].prompt).not.toContain("Realistic professional photograph");
  });

  it("on a billing refusal: the article keeps going, the owner and the operator are told, images pause", async () => {
    seed({ imagesEnabled: true, videosEnabled: false, inlineImagesPerArticle: 2 });
    const model = llm({ subject: "physical", hero: HERO, inline: [INLINE] });
    setLlmProvider(model.provider);
    const images = imageProvider(refuse402);
    setImageProvider("imagen", images.provider);

    // It does not throw: media never fails an article.
    const output = await run("article-1");

    // One refused call, not one per planned image.
    expect(images.requests).toHaveLength(1);
    expect(output).toMatchObject({ hero: false, inline: 0 });
    expect(output.skips).toEqual([
      expect.objectContaining({ media: "images", reason: "billing", count: 2 }),
    ]);
    expect(JSON.stringify(output.skips)).toContain("prepayment credits are depleted");

    // The owner's note is on the document the calendar already loads, in our words.
    const notes = readSkipNotes(stored("article-1"));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ media: "images", reason: "billing", count: 2 });
    expect(notes[0].message).toContain("Images were not generated");
    expect(JSON.stringify(stored("article-1").media)).not.toContain("prepayment");

    // The operator hears once.
    expect(sentry.messages).toEqual(["Image generation refused: the image account cannot pay"]);
    expect(emails.sent).toHaveLength(1);

    // The pause: the next article pays for no brief and makes no call.
    expect(db.tables.provider_pauses).toHaveLength(1);
    expect(db.tables.provider_pauses[0].kind).toBe("image");
    const briefsBefore = model.calls();

    const second = await run("article-2");

    expect(images.requests).toHaveLength(1);
    expect(model.calls()).toBe(briefsBefore);
    expect(second.skips).toEqual([expect.objectContaining({ media: "images", reason: "paused" })]);
    expect(readSkipNotes(stored("article-2"))[0].message).toContain("on hold for up to an hour");
    // Still one alert: the pause is the refusal's consequence, not a new fault.
    expect(sentry.messages).toHaveLength(1);
    expect(emails.sent).toHaveLength(1);
  });

  it("keeps the images that rendered when a later one fails for another reason", async () => {
    seed({ imagesEnabled: true, videosEnabled: false, inlineImagesPerArticle: 2 });
    setLlmProvider(llm({ subject: "physical", hero: HERO, inline: [INLINE] }).provider);
    const images = imageProvider(async (_request, call) => {
      if (call === 2) throw new ImageProviderError("some-image-model returned no image: safety", "imagen");
      return picture();
    });
    setImageProvider("imagen", images.provider);

    const output = await run("article-1");

    expect(output).toMatchObject({ hero: true, inline: 0 });
    expect(output.skips).toEqual([expect.objectContaining({ media: "images", reason: "provider_error", count: 1 })]);
    expect(db.tables.provider_pauses).toHaveLength(0);
    expect(stored("article-1").media?.hero).not.toBeNull();
    expect(readSkipNotes(stored("article-1"))[0].reason).toBe("provider_error");
  });

  it("does not render a scene the check refused twice, and says which", async () => {
    seed({ imagesEnabled: true, videosEnabled: false });
    setLlmProvider(
      llm({
        subject: "digital",
        hero: {
          scene: "A futuristic, holographic sourdough loaf projected from a stylized, glowing AI brain",
          alt: "Abstract representation of scheduling",
          caption: null,
        },
        inline: [],
      }).provider
    );
    const images = imageProvider(() => picture());
    setImageProvider("imagen", images.provider);

    const output = await run("article-1");

    // Nothing was paid to an image provider for it.
    expect(images.requests).toHaveLength(0);
    expect(output.skips).toEqual([expect.objectContaining({ media: "images", reason: "brief_rejected" })]);
    expect(readSkipNotes(stored("article-1"))[0].message).toContain("no concrete, photographable scene");
    // A refused scene is not the operator's problem.
    expect(sentry.messages).toHaveLength(0);
  });

  it("says videos were skipped because no provider is configured, once to the operator", async () => {
    seed({ imagesEnabled: false, videosEnabled: true });

    const first = await run("article-1");
    const second = await run("article-2");

    for (const output of [first, second]) {
      expect(output.skips).toEqual([expect.objectContaining({ media: "videos", reason: "not_configured" })]);
    }
    expect(readSkipNotes(stored("article-1"))[0]).toMatchObject({ media: "videos", reason: "not_configured" });
    expect(stored("article-1").media).toMatchObject({ hero: null, images: [], videos: [] });
    expect(sentry.messages).toEqual(["Video search is not configured, and businesses have videos turned on"]);
    expect(emails.sent).toHaveLength(1);
  });

  it("does nothing, and reports nothing, when the site turned media off", async () => {
    seed({ imagesEnabled: false, videosEnabled: false });
    expect(await run("article-1")).toEqual({ skipped: "media disabled for this business" });
    expect(stored("article-1").media).toBeUndefined();
    expect(sentry.messages).toHaveLength(0);
  });

  it("renders the featured image for a site with nothing stored: images are on by default since 2026-11-24", async () => {
    seed({});
    setLlmProvider(llm({ subject: "physical", hero: HERO, inline: [] }).provider);
    const images = imageProvider(() => picture());
    setImageProvider("imagen", images.provider);
    const out = (await run("article-1")) as { hero?: boolean; skipped?: string };
    expect(out.skipped).toBeUndefined();
    expect(out.hero).toBe(true);
    expect(images.requests).toHaveLength(1);
  });
});
