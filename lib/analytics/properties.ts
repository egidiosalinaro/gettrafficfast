import type { SupabaseClient } from "@supabase/supabase-js";
import { hasActiveSearchConsoleIngest } from "@/lib/analytics/runs";
import { loadConnection, searchConsoleNeedsPull } from "@/lib/analytics/search-console";
import { listSites, refreshAccessToken, type SearchConsoleSite } from "@/lib/providers/analytics/search-console";

/**
 * The Search Console properties a site's grant can read, so a person (or an
 * agent) can see which one is selected and which others exist. Settings →
 * Integrations → Search Console reads it
 * (GET /api/integrations/search-console/sites) and so does
 * `list_search_console_properties`.
 *
 * Service role, because the refresh token is decrypted here and no client
 * may select it; `business` must already be one of the caller's own sites.
 * The token never leaves this function. Asking Google is free; it throws when
 * Google refuses, and the caller says so.
 */

export type SearchConsoleProperties =
  | { connected: false; sites: SearchConsoleSite[]; websiteUrl: string | null }
  | {
      connected: true;
      /** The property the site reads its traffic from; null until one is picked. */
      selected: string | null;
      websiteUrl: string | null;
      lastSyncedOn: string | null;
      pulledAt: string | null;
      stale: boolean;
      syncing: boolean;
      sites: SearchConsoleSite[];
    };

export async function loadSearchConsoleProperties(
  admin: SupabaseClient,
  business: { id: string; website_url: string | null }
): Promise<SearchConsoleProperties> {
  const connection = await loadConnection({ supabase: admin, businessId: business.id });
  if (!connection) {
    return { sites: [], connected: false, websiteUrl: business.website_url };
  }

  const accessToken = await refreshAccessToken(connection.refreshToken);
  const syncing =
    Boolean(connection.siteUrl) &&
    !connection.lastSyncedOn &&
    (await hasActiveSearchConsoleIngest(admin, business.id));
  return {
    connected: true,
    selected: connection.siteUrl,
    websiteUrl: business.website_url,
    lastSyncedOn: connection.lastSyncedOn,
    pulledAt: connection.pulledAt,
    stale: searchConsoleNeedsPull(connection.lastSyncedOn),
    syncing,
    sites: await listSites(accessToken),
  };
}
