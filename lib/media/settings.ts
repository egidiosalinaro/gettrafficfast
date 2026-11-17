import { z } from "zod";

/**
 * Per-business media preferences, stored in `businesses.media_settings`.
 *
 * Format and quality are PRODUCT decisions, not chores to hand to a customer:
 * articles are wide and quality is what we ship.
 *
 * What a business owns is how the images LOOK and how many it pays for. An
 * article gets one featured image; in-article images are an explicit choice
 * with a cap per article (`inlineImagesPerArticle`, 0 unless the business
 * sets it), and under that cap the image-brief agent still decides, article
 * by article, how many the text deserves.
 *
 * Everything is optional in storage and parsed through defaults, so the jsonb
 * column can grow without migrations and old rows never break. Media is OFF
 * by default: generating images costs real money.
 */

export const IMAGE_STYLES = [
  {
    value: "photographic",
    label: "Photography",
    description: "Realistic professional photos with natural lighting",
  },
  {
    value: "render_3d",
    label: "3D Render",
    description: "Clean 3D rendered objects and scenes",
  },
  {
    value: "illustration",
    label: "Illustration",
    description: "Flat vector illustrations with bold shapes",
  },
  {
    value: "claymation",
    label: "Claymation",
    description: "Playful clay-sculpted characters and scenes",
  },
  {
    value: "custom",
    label: "Custom",
    description: "Define your own image style",
  },
] as const;

export type ImageStyle = (typeof IMAGE_STYLES)[number]["value"];

const STYLE_VALUES = IMAGE_STYLES.map((style) => style.value) as [
  ImageStyle,
  ...ImageStyle[],
];

// ── Product decisions, deliberately not user-facing ─────────────────────────

/** Articles are a column of text: an image sits between paragraphs, wide. */
export const IMAGE_ASPECT_RATIO = "16:9" as const;

/** The quality we ship. Offering a worse one is offering a worse product. */
export const IMAGE_QUALITY = "standard" as const;

/** Hard ceiling on in-article images, whatever the business or the agent asks for. */
export const MAX_INLINE_IMAGES = 3;

/**
 * In-article images when the business has not chosen: none. Until 2026-11-10
 * every article with images on got up to three, each a paid render of about
 * 770 KB that showed nothing the text did not already say.
 */
export const DEFAULT_INLINE_IMAGES = 0;

/**
 * How many in-article images an article of this shape may carry — the ceiling
 * the agent plans under. Never more than the business's own cap, and never
 * more than one for every two sections: a short piece gets one picture at
 * most. (Minimums are the model's judgement; maximums are code's job.)
 */
export function inlineImageAllowance(sectionCount: number, perArticleCap: number): number {
  const cap = Math.max(0, Math.min(MAX_INLINE_IMAGES, Math.floor(perArticleCap) || 0));
  return Math.max(0, Math.min(cap, Math.floor(sectionCount / 2)));
}

/**
 * The most images one article can get with these settings, the featured one
 * included: 0 with images off. A count, never a price: images are included
 * in the plan (owner's decision, 2026-11-14), and what a render costs the
 * platform is recorded per render in `media_assets.meta.cost_usd`.
 */
export function maxImagesPerArticle(settings: { imagesEnabled: boolean; inlineImagesPerArticle: number }): number {
  if (!settings.imagesEnabled) return 0;
  return 1 + Math.max(0, Math.min(MAX_INLINE_IMAGES, Math.floor(settings.inlineImagesPerArticle) || 0));
}

/** The choices the settings screen offers for images per article (featured image included). */
export const INLINE_IMAGE_OPTIONS = Array.from({ length: MAX_INLINE_IMAGES + 1 }, (_, count) => ({
  count,
  label: count === 0 ? "Featured image only" : `Featured image, plus up to ${count} in the article`,
}));

export const MediaSettings = z.object({
  /** Master switch for AI images: the featured image, plus in-article ones if asked for. */
  imagesEnabled: z.boolean().default(false),
  /** The most in-article images one article may carry; 0 is the featured image only. */
  inlineImagesPerArticle: z.number().int().min(0).max(MAX_INLINE_IMAGES).default(DEFAULT_INLINE_IMAGES),
  /** Which image provider renders the briefs; empty = platform default. */
  imageProvider: z.enum(["imagen", "openai"]).nullable().default(null),
  style: z.enum(STYLE_VALUES).default("photographic"),
  /** Art direction written by the business — used ONLY when style is "custom". */
  styleInstructions: z.string().max(500).default(""),
  /** Brand colors, hex strings; steer the palette, never override the scene. */
  brandPalette: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).max(6).default([]),
  /** Master switch for YouTube video enrichment. */
  videosEnabled: z.boolean().default(false),
});

export type MediaSettings = z.infer<typeof MediaSettings>;

export const DEFAULT_MEDIA_SETTINGS: MediaSettings = MediaSettings.parse({});

/** Styles that existed before the picker was reduced to four distinct looks. */
const LEGACY_STYLE_ALIASES: Record<string, ImageStyle> = {
  digital_art: "render_3d",
  minimalist: "illustration",
};

/**
 * Maps a stored row onto the current vocabulary. Removed keys (aspect ratio,
 * quality) are simply dropped by the schema; a retired style name would
 * otherwise fail the enum and cost the business every other setting, so it
 * is translated to its nearest surviving look.
 *
 * `inlineCount` is the name the in-article count was stored under before the
 * count stopped being a setting. A row that still carries it made that choice
 * explicitly, so it is kept (clamped to the ceiling) rather than reset to the
 * default; a row with neither key gets the default.
 */
function normalizeLegacy(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  let row = raw as Record<string, unknown>;
  const alias = typeof row.style === "string" ? LEGACY_STYLE_ALIASES[row.style] : undefined;
  if (alias) row = { ...row, style: alias };
  if (row.inlineImagesPerArticle === undefined && typeof row.inlineCount === "number" && Number.isFinite(row.inlineCount)) {
    row = {
      ...row,
      inlineImagesPerArticle: Math.max(0, Math.min(MAX_INLINE_IMAGES, Math.floor(row.inlineCount))),
    };
  }
  return row;
}

/** Tolerant parse: unknown/invalid stored values fall back to defaults. */
export function parseMediaSettings(raw: unknown): MediaSettings {
  const result = MediaSettings.safeParse(normalizeLegacy(raw ?? {}));
  return result.success ? result.data : DEFAULT_MEDIA_SETTINGS;
}
