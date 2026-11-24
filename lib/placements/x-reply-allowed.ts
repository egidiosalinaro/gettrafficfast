import { xStatusIdOf } from "./published-url";

/**
 * Whether X lets GTF post a reply to this post from the site's connected
 * account (docs/PLACEMENTS.md, "Post on X: only where X allows it").
 *
 * X's rule for self-serve API access (February 2026): a reply to someone
 * else's post is allowed only when that post's author @mentioned the
 * account, or quoted one of its posts. Everything else answers 403. So the
 * Post on X button is offered only where the stored post shows one of:
 *
 *   own_post      — the post is the account's own (a reply in one's own
 *                   thread, which X always allows);
 *   mention       — the post's text names @username (X's text carries the
 *                   leading @mentions of a reply too);
 *   quote         — the post quotes a post by username;
 *   reply_to_you  — the post answers a post by username (X writes the
 *                   @mention of the account being answered into the reply).
 *
 * Read from what discovery stored (`excerpt`, the post's text up to 2,000
 * characters, and `referenced_posts`); nothing is fetched. It is a pre-check,
 * not a promise: X may still refuse (a mention past the stored text, a rule
 * changed), and the post then falls back to X's composer in the same click
 * (`reply_not_allowed`). Every other post keeps today's flow: the composer
 * opens with the text, the person posts, GTF finds the link. Pure and free
 * of Node APIs: the inbox card calls it in the browser.
 */

export type XReplyAllowance = "own_post" | "mention" | "quote" | "reply_to_you";

export interface XReplyTargetFacts {
  surface: string;
  url: string;
  /** The post's author handle, without "@". */
  author?: string | null;
  title?: string | null;
  excerpt?: string | null;
  quotedPost?: { handle?: string | null } | null;
  repliedToPost?: { handle?: string | null } | null;
}

function same(a: string | null | undefined, b: string): boolean {
  return typeof a === "string" && a.replace(/^@/, "").toLowerCase() === b.toLowerCase();
}

/** True when `text` names @username as a whole handle (not @usernamefoo, not an email address). */
export function mentionsHandle(text: string | null | undefined, username: string): boolean {
  if (!text || !/^\w{1,15}$/.test(username)) return false;
  return new RegExp(`(^|[^\\w@])@${username}(?!\\w)`, "i").test(text);
}

/** Why X allows this reply from `username`, or null when nothing stored shows that it does. */
export function xReplyAllowance(target: XReplyTargetFacts, username: string | null | undefined): XReplyAllowance | null {
  if (!username || target.surface !== "x" || !xStatusIdOf(target.url)) return null;
  if (same(target.author, username)) return "own_post";
  if (mentionsHandle(target.excerpt, username) || mentionsHandle(target.title, username)) return "mention";
  if (same(target.quotedPost?.handle, username)) return "quote";
  if (same(target.repliedToPost?.handle, username)) return "reply_to_you";
  return null;
}
