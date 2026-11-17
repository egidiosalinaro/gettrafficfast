import { SITE_NAME } from "@/lib/site";

/**
 * The words and sizes of a blog post's social card
 * (app/blog/[slug]/opengraph-image.tsx). Pure, so they are tested without
 * rendering an image.
 */

export const OG_CARD_SIZE = { width: 1200, height: 630 } as const;

/** What the card says for a slug with no post: the site's name, never an invented title. */
export const OG_FALLBACK_TITLE = `The ${SITE_NAME} blog`;

const MAX_TITLE = 160;

/** The title as the card shows it: past ~160 characters even the smallest size overflows. */
export function ogCardTitle(title: string | null | undefined): string {
  const clean = (title ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return OG_FALLBACK_TITLE;
  return clean.length > MAX_TITLE ? `${clean.slice(0, MAX_TITLE - 1).trimEnd()}…` : clean;
}

/** A long title is set smaller rather than cut: the title is the whole card. */
export function ogTitleFontSize(title: string): number {
  const length = title.length;
  if (length <= 40) return 84;
  if (length <= 70) return 68;
  if (length <= 110) return 56;
  return 46;
}
