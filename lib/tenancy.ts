import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Which site a request is about.
 *
 * Until now the answer was "the user's", because an account held exactly one
 * business. It now holds several, so every site-scoped read and write has to
 * name one, and the name has to be verified: a business id arriving from a
 * cookie is a request, not a permission.
 *
 * The verification is structural rather than a check to remember — the
 * selection is always made by picking FROM the user's own businesses, so an id
 * that is not theirs simply never matches and the fallback applies.
 */

export const BUSINESS_COOKIE = "gtf-business";

/** A year: the switcher is a preference, not a session. */
export const BUSINESS_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export interface BusinessSummary {
  id: string;
  name: string | null;
  website_url: string | null;
}

/**
 * The business a request is about, given everything the user owns.
 *
 * Pure so the rule is testable: a requested id is honoured only when it is in
 * the list; otherwise the fallback is the FIRST business, which callers pass
 * ordered oldest-first. Oldest rather than newest on purpose — it is the site
 * the account was created around, so an expired or spoofed cookie lands
 * somewhere predictable instead of on whatever was added last.
 */
export function pickBusiness<T extends { id: string }>(
  businesses: T[],
  requestedId?: string | null
): T | null {
  if (businesses.length === 0) return null;
  if (requestedId) {
    const requested = businesses.find((business) => business.id === requestedId);
    if (requested) return requested;
  }
  return businesses[0];
}

/** Every business of this user, oldest first. */
export async function listBusinesses(
  supabase: SupabaseClient,
  userId: string
): Promise<BusinessSummary[]> {
  const { data, error } = await supabase
    .from("businesses")
    .select("id, name, website_url")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });

  if (error) throw new Error(`businesses: ${error.message}`);
  return (data ?? []) as BusinessSummary[];
}

/** The selected business, or null when the account has none yet. */
export async function selectedBusiness(
  supabase: SupabaseClient,
  userId: string
): Promise<BusinessSummary | null> {
  const store = await cookies();
  const requested = store.get(BUSINESS_COOKIE)?.value ?? null;
  return pickBusiness(await listBusinesses(supabase, userId), requested);
}

export async function selectedBusinessId(
  supabase: SupabaseClient,
  userId: string
): Promise<string | null> {
  return (await selectedBusiness(supabase, userId))?.id ?? null;
}

/**
 * The body every site-scoped route returns when the account has no business
 * yet. 409 rather than 404: nothing is missing, the account is simply not set
 * up, and the UI can send the person to the one page that fixes it.
 */
export const NO_BUSINESS_RESPONSE = {
  error: "No site set up yet. Add your business first.",
  code: "no_business",
} as const;
