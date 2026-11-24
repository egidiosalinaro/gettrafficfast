/**
 * Why an article has fewer images or videos than its settings asked for.
 *
 * Until 2026-11-10 a skipped image was a line in a step's notes that no
 * screen read: 16 articles were published without any image because the
 * image account could not pay, and nobody was told. A skip is now a record
 * with a reason, written where the owner's screens already look (the
 * article's canonical document, `media.skipped`) and, when the cause is the
 * platform's to fix, sent to the operator once a day.
 *
 * Pure: no I/O and no vendor name. The vendor's own message stays in the
 * step output (`detail`), for the operator; what the owner reads is the
 * sentence written here.
 */

export type MediaKind = "images" | "videos";

export type MediaSkipReason =
  /** The image account cannot pay (a 402, a depleted balance). */
  | "billing"
  /** Held by the pause a billing refusal started: nothing was called. */
  | "paused"
  /** No provider is set up on the platform for this kind of media. */
  | "not_configured"
  /** The provider was called and failed. */
  | "provider_error"
  /** The scene could not be made concrete; nothing was rendered. */
  | "brief_rejected"
  /**
   * The person has not chosen how the site's images look yet
   * (`media_settings.styleChosen`): nothing was briefed or rendered. Theirs
   * to do, not the platform's.
   */
  | "no_style";

export interface MediaSkip {
  media: MediaKind;
  reason: MediaSkipReason;
  /** How many items this skip covers (images not rendered). */
  count: number;
  /** The underlying message, for the operator and the logs. Never shown to an owner. */
  detail: string;
}

/** What the canonical document carries: the skip without the vendor's words. */
export interface MediaSkipNote {
  media: MediaKind;
  reason: MediaSkipReason;
  count: number;
  /** A sentence for the owner, in the platform's own words. */
  message: string;
}

/** Reasons the platform has to act on; the others are an outcome, not a fault. */
export const OPERATOR_REASONS: readonly MediaSkipReason[] = ["billing", "not_configured", "provider_error"];

export function needsOperator(reason: MediaSkipReason): boolean {
  return OPERATOR_REASONS.includes(reason);
}

const IMAGE_MESSAGES: Record<MediaSkipReason, string> = {
  billing:
    "Images were not generated: the image service could not be paid on our side. The article was written without them; regenerate it once this is fixed to get its images.",
  paused:
    "Images were not generated: image generation is on hold for up to an hour after the image service could not be paid on our side. The article was written without them; regenerate it later to get its images.",
  not_configured:
    "Images were not generated: image generation is not set up on the platform right now. The article was written without them.",
  provider_error:
    "Some images were not generated: the image service returned an error. The article was written without them; regenerate it to try again.",
  brief_rejected:
    "An image was left out: no concrete, photographable scene could be planned for it, and a generic picture was not worth generating.",
  no_style:
    "No images: no image style chosen yet. The article was written without them; choose a style in Settings, Autopilot, Images and video, and the articles written after that get a featured image.",
};

const VIDEO_MESSAGES: Record<MediaSkipReason, string> = {
  billing:
    "No video was looked for: the video search could not be paid on our side. The article was written without one.",
  paused: "No video was looked for: video search is on hold. The article was written without one.",
  not_configured:
    "No video was looked for: video search is not available on the platform right now. The article was written without one.",
  provider_error:
    "No video was looked for: the video search returned an error. The article was written without one.",
  brief_rejected: "No video was added.",
  // Videos never wait for an image style; listed so every reason has its sentence.
  no_style: "No video was added.",
};

/** The owner's sentence for a skip. */
export function mediaSkipMessage(skip: Pick<MediaSkip, "media" | "reason">): string {
  return (skip.media === "images" ? IMAGE_MESSAGES : VIDEO_MESSAGES)[skip.reason];
}

/**
 * One entry per (media, reason): three images lost to the same refusal are
 * one thing to tell the owner, with a count, not three.
 */
export function mergeSkips(skips: MediaSkip[]): MediaSkip[] {
  const merged = new Map<string, MediaSkip>();
  for (const skip of skips) {
    const key = `${skip.media}:${skip.reason}`;
    const existing = merged.get(key);
    if (existing) existing.count += skip.count;
    else merged.set(key, { ...skip });
  }
  return [...merged.values()];
}

/** The notes stored on the article, vendor text removed. */
export function toSkipNotes(skips: MediaSkip[]): MediaSkipNote[] {
  return mergeSkips(skips).map((skip) => ({
    media: skip.media,
    reason: skip.reason,
    count: skip.count,
    message: mediaSkipMessage(skip),
  }));
}

/** Reads `media.skipped` from a stored canonical document; [] when absent or malformed. */
export function readSkipNotes(canonical: unknown): MediaSkipNote[] {
  const media = (canonical as { media?: { skipped?: unknown } } | null)?.media;
  if (!media || !Array.isArray(media.skipped)) return [];
  return media.skipped.filter(
    (note): note is MediaSkipNote =>
      Boolean(note) &&
      typeof note === "object" &&
      typeof (note as MediaSkipNote).message === "string" &&
      typeof (note as MediaSkipNote).reason === "string" &&
      ((note as MediaSkipNote).media === "images" || (note as MediaSkipNote).media === "videos")
  );
}
