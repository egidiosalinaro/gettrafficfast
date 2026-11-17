import type { SupabaseClient } from "@supabase/supabase-js";
import { parseAutomationSettings, type AutomationSettings } from "@/lib/automation/settings";
import { parseMediaSettings, type MediaSettings } from "@/lib/media/settings";

/**
 * One site as Settings → Business reads it (GET /api/business/get) and
 * `get_business` answers it. Read by id AND owner, through the caller's
 * client: a site of another account is not found.
 */

export type BusinessRow = Record<string, unknown>;

export type BusinessRead = { ok: true; business: BusinessRow | null } | { ok: false; error: unknown };

export async function loadBusiness(supabase: SupabaseClient, userId: string, businessId: string): Promise<BusinessRead> {
  const { data, error } = await supabase
    .from("businesses")
    .select("*")
    .eq("id", businessId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) return { ok: false, error };
  return { ok: true, business: (data as BusinessRow | null) ?? null };
}

/** A site as the API describes it: what Settings → Business, Autopilot and Images & video show. */
export interface BusinessProfile {
  id: string;
  name: string | null;
  websiteUrl: string | null;
  niche: string | null;
  description: string | null;
  sitemapUrl: string | null;
  blogUrl: string | null;
  contentLanguage: string | null;
  /** Once the URL is saved it is frozen: the site's content history was written for it. */
  isLocked: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  automation: AutomationSettings;
  media: MediaSettings;
}

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

export function businessProfile(row: BusinessRow): BusinessProfile {
  return {
    id: row.id as string,
    name: str(row.name),
    websiteUrl: str(row.website_url),
    niche: str(row.niche),
    description: str(row.description),
    sitemapUrl: str(row.sitemap_url),
    blogUrl: str(row.blog_url),
    contentLanguage: str(row.content_language),
    isLocked: row.is_locked === true,
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
    automation: parseAutomationSettings(row.automation_settings),
    media: parseMediaSettings(row.media_settings),
  };
}
