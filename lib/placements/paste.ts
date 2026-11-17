import { replyLinkKey } from "./published-url";

/**
 * Links out of what was pasted or typed.
 *
 * The daily loop starts with a handful of posts found on X: until
 * 2026-11-10 each one was Paste, Add, wait, five times over. The add field
 * now takes several links at once, one per line or separated by spaces, and
 * the same reader serves the box that takes the links of the replies posted
 * yesterday.
 */

/** How many links one paste may carry. Each added post starts a paid draft. */
export const MAX_LINKS_PER_PASTE = 10;

const WITH_SCHEME = /https?:\/\/[^\s<>"']+/gi;
const BARE_X = /(?:^|\s)((?:www\.|mobile\.)?(?:x|twitter)\.com\/[^\s<>"']+)/gi;

/** Every link in the text, in the order written, each once (the same page copied twice is one link). */
export function linksIn(text: string): string[] {
  const found: Array<{ at: number; link: string }> = [];
  for (const match of text.matchAll(WITH_SCHEME)) found.push({ at: match.index ?? 0, link: match[0] });
  for (const match of text.matchAll(BARE_X)) {
    const at = (match.index ?? 0) + match[0].indexOf(match[1]);
    // "https://x.com/…" was already read with its scheme.
    if (!found.some((f) => at >= f.at && at < f.at + f.link.length)) found.push({ at, link: `https://${match[1]}` });
  }
  const seen = new Set<string>();
  const links: string[] = [];
  for (const { link } of found.sort((a, b) => a.at - b.at)) {
    const clean = link.replace(/[),.;]+$/, "");
    const key = replyLinkKey(clean) ?? clean;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push(clean);
  }
  return links;
}

/**
 * The link in what the clipboard holds: the first http(s) address, or an
 * x.com / twitter.com address copied without its scheme. Null when there is
 * no link at all, so a field is never filled with prose.
 */
export function linkFromClipboard(text: string): string | null {
  return linksIn(text)[0] ?? null;
}

/** The links one paste adds, and how many were left out by the cap. */
export function linksFromPaste(text: string, max = MAX_LINKS_PER_PASTE): { links: string[]; over: number } {
  const all = linksIn(text);
  return { links: all.slice(0, max), over: Math.max(0, all.length - max) };
}

/** What the line under a field says when Paste could not fill it. */
export const PASTE_BLOCKED = "This browser did not let the page read the clipboard. Tap the field and paste there.";
export const PASTE_NO_LINK = "The clipboard has no link in it. Copy the link first.";

/** The clipboard's text, or null when the browser refuses or has no clipboard to read. */
export async function readClipboard(): Promise<string | null> {
  try {
    if (!navigator.clipboard?.readText) return null;
    return await navigator.clipboard.readText();
  } catch {
    return null;
  }
}

export interface AddAttempt {
  link: string;
  /** Null when the post is in the inbox; else the server's sentence. */
  error: string | null;
}

/**
 * What the page says after several posts were added at once: how many are
 * in, and for each one that is not, its link and the reason, so nothing is
 * dropped silently. `over` is how many links the cap left out.
 */
export function addSummary(attempts: readonly AddAttempt[], over = 0): { text: string; failed: AddAttempt[]; capped: string | null } {
  const added = attempts.filter((a) => !a.error).length;
  const failed = attempts.filter((a) => a.error);
  const text =
    failed.length === 0
      ? `${added} ${added === 1 ? "post" : "posts"} added.`
      : `${added} of ${attempts.length} posts added. ${failed.length} not added.`;
  return {
    text,
    failed,
    capped: over > 0 ? `${over} more ${over === 1 ? "link was" : "links were"} left out: ${MAX_LINKS_PER_PASTE} at a time.` : null,
  };
}
