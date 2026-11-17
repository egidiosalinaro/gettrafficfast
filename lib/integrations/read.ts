import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * A site's publishing destinations as Settings → Connections reads them
 * (GET /api/integrations/list) and `list_integrations` answers: never a
 * credential. Destinations are per site: one account can publish one site
 * to WordPress and another to its own blog, and neither list shows the
 * other's.
 */

type Row = Record<string, unknown>;

/**
 * A stored config without its credentials: every `*_encrypted` key (the
 * WordPress application password, the webhook secret) is dropped, so a
 * credential added later under the same convention is dropped too.
 */
export function publicConfig(config: unknown): Record<string, unknown> {
  if (!config || typeof config !== "object" || Array.isArray(config)) return {};
  return Object.fromEntries(Object.entries(config as Row).filter(([key]) => !key.endsWith("_encrypted")));
}

export interface IntegrationListing {
  id: unknown;
  type: unknown;
  status: unknown;
  last_error: unknown;
  last_sync_at: unknown;
  config: Record<string, unknown>;
  created_at: unknown;
}

export async function listIntegrations(
  supabase: SupabaseClient,
  businessId: string
): Promise<{ ok: true; integrations: IntegrationListing[] } | { ok: false; error: string }> {
  const { data, error } = await supabase
    .from("integrations")
    .select("id, type, status, last_error, last_sync_at, config, created_at")
    .eq("business_id", businessId);
  if (error) return { ok: false, error: error.message };
  return {
    ok: true,
    integrations: ((data ?? []) as Row[]).map((row) => ({ ...row, config: publicConfig(row.config) }) as IntegrationListing),
  };
}
