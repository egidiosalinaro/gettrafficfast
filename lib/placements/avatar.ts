import { publicAvatarUrl } from "@/lib/providers/avatars/public";
import { surfaceDomain, surfaceLabel } from "./surfaces";

/**
 * Who a post is from, as a picture, and who answers it.
 *
 * The Replies item reads like the post with the reply under it: the
 * author's picture beside the post, the business's icon beside the draft
 * (docs/PLACEMENTS.md, "The post and your reply", 2026-11-10). Decoration,
 * and decoration that must never lie: a picture is shown only when it is
 * the author's own, found by their handle; otherwise their initials on a
 * colour of their own; and with no author at all, the platform's mark.
 * Never a guessed face.
 *
 * Pure: the URL of a picture comes from the provider layer, and the browser
 * loads it. Nothing here fetches.
 */

/** Authors that are not a person to show: a deleted account, the platform itself. */
const NOBODY = new Set(["[deleted]", "[removed]", "deleted"]);

/**
 * The author's bare handle ("maya_builds", "throwaway_sdk_dev"), or null when
 * the row has no author. On X the community is "@name" and carries the same
 * handle, so it stands in when `author` was not stored.
 */
export function authorHandle(target: { surface: string; author: string | null; community: string | null }): string | null {
  const bare = (value: string | null | undefined) => (value ?? "").trim().replace(/^(@|u\/|\/u\/)/i, "");
  const author = bare(target.author);
  if (author && !NOBODY.has(author.toLowerCase())) return author;
  if (target.surface === "x" && target.community?.trim().startsWith("@")) {
    const handle = bare(target.community);
    return handle || null;
  }
  return null;
}

/**
 * One or two letters for a name or a handle: the first letters of its first
 * two words ("Anna Keller", "anna-keller", "maya_builds" → "AK", "AK",
 * "MB"), or the first letter of a single word ("growthnotes" → "G").
 * Digits and symbols are skipped; empty when nothing is a letter.
 */
export function initialsOf(name: string | null | undefined): string {
  const words = (name ?? "")
    .trim()
    .replace(/^(@|u\/)/i, "")
    .split(/[\s_.\-]+/)
    .map((word) => Array.from(word).find((ch) => /\p{L}/u.test(ch)) ?? "")
    .filter(Boolean);
  return words
    .slice(0, 2)
    .join("")
    .toLocaleUpperCase("en-US");
}

/** How many colours an initials circle can take (the component's palette has this many). */
export const AVATAR_TONE_COUNT = 8;

/**
 * Which colour a handle's circle takes: the same for the same handle,
 * whatever its case, on every screen and every load (FNV-1a of the
 * lowercased key). Null-safe: no key, tone 0.
 */
export function avatarTone(key: string | null | undefined): number {
  const text = (key ?? "").trim().toLowerCase();
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % AVATAR_TONE_COUNT;
}

export interface AuthorAvatar {
  /** The handle the picture is for; null when the row has no author. */
  handle: string | null;
  /** What the post's header names: "@maya_builds", "u/organic_ops", "Anna Keller", or the platform. */
  name: string;
  /**
   * Pictures to try, in order: one stored with the row, then the public
   * one by handle. The first that loads is shown; on an error the next is
   * tried. Empty without a handle: no handle, no picture.
   */
  images: string[];
  /** Letters for the circle when no picture loads; empty when the row has no author. */
  initials: string;
  /** The circle's colour (`avatarTone` of the handle). */
  tone: number;
  /** The platform's icon host, for a row with no author (a Quora question, a web page). */
  mark: string | null;
}

/** An https URL, or null: a stored value is shown only when it is one. */
function httpsUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

/**
 * What stands for the author of a post, in the order it is tried: a picture
 * stored with the row (`storedUrl`; no source stores one today, see the
 * provider), the platform's public picture by handle, the initials, and,
 * with no author, the platform's mark.
 */
export function authorAvatar(target: {
  surface: string;
  author: string | null;
  community: string | null;
  storedUrl?: string | null;
}): AuthorAvatar {
  const handle = authorHandle(target);
  const mark = surfaceDomain(target.surface, target.community);
  if (!handle) {
    // A thread with no author on record: named by where it is ("r/SaaS",
    // a repository, a site), else by the platform. No picture.
    const label = surfaceLabel(target.surface);
    const community = target.community?.trim() ?? "";
    const named = community && ![label.toLowerCase(), target.surface.toLowerCase()].includes(community.toLowerCase());
    return { handle: null, name: named ? community : label, images: [], initials: "", tone: 0, mark };
  }
  // A handle with a space in it is a display name (LinkedIn's "Anna Keller"):
  // shown as it is. A handle on X is "@name", on Reddit "u/name".
  const name = /\s/.test(handle)
    ? handle
    : target.surface === "x"
      ? `@${handle}`
      : target.surface === "reddit"
        ? `u/${handle}`
        : handle;
  const images = [httpsUrl(target.storedUrl), publicAvatarUrl(target.surface, handle)].filter(
    (url, index, all): url is string => Boolean(url) && all.indexOf(url) === index
  );
  return { handle, name, images, initials: initialsOf(handle), tone: avatarTone(handle), mark };
}

export interface BusinessAvatar {
  /** The name beside the draft: the business's, else its host, else "You". */
  name: string;
  /** The host whose favicon is the picture; null when the business has no site on record. */
  domain: string | null;
  initials: string;
  tone: number;
}

/**
 * "Me" in the thread: the business's favicon and name beside the draft.
 * It stands for the person replying; the reply goes out from whatever
 * account they post with, and the item does not claim otherwise.
 */
export function businessAvatar(business: { name: string | null; domain: string | null } | null | undefined): BusinessAvatar {
  const domain = business?.domain?.trim() || null;
  const name = business?.name?.trim() || domain || "You";
  return { name, domain, initials: initialsOf(name) || "Y", tone: avatarTone(name) };
}
