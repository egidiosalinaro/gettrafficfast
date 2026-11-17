import { xStatusIdOf } from "./published-url";

/**
 * The address that opens X's composer as a reply to a thread, with the
 * answer already typed in. It is X's own web intent: the platform posts
 * nothing, the person reads the reply in X's composer and clicks Post
 * there. That keeps every reply a person's own act, outside X's rules for
 * automated replies.
 *
 * `intent/tweet` is the documented path (`intent/post` is an alias), and
 * `in_reply_to` is the status id of the post being answered. Pure and free
 * of Node APIs: the inbox card builds it in the browser.
 */

export const X_REPLY_INTENT = "https://x.com/intent/tweet";

/**
 * Past this length a browser or X may cut the address, and a cut text is a
 * different reply. Over it, the card copies the answer and opens the thread
 * instead, which carries any length.
 */
export const X_INTENT_URL_MAX = 8000;

/**
 * `https://x.com/intent/tweet?text=<body>&in_reply_to=<status id>`, or null
 * when the thread address names no post on X (a profile, a search page,
 * another site) or the address would be longer than `X_INTENT_URL_MAX`.
 * The body is sent as written: line breaks, emoji and `&` are percent-encoded,
 * never dropped.
 */
export function xReplyIntentUrl(threadUrl: string, body: string): string | null {
  const statusId = xStatusIdOf(threadUrl);
  if (!statusId) return null;
  const url = `${X_REPLY_INTENT}?text=${encodeURIComponent(body)}&in_reply_to=${statusId}`;
  return url.length > X_INTENT_URL_MAX ? null : url;
}
