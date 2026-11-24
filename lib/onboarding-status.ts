import type { SupabaseClient } from "@supabase/supabase-js";
import { parseVoiceSettings } from "@/lib/voice/settings";
import { MANUAL_SOURCE } from "@/lib/placements/manual";
import { buildOnboardingStatus, type OnboardingStatus } from "@/lib/onboarding";
import { countLiveGrants } from "@/lib/oauth/tokens";

/**
 * The Getting started checklist read from the database, once: the corner
 * widget (GET /api/onboarding/status), the Overview (GET /api/home) and
 * `get_onboarding_status` all count the same rows of the SELECTED site the
 * same way. The rule over the counts is `buildOnboardingStatus`
 * (lib/onboarding.ts); this is the reading around it.
 */

export interface OnboardingCounts {
  keywordCount: number;
  articleCount: number;
  /** Destinations connected or in error: a broken one is still set up. */
  integrationCount: number;
  /** `placement_targets` rows a person added (`found_via` = MANUAL_SOURCE). */
  manualPostCount: number;
}

/** The business columns the checklist reads. */
export const ONBOARDING_BUSINESS_COLUMNS = "automation_settings, media_settings, voice_settings";

export interface OnboardingSettings {
  voice_settings?: unknown;
  automation_settings?: unknown;
  media_settings?: unknown;
}

/** Four head counts, no rows. A count that cannot be read counts as none, as it always has here. */
export async function countOnboarding(supabase: SupabaseClient, businessId: string): Promise<OnboardingCounts> {
  const [keyword, article, integration, manualPost] = await Promise.all([
    supabase.from("keywords").select("id", { count: "exact", head: true }).eq("business_id", businessId),
    supabase.from("articles").select("id", { count: "exact", head: true }).eq("business_id", businessId),
    supabase
      .from("integrations")
      .select("id", { count: "exact", head: true })
      .eq("business_id", businessId)
      .in("status", ["connected", "error"]),
    supabase
      .from("placement_targets")
      .select("id", { count: "exact", head: true })
      .eq("business_id", businessId)
      .eq("found_via", MANUAL_SOURCE),
  ]);
  return {
    keywordCount: keyword.count ?? 0,
    articleCount: article.count ?? 0,
    integrationCount: integration.count ?? 0,
    manualPostCount: manualPost.count ?? 0,
  };
}

/** The checklist of a site that exists, from its settings and its counts. */
export function onboardingFrom(settings: OnboardingSettings | null | undefined, counts: OnboardingCounts): OnboardingStatus {
  return buildOnboardingStatus({
    hasBusiness: true,
    aboutYou: parseVoiceSettings(settings?.voice_settings).aboutYou,
    ...counts,
  });
}

/** The checklist of the site `businessId`. */
export async function loadOnboardingStatus(supabase: SupabaseClient, businessId: string): Promise<OnboardingStatus> {
  const [counts, business] = await Promise.all([
    countOnboarding(supabase, businessId),
    supabase.from("businesses").select(ONBOARDING_BUSINESS_COLUMNS).eq("id", businessId).maybeSingle(),
  ]);
  return onboardingFrom(business.data as OnboardingSettings | null, counts);
}

/**
 * Whether the account has Claude connected: a live API key, or a live
 * OAuth grant (claude.ai's connector). Read with the service role after the
 * session check, filtered on the signed-in user. Unreadable counts as not
 * connected: the step is optional and only ever a suggestion.
 */
export async function hasClaudeConnected(admin: SupabaseClient, userId: string): Promise<boolean> {
  const [keys, grants] = await Promise.all([
    admin.from("api_keys").select("id", { count: "exact", head: true }).eq("user_id", userId).is("revoked_at", null),
    countLiveGrants(admin, userId),
  ]);
  return (keys.count ?? 0) > 0 || (grants ?? 0) > 0;
}
