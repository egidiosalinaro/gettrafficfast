import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Recent deliveries are per site, not per account.
 *
 * `user_id` is who may see the row (RLS). `business_id` is which site the
 * settings page is about. Filtering only by the user mixes every site's
 * webhook (or WordPress) deliveries into the same list — the leftover from
 * when an account held exactly one business.
 */
export function recentDeliveriesEq(params: {
  userId: string;
  businessId: string;
  integrationType: string;
}): { user_id: string; business_id: string; integration_type: string } {
  return {
    user_id: params.userId,
    business_id: params.businessId,
    integration_type: params.integrationType,
  };
}

/** One publish attempt, as "Recent deliveries" lists it. */
export interface DeliveryRecord {
  id: string;
  articleId: string | null;
  integrationType: string;
  ok: boolean;
  /** Where the article went live, on a delivery that worked. */
  publishedUrl: string | null;
  /** Why it did not, on one that failed. */
  error: string | null;
  createdAt: string;
}

/** The most attempts a list reads at once. */
export const MAX_DELIVERIES = 100;

/**
 * The site's last publish attempts, newest first: Settings → Connections →
 * Recent deliveries (one destination type) and `list_deliveries` (one type,
 * or every type). Worked and failed both: a failure is the delivery a person
 * most needs to see. The request and response bodies stored with an attempt
 * are never read here.
 */
export async function listDeliveries(
  supabase: SupabaseClient,
  params: { userId: string; businessId: string; integrationType?: string | null; limit?: number }
): Promise<DeliveryRecord[]> {
  const scope: Record<string, string> = params.integrationType
    ? recentDeliveriesEq({ userId: params.userId, businessId: params.businessId, integrationType: params.integrationType })
    : { user_id: params.userId, business_id: params.businessId };
  let query = supabase.from("publish_attempts").select("id, article_id, integration_type, ok, published_url, error, created_at");
  for (const [column, value] of Object.entries(scope)) query = query.eq(column, value);
  const { data } = await query
    .order("created_at", { ascending: false })
    .limit(Math.max(1, Math.min(Math.floor(params.limit ?? 10), MAX_DELIVERIES)));

  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    id: row.id as string,
    articleId: (row.article_id as string | null) ?? null,
    integrationType: String(row.integration_type ?? ""),
    ok: row.ok === true,
    publishedUrl: (row.published_url as string | null) ?? null,
    error: (row.error as string | null) ?? null,
    createdAt: row.created_at as string,
  }));
}
