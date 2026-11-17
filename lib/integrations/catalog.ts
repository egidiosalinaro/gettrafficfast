/**
 * The integrations catalog is one screen for two kinds of connection.
 *
 * Publishing destinations live in `integrations`. Analytics sources live in
 * `analytics_connections` — Search Console was deliberately kept out of the
 * publisher table because a broken destination stops delivery and a broken
 * grant only stops measurement (`docs/ANALYTICS.md`). The catalog still has
 * to show both as Connected / Manage; reading only `integrations` makes a
 * working Search Console grant look like it was never connected.
 */

export const SEARCH_CONSOLE_CATALOG_ID = "search-console";

/** Must match `SEARCH_CONSOLE` in lib/analytics/search-console.ts. */
const SEARCH_CONSOLE_PROVIDER = "search_console";

const ANALYTICS_PROVIDER_TO_CATALOG_ID: Record<string, string> = {
  [SEARCH_CONSOLE_PROVIDER]: SEARCH_CONSOLE_CATALOG_ID,
};

export interface CatalogPublishingRow {
  type: string;
  status: string;
}

export interface CatalogAnalyticsRow {
  provider: string;
  status: string;
}

function isCatalogConnected(status: string): boolean {
  return status === "connected";
}

/**
 * Card ids that should show the Connected badge and Manage CTA.
 *
 * Publishing types match the catalog id as stored (`webhook`, `wordpress`).
 * Analytics providers do not: the table key is `search_console`, the card
 * and route are `search-console`.
 */
export function connectedCatalogIds(input: {
  publishing: CatalogPublishingRow[];
  analytics: CatalogAnalyticsRow[];
}): Set<string> {
  const ids = new Set<string>();
  for (const row of input.publishing) {
    if (isCatalogConnected(row.status)) ids.add(row.type);
  }
  for (const row of input.analytics) {
    if (!isCatalogConnected(row.status)) continue;
    const id = ANALYTICS_PROVIDER_TO_CATALOG_ID[row.provider];
    if (id) ids.add(id);
  }
  return ids;
}
