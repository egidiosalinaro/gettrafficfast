import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  IMAGE_PAUSE_KIND,
  IMAGE_PAUSE_MS,
  alertMediaSkips,
  imagePausedUntil,
  mediaAlertKey,
  pauseImages,
} from "@/lib/media/degradation";
import { LLM_PAUSE_KIND, llmPausedUntil } from "@/lib/llm-billing";
import {
  MediaSkip,
  mediaSkipMessage,
  mergeSkips,
  needsOperator,
  readSkipNotes,
  toSkipNotes,
} from "@/lib/media/skips";
import { ImageProviderError, imageFailureKind } from "@/lib/providers/images/types";
import { FakeSupabase } from "../support/fake-supabase";

/**
 * Media that could not be produced is recorded with a reason, the owner gets
 * a sentence of ours, and the operator hears once a day per reason however
 * many articles run into it. A billing refusal holds images, and only
 * images, for an hour.
 */

const sentry = vi.hoisted(() => ({ messages: [] as Array<{ message: string; options: Record<string, unknown> }> }));
vi.mock("@sentry/nextjs", () => ({
  captureMessage: (message: string, options: Record<string, unknown>) => {
    sentry.messages.push({ message, options });
  },
  captureException: () => {},
}));

const emails = vi.hoisted(() => ({ sent: [] as Array<{ to: string; subject: string; html: string }> }));
vi.mock("@/lib/notifications/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notifications/email")>()),
  operatorEmailAddress: () => "operator@example.test",
  sendNotificationEmail: async (input: { to: string; subject: string; html: string }) => {
    emails.sent.push(input);
    return true;
  },
}));

const VENDOR_402 =
  'Image generation failed — some-image-model (402): {"error":{"message":"Your prepayment credits are depleted."}}';

const billing: MediaSkip = { media: "images", reason: "billing", count: 2, detail: VENDOR_402 };
const noVideo: MediaSkip = { media: "videos", reason: "not_configured", count: 1, detail: "no video provider configured" };

let db: FakeSupabase;
const supabase = () => db as unknown as SupabaseClient;

beforeEach(() => {
  sentry.messages.length = 0;
  emails.sent.length = 0;
  db = new FakeSupabase({ provider_pauses: [], operator_alerts: [] });
});

describe("what kind of image failure it is", () => {
  it("a 402 is billing, whatever the body says", () => {
    expect(imageFailureKind(new ImageProviderError("refused (402)", "imagen", undefined, { status: 402 }))).toBe("billing");
  });

  it("a depleted balance reported under another status is billing too", () => {
    const err = new ImageProviderError(
      "Image generation failed — m (429): Your prepayment credits are depleted",
      "imagen",
      undefined,
      { status: 429 }
    );
    expect(imageFailureKind(err)).toBe("billing");
    expect(
      imageFailureKind(new ImageProviderError("request failed (400): billing_hard_limit_reached", "openai", undefined, { status: 400 }))
    ).toBe("billing");
  });

  it("a missing key is not configured, and anything else is an error", () => {
    expect(imageFailureKind(new ImageProviderError("KEY is not set", "imagen", undefined, { notConfigured: true }))).toBe(
      "not_configured"
    );
    expect(imageFailureKind(new ImageProviderError("m returned no image: safety", "imagen"))).toBe("error");
    expect(imageFailureKind(new ImageProviderError("rate limited (429): slow down", "imagen", undefined, { status: 429 }))).toBe(
      "error"
    );
    expect(imageFailureKind(new Error("socket hang up"))).toBe("error");
  });
});

describe("the image pause", () => {
  const now = new Date("2026-11-10T10:00:00Z");

  it("holds images for an hour after a billing refusal, then lets the next article try", async () => {
    expect(await imagePausedUntil(supabase(), now)).toBeNull();

    const until = await pauseImages(supabase(), { provider: "imagen", detail: VENDOR_402 }, now);
    expect(until.getTime() - now.getTime()).toBe(IMAGE_PAUSE_MS);
    expect(IMAGE_PAUSE_MS).toBe(60 * 60 * 1000);

    expect((await imagePausedUntil(supabase(), new Date("2026-11-10T10:59:00Z")))?.toISOString()).toBe(until.toISOString());
    expect(await imagePausedUntil(supabase(), new Date("2026-11-10T11:00:01Z"))).toBeNull();
  });

  it("is one row, renewed in place by the next refusal", async () => {
    await pauseImages(supabase(), { provider: "imagen", detail: VENDOR_402 }, now);
    await pauseImages(supabase(), { provider: "imagen", detail: VENDOR_402 }, new Date("2026-11-10T10:30:00Z"));
    expect(db.tables.provider_pauses).toHaveLength(1);
    expect(db.tables.provider_pauses[0].kind).toBe(IMAGE_PAUSE_KIND);
    expect(db.tables.provider_pauses[0].paused_until).toBe("2026-11-10T11:30:00.000Z");
  });

  it("does not pause the writing: the LLM pause is a different row", async () => {
    await pauseImages(supabase(), { provider: "imagen", detail: VENDOR_402 }, now);
    expect(IMAGE_PAUSE_KIND).not.toBe(LLM_PAUSE_KIND);
    expect(await llmPausedUntil(supabase(), now)).toBeNull();
  });

  it("reads as no pause when the table cannot be read", async () => {
    const broken = {
      from: () => {
        throw new Error("relation does not exist");
      },
    } as unknown as SupabaseClient;
    expect(await imagePausedUntil(broken, now)).toBeNull();
  });
});

describe("operator alerts", () => {
  const context = { articleId: "article-1", jobId: "job-1", businessId: "biz-1" };

  it("alerts once per reason per day, however many articles hit it", async () => {
    const morning = new Date("2026-11-10T08:00:00Z");
    const first = await alertMediaSkips(supabase(), [billing, noVideo], context, morning);
    expect(first).toEqual(["media:images:billing", "media:videos:not_configured"]);
    expect(sentry.messages).toHaveLength(2);
    expect(emails.sent).toHaveLength(2);

    // Sixteen more articles the same day: nothing new is sent.
    for (let i = 0; i < 16; i += 1) {
      const again = await alertMediaSkips(
        supabase(),
        [billing, noVideo],
        { ...context, articleId: `article-${i + 2}` },
        new Date("2026-11-10T18:00:00Z")
      );
      expect(again).toEqual([]);
    }
    expect(sentry.messages).toHaveLength(2);
    expect(emails.sent).toHaveLength(2);
    expect(db.tables.operator_alerts.map((r) => [r.alert_key, r.day])).toEqual([
      ["media:images:billing", "2026-11-10"],
      ["media:videos:not_configured", "2026-11-10"],
    ]);
  });

  it("alerts again the next day", async () => {
    await alertMediaSkips(supabase(), [billing], context, new Date("2026-11-10T08:00:00Z"));
    const next = await alertMediaSkips(supabase(), [billing], context, new Date("2026-11-11T00:00:01Z"));
    expect(next).toEqual(["media:images:billing"]);
    expect(emails.sent).toHaveLength(2);
  });

  it("says what is wrong and carries the vendor's message to the operator", async () => {
    await alertMediaSkips(supabase(), [billing], context, new Date("2026-11-10T08:00:00Z"));
    expect(sentry.messages[0].message).toBe("Image generation refused: the image account cannot pay");
    expect(sentry.messages[0].options).toMatchObject({
      level: "fatal",
      fingerprint: ["media-degraded", "images", "billing"],
    });
    expect(emails.sent[0].to).toBe("operator@example.test");
    expect(emails.sent[0].subject).toContain("the image account cannot pay");
    expect(emails.sent[0].html).toContain("prepayment credits are depleted");
  });

  it("one alert for the same reason twice in one article", async () => {
    await alertMediaSkips(supabase(), [billing, { ...billing, count: 1 }], context, new Date("2026-11-10T08:00:00Z"));
    expect(emails.sent).toHaveLength(1);
  });

  it("does not alert for a scene that was refused: that is an outcome, not a fault", async () => {
    const rejected: MediaSkip = { media: "images", reason: "brief_rejected", count: 1, detail: "hero: glowing" };
    const paused: MediaSkip = { media: "images", reason: "paused", count: 1, detail: "paused until …" };
    expect(await alertMediaSkips(supabase(), [rejected, paused], context)).toEqual([]);
    expect(sentry.messages).toHaveLength(0);
    expect(needsOperator("brief_rejected")).toBe(false);
    // The pause was already alerted on by the refusal that started it.
    expect(needsOperator("paused")).toBe(false);
  });

  it("does not alert for no image style chosen: the person's to do, said on the article in their words", async () => {
    const noStyle: MediaSkip = { media: "images", reason: "no_style", count: 1, detail: "no image style chosen yet" };
    expect(await alertMediaSkips(supabase(), [noStyle], context)).toEqual([]);
    expect(sentry.messages).toHaveLength(0);
    expect(needsOperator("no_style")).toBe(false);
    expect(mediaSkipMessage(noStyle)).toContain("no image style chosen yet");
  });

  it("keeps Sentry and drops the email when the dedupe table cannot be written", async () => {
    const broken = {
      from: () => ({
        upsert: () => ({ select: async () => ({ data: null, error: { message: "relation does not exist" } }) }),
      }),
    } as unknown as SupabaseClient;
    const alerted = await alertMediaSkips(broken, [billing], context, new Date("2026-11-10T08:00:00Z"));
    expect(alerted).toEqual(["media:images:billing"]);
    expect(sentry.messages).toHaveLength(1);
    // Without the dedupe every article would send one.
    expect(emails.sent).toHaveLength(0);
  });

  it("keys each reason on its own", () => {
    expect(mediaAlertKey(billing)).toBe("media:images:billing");
    expect(mediaAlertKey(noVideo)).toBe("media:videos:not_configured");
  });
});

describe("what the owner is told", () => {
  it("is a sentence of ours, never the vendor's message", () => {
    const notes = toSkipNotes([billing, { ...billing, count: 1 }, noVideo]);
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatchObject({ media: "images", reason: "billing", count: 3 });
    expect(notes[0].message).toBe(mediaSkipMessage(billing));
    for (const note of notes) {
      expect(JSON.stringify(note)).not.toContain("prepayment");
      expect(JSON.stringify(note)).not.toContain("402");
      expect(note).not.toHaveProperty("detail");
    }
    expect(notes[0].message).toContain("on our side");
    expect(notes[1].message).toContain("not available on the platform right now");
  });

  it("merges by media and reason and keeps the counts", () => {
    const merged = mergeSkips([billing, { ...billing, count: 1 }, noVideo]);
    expect(merged.map((s) => [s.media, s.reason, s.count])).toEqual([
      ["images", "billing", 3],
      ["videos", "not_configured", 1],
    ]);
    // The inputs are not mutated.
    expect(billing.count).toBe(2);
  });

  it("reads the notes back from a stored document, and nothing from one without them", () => {
    const notes = toSkipNotes([billing]);
    expect(readSkipNotes({ media: { hero: null, images: [], videos: [], skipped: notes } })).toEqual(notes);
    expect(readSkipNotes({ media: { hero: null, images: [], videos: [] } })).toEqual([]);
    expect(readSkipNotes({})).toEqual([]);
    expect(readSkipNotes(null)).toEqual([]);
    expect(readSkipNotes({ media: { skipped: [{ nonsense: true }, "x"] } })).toEqual([]);
  });
});
