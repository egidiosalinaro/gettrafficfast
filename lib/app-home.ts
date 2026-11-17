/**
 * Where a signed-in, subscribed owner lands.
 *
 * Today (2026-11-14) is the first screen of the day: the replies to post,
 * the daily goal, and whatever else needs a gesture today. It replaced
 * Replies (`/placements`) and Overview (`/dashboard`), which redirect here.
 * Landing there after a sign-in, from the home-screen icon (app/manifest.ts)
 * and from the pricing pages means the first screen is one the tab bar can
 * return to.
 */
export const APP_HOME = "/today";

/** Where someone without a live subscription goes instead. */
export const SUBSCRIBE_PATH = "/pricing";

/**
 * A `?next=` destination, only when it is a path on this site. Anything else
 * (another origin, a protocol-relative `//host`, a backslash trick) is
 * ignored, so the sign-in link cannot be turned into a redirect elsewhere.
 */
export function safeNextPath(next: string | null | undefined): string | null {
  if (!next) return null;
  if (!next.startsWith("/")) return null;
  if (next.startsWith("//") || next.startsWith("/\\")) return null;
  return next;
}

/**
 * Where the sign-in link sends a signed-in user. An explicit destination
 * wins: someone who signed up from a link into a page goes back to that
 * page, not to pricing. Otherwise a subscriber lands on Today and
 * everyone else on pricing.
 */
export function landingAfterSignIn({
  next,
  subscribed,
}: {
  next: string | null | undefined;
  subscribed: boolean;
}): string {
  return safeNextPath(next) ?? (subscribed ? APP_HOME : SUBSCRIBE_PATH);
}
