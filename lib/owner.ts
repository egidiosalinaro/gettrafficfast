/**
 * Who runs the platform (docs/API.md "The owner's costs").
 *
 * The platform's own costs (what each provider bills this month, each
 * account's AI spend against its daily ceiling) and the control that sets an
 * account's ceiling are the owner's, not the customer's: a subscriber pays a
 * fixed price and never sees a model cost in dollars. The owners are listed
 * in `PLATFORM_OWNER_USER_IDS`, comma-separated user ids, set on Vercel.
 *
 * Fail closed: unset, empty, or a list of blanks means nobody is an owner.
 * Privilege never comes from a row the user can write (AGENTS.md §10), so it
 * comes from the environment, like `OWN_BLOG_OWNER_USER_IDS`.
 */

export const PLATFORM_OWNER_ENV = "PLATFORM_OWNER_USER_IDS";

/** The owner ids the environment lists, trimmed; empty when none. */
export function platformOwnerIds(env: Record<string, string | undefined> = process.env): string[] {
  const raw = env[PLATFORM_OWNER_ENV];
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

/** True only when `userId` is one of the listed owners. */
export function isPlatformOwner(
  userId: string | null | undefined,
  env: Record<string, string | undefined> = process.env
): boolean {
  if (typeof userId !== "string") return false;
  const id = userId.trim();
  if (!id) return false;
  return platformOwnerIds(env).includes(id);
}
