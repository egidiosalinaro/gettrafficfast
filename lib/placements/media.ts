import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { IMAGE_NOT_READ, type AuditCheck, type AuditResult } from "./audit";

/**
 * A post's images, and whether the drafter saw them.
 *
 * On 11 November 2026 @cass_builds posted on X: "hi guys, are these numbers normal for a
 * twelve day old site with a brand new domain? asking for a friend", with a
 * screenshot of the numbers. The question was about the screenshot. The
 * draft could not see it and answered blind: "two weeks is really early for
 * a new domain… what kind of traffic are you seeing so far?", asking for
 * what the picture already showed.
 *
 * So a post's media are stored on its row (`placement_targets.media`, a
 * JSON list, and `media_unread`), up to two images go to the drafter with
 * the prompt, and when the drafter could not see an image the post has, the
 * draft says so: an advisory check, and a quiet line on the card. Never
 * pretend: an image nobody read is recorded as unread, not as absent.
 *
 *   media        null: never asked (a row stored before 11 November 2026, a
 *                surface other than X, a post whose oEmbed showed no media).
 *                []: asked, none. A list: what X described.
 *   media_unread true: the post has media that could not be read (the X API
 *                off or capped, X not describing a key). false: whatever the
 *                post has was read. null: not known.
 */

/** Images handed to the drafter per call: enough for a screenshot and its sequel, bounded in tokens. */
export const MAX_DRAFT_IMAGES = 2;

/** The card's line under a post whose image the draft could not see. */
export const MEDIA_UNREAD_LINE = "Has an image the draft could not see";

export const PostMediaItem = z.object({
  /** "photo", "video", "animated_gif", as X names them. */
  type: z.string().min(1).max(40),
  /** A photo's own image. */
  url: z.string().url().nullable(),
  /** A video's or a GIF's still. */
  previewUrl: z.string().url().nullable(),
  altText: z.string().max(1_000).nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
});
export type PostMediaItem = z.infer<typeof PostMediaItem>;

/** What is stored about a post's media. */
export interface PostMediaState {
  media: PostMediaItem[] | null;
  unread: boolean | null;
}

/** A stored `media` value as a list; null when it is not one (never asked, or not readable). Bad items are dropped. */
export function parseMedia(raw: unknown): PostMediaItem[] | null {
  if (!Array.isArray(raw)) return null;
  const out: PostMediaItem[] = [];
  for (const item of raw) {
    const parsed = PostMediaItem.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/** The image a model or a person looks at for one item: a photo itself, a video's or a GIF's still. */
export function imageUrlOf(item: Pick<PostMediaItem, "type" | "url" | "previewUrl">): string | null {
  return item.type === "photo" ? (item.url ?? item.previewUrl) : (item.previewUrl ?? item.url);
}

/** The post's media as the provider described them, as stored. */
export function mediaFromProvider(
  items: ReadonlyArray<{ type: string; url: string | null; previewUrl: string | null; altText: string | null; width: number | null; height: number | null }>
): PostMediaItem[] {
  return parseMedia(items.map((m) => ({ ...m, type: m.type.slice(0, 40) }))) ?? [];
}

/** The images a draft call is handed: the first MAX_DRAFT_IMAGES that have one. */
export function draftImageInputs(media: readonly PostMediaItem[] | null): Array<{ url: string; altText: string | null }> {
  const out: Array<{ url: string; altText: string | null }> = [];
  for (const item of media ?? []) {
    const url = imageUrlOf(item);
    if (!url) continue;
    out.push({ url, altText: item.altText });
    if (out.length >= MAX_DRAFT_IMAGES) break;
  }
  return out;
}

/** True when the post is known to carry media: described, or seen in the embed and not read. */
export function hasPostMedia(state: PostMediaState): boolean {
  return state.unread === true || (state.media?.length ?? 0) > 0;
}

/**
 * The images a draft call is handed, and how many of the post's it cannot
 * be handed (no image URL, past the cap, or never read): what the prompt
 * says it cannot see.
 */
export function draftImagePlan(state: PostMediaState): {
  images: Array<{ url: string; altText: string | null }>;
  /** Images the post has that the call is not handed; at least 1 when media is unread. */
  unseen: number;
  /** How many the post has; null when it has media nobody could count. */
  inPost: number | null;
} {
  const images = draftImageInputs(state.media);
  const known = state.media?.length ?? 0;
  if (state.unread === true) return { images, unseen: Math.max(1, known - images.length), inPost: null };
  return { images, unseen: known - images.length, inPost: known };
}

// ── On the draft ────────────────────────────────────────────────────────────

/**
 * What the drafter saw of the post's images, kept beside the draft's audit
 * like the reading: how many the post has (null: some, uncounted), how many
 * the model was handed, and why the rest were not, in a sentence.
 */
export const DraftImages = z.object({
  inPost: z.number().int().min(0).nullable(),
  seen: z.number().int().min(0),
  note: z.string().max(400).nullable(),
});
export type DraftImages = z.infer<typeof DraftImages>;

export function parseDraftImages(raw: unknown): DraftImages | null {
  const parsed = DraftImages.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** True when the post has an image the drafter did not see. */
export function imagesUnseen(images: DraftImages): boolean {
  return images.inPost === null || images.seen < images.inPost;
}

export const IMAGE_NOT_READ_DETAIL = "This post has an image the draft could not see. Look at it before you post.";

/** The advisory check for a post with images; null for a post without. */
export function imageCheck(images: DraftImages | null): AuditCheck | null {
  if (!images || images.inPost === 0) return null;
  const unseen = imagesUnseen(images);
  return {
    id: IMAGE_NOT_READ,
    label: "Image not read",
    status: unseen ? "fail" : "pass",
    detail: unseen
      ? `${IMAGE_NOT_READ_DETAIL}${images.note ? ` (${images.note})` : ""}`
      : images.seen === 1
        ? "The draft saw the post's image."
        : `The draft saw the post's ${images.seen} images.`,
    advisory: true,
  };
}

/**
 * The audit with what the drafter saw of the images beside it, and the
 * advisory check that says so. Advisory: the verdict is unchanged (an image
 * nobody read is not a fault of the text), and the draft loop never asks a
 * rewrite to fix it. Unchanged when the post has no image.
 */
export function withImages(audit: AuditResult, images: DraftImages | null | undefined): AuditResult {
  const check = imageCheck(images ?? null);
  if (!images || !check) return audit;
  const checks = [...audit.checks.filter((c) => c.id !== IMAGE_NOT_READ), check];
  return { ...audit, images, checks };
}

/** True when the card says the draft did not see the post's image: the row's flag, or a draft's check. */
export function showsUnreadImage(target: {
  mediaUnread?: boolean | null;
  drafts: ReadonlyArray<{ audit: { checks: ReadonlyArray<Pick<AuditCheck, "id" | "status">> } }>;
}): boolean {
  if (target.mediaUnread === true) return true;
  return target.drafts.some((draft) => draft.audit.checks.some((c) => c.id === IMAGE_NOT_READ && c.status !== "pass"));
}

// ── The columns ─────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

/**
 * The media of a site's rows, by target id; null when the columns cannot be
 * read. Read apart from `TARGET_COLUMNS`, like `ai_citation`: the columns
 * arrive with migration 20261111140000, and a select naming a column the
 * database does not have yet fails whole. Until then a failed read costs the
 * thumbnail and the line, nothing else. Only rows with something recorded.
 */
export async function loadMedia(
  supabase: SupabaseClient,
  businessId: string,
  ids: readonly string[]
): Promise<Map<string, PostMediaState> | null> {
  if (ids.length === 0) return new Map();
  const { data, error } = await supabase
    .from("placement_targets")
    .select("id, media, media_unread")
    .eq("business_id", businessId)
    .in("id", [...ids]);
  if (error) return null;
  const out = new Map<string, PostMediaState>();
  for (const row of (data ?? []) as Row[]) {
    const media = parseMedia(row.media);
    const unread = typeof row.media_unread === "boolean" ? row.media_unread : null;
    if (media === null && unread === null) continue;
    out.set(row.id as string, { media, unread });
  }
  return out;
}

/** A target row with its media on it, as `mapTarget` reads them; unchanged when they could not be read. */
export function withMedia(row: Row, media: Map<string, PostMediaState> | null): Row {
  if (!media) return row;
  const state = media.get(row.id as string);
  return { ...row, media: state?.media ?? null, media_unread: state?.unread ?? null };
}

/**
 * Records a post's media on its row. A database without the columns yet
 * refuses it, and that is logged and nothing else: the media are a help to
 * the drafter, never a reason to lose the post.
 */
export async function saveTargetMedia(
  supabase: SupabaseClient,
  where: { businessId: string; id?: string; externalId?: string; surface?: string },
  state: PostMediaState
): Promise<boolean> {
  let query = supabase
    .from("placement_targets")
    .update({ media: state.media, media_unread: state.unread })
    .eq("business_id", where.businessId);
  if (where.id) query = query.eq("id", where.id);
  else if (where.externalId) query = query.eq("external_id", where.externalId).eq("surface", where.surface ?? "x");
  else return false;
  const { error } = await query;
  if (error) {
    console.warn(JSON.stringify({ level: "warn", event: "placement.media_not_saved", error: error.message.slice(0, 300) }));
    return false;
  }
  return true;
}

// ── What the writer is told ─────────────────────────────────────────────────

/** Whose image a writer is handed: the post's own, or the quoted post's (lib/placements/referenced.ts). */
export type DraftImageSource = "post" | "quoted";

/** One image a writer (the drafter, Fix it) is handed with its prompt. */
export const DraftImageInput = z.object({
  url: z.string().url(),
  altText: z.string().max(1_000).nullable(),
  from: z.enum(["post", "quoted"]).default("post"),
});
export type DraftImageInput = z.infer<typeof DraftImageInput>;

/** The rule both writers (the drafter and Fix it) read when the post has images. */
export const IMAGE_RULE =
  "Read them: numbers, charts and screenshots are what the post is about. Answer what they show; never ask for what the image already shows.";

/**
 * The prompt's lines about the post's images, or null for a post with none.
 * `seen` are the images handed with the prompt, in order, with their alt
 * text; `unseen` the ones the writer cannot see, which it must neither
 * describe nor ask the poster about.
 */
export function postImagesRule(seen: ReadonlyArray<{ altText: string | null; from?: DraftImageSource }>, unseen: number): string | null {
  const lines: string[] = [];
  // The post's own images come first; the quoted post's (2026-11-14) after
  // them, in the slots the post's own leave free.
  const own = seen.filter((image) => image.from !== "quoted");
  const quotedCount = seen.length - own.length;
  if (own.length > 0) {
    lines.push(`The post includes ${own.length} image${own.length === 1 ? "" : "s"}, given to you with this prompt. ${IMAGE_RULE}`);
  }
  if (quotedCount > 0) {
    lines.push(
      `${quotedCount === 1 ? `Image ${own.length + 1} is` : `Images ${own.length + 1} to ${seen.length} are`} the quoted post's, given to you with this prompt${own.length > 0 ? " after the post's own" : ""}: read ${quotedCount === 1 ? "it" : "them"} as part of what the post quotes.`
    );
  }
  seen.forEach((image, index) => {
    if (image.altText) {
      lines.push(
        `Image ${index + 1}, alt text by ${image.from === "quoted" ? "the quoted post's author" : "the poster"}: "${image.altText.replace(/\s+/g, " ").slice(0, 500)}"`
      );
    }
  });
  if (unseen > 0) {
    lines.push(
      own.length > 0
        ? `The post has ${unseen} more image${unseen === 1 ? "" : "s"} you cannot see: say nothing about ${unseen === 1 ? "it" : "them"}.`
        : `The post has an image you cannot see. Do not describe it or guess what it shows, and do not ask the poster for what it probably shows (their numbers, their screenshot): reply to the words, or ask something the image could not answer.`
    );
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

/**
 * What is kept on the draft: the plan the call was given and what it could
 * hand the model. Null for a post with no known media.
 */
export function draftImagesRecord(
  plan: { images: ReadonlyArray<unknown>; unseen: number; inPost: number | null },
  outcome: { seen: number; failed: number; failures: readonly string[] } | null | undefined
): DraftImages | null {
  if (plan.inPost === 0) return null;
  const seen = outcome?.seen ?? 0;
  const notes: string[] = [];
  if (outcome && outcome.failed > 0) {
    notes.push(
      `${outcome.failed === 1 ? "1 image" : `${outcome.failed} images`} did not load${outcome.failures[0] ? `: ${outcome.failures[0]}` : ""}`
    );
  }
  if (plan.inPost === null) notes.push("X did not hand over the post's images");
  else if (plan.inPost > plan.images.length) notes.push(`${plan.images.length} of ${plan.inPost} could be shown to the draft`);
  return { inPost: plan.inPost, seen, note: notes.length ? notes.join("; ").slice(0, 400) : null };
}
