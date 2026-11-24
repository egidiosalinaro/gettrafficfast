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
 *
 * The owner's sites (docs/SELF_HOSTING.md "The platform owner"): an owner's
 * account may also hold sites that are not the platform's, another product
 * of theirs, and on those the owner wants exactly what a customer gets.
 * `PLATFORM_OWNER_BUSINESS_IDS`, comma-separated site ids, optional, names
 * the platform's own sites: when it is set, everything owner-only applies
 * only where the site in hand (the selected site in the browser, the site a
 * key's or a connected app's call resolves to) is one of them. Unset or
 * empty, there is no site condition and an owner is an owner on every site,
 * as before the variable existed. It only ever narrows: it makes nobody an
 * owner. Every owner-only feature asks `isPlatformOwnerHere`, never
 * `isPlatformOwner` alone (tests/owner.test.ts pins that).
 */

export const PLATFORM_OWNER_ENV = "PLATFORM_OWNER_USER_IDS";
export const PLATFORM_OWNER_BUSINESS_ENV = "PLATFORM_OWNER_BUSINESS_IDS";

type Env = Record<string, string | undefined>;

/** The owner ids the environment lists, trimmed; empty when none. */
export function platformOwnerIds(env: Env = process.env): string[] {
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
  env: Env = process.env
): boolean {
  if (typeof userId !== "string") return false;
  const id = userId.trim();
  if (!id) return false;
  return platformOwnerIds(env).includes(id);
}

/**
 * The platform's own site ids, lowercased; null when the variable is unset,
 * empty or only blanks: then no site condition applies.
 */
export function platformOwnerBusinessIds(env: Env = process.env): string[] | null {
  const raw = env[PLATFORM_OWNER_BUSINESS_ENV];
  if (typeof raw !== "string") return null;
  const ids = raw
    .split(",")
    .map((id) => id.trim().toLowerCase())
    .filter((id) => id.length > 0);
  return ids.length > 0 ? ids : null;
}

/**
 * True when owner-only features may apply on `businessId`: always when
 * PLATFORM_OWNER_BUSINESS_IDS is unset, else only for a listed site. No site
 * (null) is never a listed site. Says nothing about the user: the owner
 * check is `isPlatformOwnerHere`.
 */
export function isPlatformOwnerSite(businessId: string | null | undefined, env: Env = process.env): boolean {
  const listed = platformOwnerBusinessIds(env);
  if (listed === null) return true;
  if (typeof businessId !== "string") return false;
  const id = businessId.trim().toLowerCase();
  return id.length > 0 && listed.includes(id);
}

/**
 * The one owner check every owner-only feature makes: `userId` is a platform
 * owner AND `businessId`, the site this request is about, is one of the
 * platform's own sites (any site when PLATFORM_OWNER_BUSINESS_IDS is unset).
 * Off those sites an owner gets the customer's answer, word for word.
 */
export function isPlatformOwnerHere(
  userId: string | null | undefined,
  businessId: string | null | undefined,
  env: Env = process.env
): boolean {
  return isPlatformOwner(userId, env) && isPlatformOwnerSite(businessId, env);
}
