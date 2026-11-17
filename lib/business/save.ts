import type { SupabaseClient } from "@supabase/supabase-js";
import type { ContentLanguageCode } from "@/lib/content-language";

/**
 * Creating and updating a site, called by `POST /api/business/save` and by
 * the create_business / update_business tools (lib/tools/write-business.ts).
 *
 * The is_locked rule is per business: once a site's URL has been saved, its
 * name and address are frozen, because the whole content history of that
 * business was generated for that domain. The route has always ignored a
 * changed name or URL on a locked site and saved the rest; a tool refuses
 * instead, with the reason (`refuseLockedChanges`), since an agent that
 * believes it moved a site would act on the wrong one.
 */

type Row = Record<string, unknown>;

export interface BusinessFields {
  name: string;
  websiteUrl: string;
  niche?: string | null;
  description?: string | null;
  sitemapUrl?: string | null;
  blogUrl?: string | null;
  contentLanguage: ContentLanguageCode;
}

export type SaveBusinessResult =
  | { ok: true; business: Row; created: boolean }
  | { ok: false; status: 400 | 409 | 500; error: string; code?: "locked" | "duplicate" };

/** Why a name and URL cannot make a site, or null when they can. */
export function businessFieldsRefusal(name: unknown, websiteUrl: unknown): string | null {
  if (!name || !websiteUrl) return "Name and Website URL are required";
  try {
    new URL(String(websiteUrl));
  } catch {
    return "Invalid Website URL format";
  }
  return null;
}

/** A URL as compared for the lock: scheme and host lowercased, no trailing slash. */
function comparableUrl(value: string): string {
  try {
    return new URL(value.trim()).href.replace(/\/+$/, "");
  } catch {
    return value.trim().replace(/\/+$/, "");
  }
}

/**
 * The identity fields `fields` would change on a locked site, as the
 * sentence that refuses them; null when nothing locked changes.
 */
export function lockedChangeRefusal(
  stored: { name: string | null; website_url: string | null },
  fields: Pick<BusinessFields, "name" | "websiteUrl">
): string | null {
  const urlChanged = comparableUrl(fields.websiteUrl) !== comparableUrl(stored.website_url ?? "");
  const nameChanged = fields.name.trim() !== (stored.name ?? "").trim();
  if (!urlChanged && !nameChanged) return null;
  const what = urlChanged && nameChanged ? "name and address are" : urlChanged ? "address is" : "name is";
  return `This site's ${what} locked: it has been ${stored.name ?? "unnamed"} at ${stored.website_url ?? "no address"} since it was first saved, and every keyword, article and measurement of the site was made for it. Add the other address as a new site instead.`;
}

/**
 * Saves a site. `targetId` null inserts a new one, locked from the start;
 * otherwise the site is updated: all its fields while it is unlocked (and it
 * locks), only those outside its identity once it is.
 */
export async function saveBusiness(input: {
  supabase: SupabaseClient;
  userId: string;
  targetId: string | null;
  fields: BusinessFields;
  /** Refuse (409, code "locked") a changed name or URL on a locked site, rather than ignore it. */
  refuseLockedChanges?: boolean;
  now?: Date;
}): Promise<SaveBusinessResult> {
  const { supabase, userId, targetId, fields } = input;

  const existing = targetId
    ? await supabase
        .from("businesses")
        .select("id, is_locked, website_url, name")
        .eq("id", targetId)
        .eq("user_id", userId)
        .maybeSingle()
    : { data: null, error: null };
  if (existing.error) {
    console.error("Error checking existing business:", existing.error);
    return { ok: false, status: 500, error: "Failed to check existing business data" };
  }
  const existingBusiness = existing.data as Row | null;

  // A locked site only accepts the fields that do not define its identity.
  if (existingBusiness?.is_locked) {
    if (input.refuseLockedChanges) {
      const refused = lockedChangeRefusal(
        { name: (existingBusiness.name as string | null) ?? null, website_url: (existingBusiness.website_url as string | null) ?? null },
        fields
      );
      if (refused) return { ok: false, status: 409, code: "locked", error: refused };
    }
    const { data, error } = await supabase
      .from("businesses")
      .update({
        niche: fields.niche || null,
        description: fields.description || null,
        sitemap_url: fields.sitemapUrl || null,
        blog_url: fields.blogUrl || null,
        content_language: fields.contentLanguage,
        updated_at: (input.now ?? new Date()).toISOString(),
      })
      .eq("id", existingBusiness.id as string)
      .eq("user_id", userId)
      .select()
      .single();
    if (error) {
      console.error("Error updating business:", error);
      return { ok: false, status: 500, error: `Failed to update business: ${error.message}` };
    }
    return { ok: true, business: data as Row, created: false };
  }

  const businessData = {
    user_id: userId,
    name: fields.name,
    website_url: fields.websiteUrl,
    niche: fields.niche || null,
    description: fields.description || null,
    sitemap_url: fields.sitemapUrl || null,
    blog_url: fields.blogUrl || null,
    content_language: fields.contentLanguage,
    is_locked: true, // Lock after first save
  };

  const { data, error } = existingBusiness
    ? await supabase
        .from("businesses")
        .update(businessData)
        .eq("id", existingBusiness.id as string)
        .eq("user_id", userId)
        .select()
        .single()
    : await supabase.from("businesses").insert(businessData).select().single();

  if (error) {
    console.error("Error saving business:", error);
    console.error("Error details:", JSON.stringify(error, null, 2));
    // The unique is (user_id, website_url): the same domain twice on ONE
    // account is the mistake worth blocking. Two different people working on
    // the same site is a normal case and not rejected.
    if (error.code === "23505") {
      return { ok: false, status: 409, code: "duplicate", error: "You have already added this website" };
    }
    return { ok: false, status: 500, error: `Failed to save business: ${error.message || "Unknown error"}` };
  }

  return { ok: true, business: data as Row, created: !existingBusiness };
}
