import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { hasActiveSubscription } from "@/lib/subscription";
import {
  BUSINESS_COOKIE,
  listBusinesses,
  pickBusiness,
  type BusinessSummary,
} from "@/lib/tenancy";

/**
 * What every authenticated screen may assume: a signed-in user with a live
 * subscription, and the sites they own. The cookie is still only a request —
 * `pickBusiness` chooses from this list, never from the cookie alone.
 */
export interface AppAccess {
  userId: string;
  user: User | null;
  businesses: BusinessSummary[];
  selected: BusinessSummary | null;
}

export function avatarUrlFrom(user: User | null): string | undefined {
  const metadata = user?.user_metadata as
    | { avatar_url?: unknown; picture?: unknown }
    | undefined;
  const avatar = metadata?.avatar_url;
  const picture = metadata?.picture;
  if (typeof avatar === "string" && avatar) return avatar;
  if (typeof picture === "string" && picture) return picture;
  return undefined;
}

/**
 * The gate shared by the authenticated shell and every section under it.
 *
 * The shell stays mounted across menu clicks, so it does not re-run this on
 * navigation. Each section layout does, which is what keeps a lapsed
 * subscription from browsing the app until the next full reload.
 *
 * Wrapped in React `cache()`: one request used to run it serially up to
 * three times (the shell, SiteSection or the settings layout, and a page),
 * each a fresh round of auth, subscription and site queries. Within a request
 * the first call does the work and the others share its result, redirects
 * included. Across requests nothing is shared, so a tab switch still checks.
 */
export const requireAppAccess = cache(async function requireAppAccess(): Promise<AppAccess> {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims?.sub) {
    redirect("/auth/sign-up");
  }

  const userId = data.claims.sub;
  if (!(await hasActiveSubscription(userId))) {
    redirect("/pricing");
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  const businesses = await listBusinesses(supabase, userId);
  const store = await cookies();
  const requested = store.get(BUSINESS_COOKIE)?.value ?? null;

  return {
    userId,
    user,
    businesses,
    selected: pickBusiness(businesses, requested),
  };
});

/**
 * A section that is about one site. Settings does not call this: it is the
 * page that creates the site, and redirecting it would loop.
 */
export async function requireSite(): Promise<
  AppAccess & { selected: BusinessSummary }
> {
  const access = await requireAppAccess();
  if (!access.selected) {
    redirect("/settings/business");
  }
  return { ...access, selected: access.selected };
}
