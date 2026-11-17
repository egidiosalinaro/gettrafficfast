import type { SupabaseClient } from "@supabase/supabase-js";
import { kickFirstSearchConsoleSync } from "./runs";
import { SEARCH_CONSOLE } from "./search-console";

/**
 * A site's Search Console grant, as the settings screen changes it: called
 * by `/api/integrations/search-console/{select-site,disconnect}` and by the
 * Search Console tools (lib/tools/write-integrations.ts).
 *
 * `analytics_connections` holds an encrypted refresh token; its RLS lets an
 * owner read their row and never write it, so every write here goes through
 * the service role, always narrowed by the site and the user the caller was
 * verified for (never by an id from the request).
 */

/** The query parameter the connect route reads to attach the grant to one site. */
export const CONNECT_BUSINESS_PARAM = "business";

/**
 * The path a person opens to connect Search Console to `businessId`: Google's
 * consent screen, then back to Settings. The connect route checks that the
 * site is the signed-in person's own and selects it first, so the grant
 * lands on that site and not on whichever one their browser had selected.
 */
export function searchConsoleConnectPath(businessId: string): string {
  return `/api/integrations/search-console/connect?${CONNECT_BUSINESS_PARAM}=${encodeURIComponent(businessId)}`;
}

export interface SearchConsoleState {
  connected: boolean;
  /** The property ingested from; null until one is picked. */
  siteUrl: string | null;
}

/** Whether the site has a live grant, without decrypting it. */
export async function searchConsoleState(input: {
  admin: SupabaseClient;
  userId: string;
  businessId: string;
}): Promise<SearchConsoleState> {
  const { data } = await input.admin
    .from("analytics_connections")
    .select("id, site_url, status")
    .eq("business_id", input.businessId)
    .eq("user_id", input.userId)
    .eq("provider", SEARCH_CONSOLE)
    .maybeSingle();
  if (!data || data.status === "disconnected") return { connected: false, siteUrl: null };
  return { connected: true, siteUrl: (data.site_url as string | null) ?? null };
}

/**
 * Drops the grant. The row is deleted rather than flagged, so the refresh
 * token stops existing here the moment the customer says stop. The metrics
 * already ingested stay: they are the customer's own history.
 */
export async function disconnectSearchConsole(input: {
  admin: SupabaseClient;
  userId: string;
  businessId: string;
}): Promise<{ ok: true } | { ok: false; status: 500; error: string }> {
  const { error } = await input.admin
    .from("analytics_connections")
    .delete()
    .eq("business_id", input.businessId)
    .eq("user_id", input.userId)
    .eq("provider", SEARCH_CONSOLE);
  if (error) return { ok: false, status: 500, error: error.message };
  return { ok: true };
}

/**
 * Picks the property to ingest from. Changing it clears `last_synced_on`:
 * the history already stored belongs to the old property, and resuming from
 * its watermark would leave a silent gap. The first pull for the new
 * property is started here, and waited for up to `waitMs`.
 */
export async function selectSearchConsoleProperty(input: {
  admin: SupabaseClient;
  userId: string;
  businessId: string;
  siteUrl: string;
  waitMs: number;
  now?: Date;
}): Promise<
  | { ok: true; siteUrl: string; lastSyncedOn: string | null; syncing: boolean }
  | { ok: false; status: 500; error: string }
> {
  const { error } = await input.admin
    .from("analytics_connections")
    .update({
      site_url: input.siteUrl,
      last_synced_on: null,
      status: "connected",
      last_error: null,
      updated_at: (input.now ?? new Date()).toISOString(),
    })
    .eq("business_id", input.businessId)
    .eq("user_id", input.userId)
    .eq("provider", SEARCH_CONSOLE);
  if (error) return { ok: false, status: 500, error: error.message };

  const sync = await kickFirstSearchConsoleSync({
    supabase: input.admin,
    userId: input.userId,
    businessId: input.businessId,
    waitMs: input.waitMs,
  });
  return { ok: true, siteUrl: input.siteUrl, lastSyncedOn: sync.lastSyncedOn, syncing: sync.syncing };
}
