import { isOwnWebhookReceiver } from "@/lib/site";

/**
 * Who may publish into gettrafficfa.st's own blog.
 *
 * The own receiver (`/api/gettrafficfast`) is signed with BLOG_WEBHOOK_SECRET,
 * a secret no customer knows. That makes it the one destination the platform
 * signs on someone's behalf, so the platform has to decide whose behalf: the
 * operator's, named in a server env var, never a flag in a row a user can
 * write. Unset or empty means nobody: the check fails closed.
 */
export const OWN_BLOG_OWNER_ENV = "OWN_BLOG_OWNER_USER_IDS";

export function ownBlogOwnerIds(): Set<string> {
  const raw = process.env[OWN_BLOG_OWNER_ENV] ?? "";
  return new Set(
    raw
      .split(",")
      .map((id) => id.trim().toLowerCase())
      .filter(Boolean)
  );
}

export function isOwnBlogOwner(userId: string | null | undefined): boolean {
  if (!userId) return false;
  return ownBlogOwnerIds().has(userId.trim().toLowerCase());
}

/**
 * True when this user may point an integration at this URL. Any URL that is
 * not the own receiver is the customer's business; the own receiver is the
 * operator's alone.
 */
export function mayUseWebhookUrl(url: string, userId: string | null | undefined): boolean {
  return !isOwnWebhookReceiver(url) || isOwnBlogOwner(userId);
}
