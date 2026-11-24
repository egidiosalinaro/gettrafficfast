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
 * column can grow without migrations and old rows never break.
 *
 * Images are on for every site, with no switch (the owner, 2026-11-24): one
 * featured image an article, in-article ones only when the business raises
 * the cap. They start once the person has chosen how they look
 * (`styleChosen`): until then articles go out without images, nothing is
 * spent on them, and the person is told so (the Getting started step
 * "Choose your image style", the Content header, the article itself). A
 * stored `imagesEnabled` (the switch until 2026-11-24) is ignored, and one
 * sent by an old page or caller is accepted and dropped. Images still need
 * the deployment's opt-in (`IMAGES_ENABLED`, lib/providers/images/registry.ts)
 * and stop under the billing pause, as before.
 *
 * Videos keep their switch, on by default: a stored `false` is the person's
 * opt-out and is kept. A video is selected, never generated, and costs no
 * render, so it does not wait for an image style.
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
 * The most images one article can get with these settings once the style is
 * chosen, the featured one included. A count, never a price: images are
 * included in the plan (owner's decision, 2026-11-14), and what a render
 * costs the platform is recorded per render in `media_assets.meta.cost_usd`.
 */
export function maxImagesPerArticle(settings: { inlineImagesPerArticle: number }): number {
  return 1 + Math.max(0, Math.min(MAX_INLINE_IMAGES, Math.floor(settings.inlineImagesPerArticle) || 0));
}

/** The choices the settings screen offers for images per article (featured image included). */
export const INLINE_IMAGE_OPTIONS = Array.from({ length: MAX_INLINE_IMAGES + 1 }, (_, count) => ({
  count,
  label: count === 0 ? "Featured image only" : `Featured image, plus up to ${count} in the article`,
}));

export const MediaSettings = z.object({
  /** The most in-article images one article may carry; 0 is the featured image only. */
  inlineImagesPerArticle: z.number().int().min(0).max(MAX_INLINE_IMAGES).default(DEFAULT_INLINE_IMAGES),
  /** Which image provider renders the briefs; empty = platform default. */
  imageProvider: z.enum(["imagen", "openai"]).nullable().default(null),
  style: z.enum(STYLE_VALUES).default("photographic"),
  /** Art direction written by the business — used ONLY when style is "custom". */
  styleInstructions: z.string().max(500).default(""),
  /** Brand colors, hex strings; steer the palette, never override the scene. */
  brandPalette: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).max(6).default([]),
  /** YouTube video enrichment, when the platform has a video provider. On unless the person turns it off. */
  videosEnabled: z.boolean().default(true),
  /**
   * Whether the person has chosen how this site's images look: saved the
   * images form in Settings, or had their agent set the look through
   * `update_media_settings`. Until then articles get no image. Set by the
   * server only (`withStyleChosen`), never from the value a form sends.
   */
  styleChosen: z.boolean().default(false),
  /**
   * When the look was last chosen (ISO). Null when it was never chosen, and
   * for a site that had configured its look before this field existed: that
   * day was not recorded, and none is made up.
   */
  styleChosenAt: z.string().datetime().nullable().default(null),
});

export type MediaSettings = z.infer<typeof MediaSettings>;

export const DEFAULT_MEDIA_SETTINGS: MediaSettings = MediaSettings.parse({});

/** Styles that existed before the picker was reduced to four distinct looks. */
const LEGACY_STYLE_ALIASES: Record<string, ImageStyle> = {
  digital_art: "render_3d",
  minimalist: "illustration",
};

const DEFAULT_STYLE: ImageStyle = "photographic";

/** The fields that are the look of the images: what choosing a style sets. */
export const IMAGE_STYLE_FIELDS = ["style", "styleInstructions", "brandPalette"] as const;

/**
 * Whether a row stored before `styleChosen` existed had its look set by the
 * person: a style other than the default, art direction written, or brand
 * colours picked. Such a site has been getting the images it configured,
 * and keeps getting them; a row with the defaults only (or none) has not
 * chosen, and waits for the person like a new site.
 */
export function legacyStyleConfigured(row: Record<string, unknown>): boolean {
  if (typeof row.style === "string" && row.style !== DEFAULT_STYLE) return true;
  if (typeof row.styleInstructions === "string" && row.styleInstructions.trim() !== "") return true;
  return Array.isArray(row.brandPalette) && row.brandPalette.length > 0;
}

/** Whether articles of a site with these settings get images: once the look is chosen. */
export function imageStyleChosen(settings: Pick<MediaSettings, "styleChosen">): boolean {
  return settings.styleChosen === true;
}

/** The settings with the look marked as chosen now: what saving the images form, or the agent setting the look, does. */
export function withStyleChosen(settings: MediaSettings, now: Date = new Date()): MediaSettings {
  return { ...settings, styleChosen: true, styleChosenAt: now.toISOString() };
}

/** Where the look is chosen: Settings → Autopilot, Images and video. */
export const IMAGE_STYLE_PATH = "/settings/automation#images";

/** What the screens say while no look is chosen, in one line, before the link to IMAGE_STYLE_PATH. */
export const NO_IMAGE_STYLE_LINE =
  "Articles go out without images until you choose an image style. Once you pick one, every new article gets a featured image.";

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
 *
 * A row with no `styleChosen` key was stored before the field existed
 * (2026-11-24): it counts as chosen when its look was set by the person
 * (`legacyStyleConfigured`), so a site already getting its images keeps
 * them. `styleChosenAt` stays null there: the day was not recorded.
 */
function normalizeLegacy(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  let row = raw as Record<string, unknown>;
  const alias = typeof row.style === "string" ? LEGACY_STYLE_ALIASES[row.style] : undefined;
  if (alias) row = { ...row, style: alias };
  if (row.styleChosen === undefined && legacyStyleConfigured(row)) {
    row = { ...row, styleChosen: true };
  }
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
