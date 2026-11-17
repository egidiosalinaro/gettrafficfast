import type { SupabaseClient } from "@supabase/supabase-js";
import type { IntegrationType } from "./types";

/**
 * Disconnecting a publishing destination, called by
 * `POST /api/integrations/disconnect` and the disconnect_integration tool.
 *
 * Connecting one is not here on purpose for the tools: a WordPress
 * application password or a webhook secret must not pass through an AI
 * chat, so connecting stays a screen (docs/API.md "Not built yet").
 */

/** The destinations a person can disconnect. `self` (this site's own blog) is not one. */
export const DISCONNECTABLE_INTEGRATIONS = ["wordpress", "webflow", "shopify", "webhook"] as const satisfies readonly IntegrationType[];
export type DisconnectableIntegration = (typeof DISCONNECTABLE_INTEGRATIONS)[number];

export function isDisconnectable(type: unknown): type is DisconnectableIntegration {
  return (DISCONNECTABLE_INTEGRATIONS as readonly unknown[]).includes(type);
}

/**
 * Deletes the site's integration of that type, credentials and all. The
 * articles it published stay where they are. `disconnected` is 0 when there
 * was none, which is not an error: the result is the same.
 */
export async function disconnectIntegration(input: {
  supabase: SupabaseClient;
  userId: string;
  businessId: string;
  type: DisconnectableIntegration;
}): Promise<{ ok: true; disconnected: number } | { ok: false; status: 500; error: string }> {
  const { error, count } = await input.supabase
    .from("integrations")
    .delete({ count: "exact" })
    .eq("business_id", input.businessId)
    .eq("user_id", input.userId)
    .eq("type", input.type);
  if (error) return { ok: false, status: 500, error: error.message };
  return { ok: true, disconnected: count ?? 0 };
}
