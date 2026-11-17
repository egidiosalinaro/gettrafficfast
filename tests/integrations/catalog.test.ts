import { describe, expect, it } from "vitest";
import { SEARCH_CONSOLE } from "@/lib/analytics/search-console";
import {
  SEARCH_CONSOLE_CATALOG_ID,
  connectedCatalogIds,
} from "@/lib/integrations/catalog";

/**
 * The catalog Connected badge is the union of two tables. These tests exist
 * because looking only at `integrations` is the path that compiles, ships,
 * and leaves a connected Search Console grant looking like "Enable
 * Integration".
 */

describe("connectedCatalogIds", () => {
  it("marks a connected webhook the way the catalog already did", () => {
    const ids = connectedCatalogIds({
      publishing: [{ type: "webhook", status: "connected" }],
      analytics: [],
    });
    expect(ids.has("webhook")).toBe(true);
    expect(ids.has(SEARCH_CONSOLE_CATALOG_ID)).toBe(false);
  });

  it("marks Search Console from analytics_connections, not integrations", () => {
    const ids = connectedCatalogIds({
      publishing: [],
      analytics: [{ provider: SEARCH_CONSOLE, status: "connected" }],
    });
    expect(ids.has(SEARCH_CONSOLE_CATALOG_ID)).toBe(true);
    expect(ids.has(SEARCH_CONSOLE)).toBe(false);
  });

  it("keeps both kinds of connection on the same catalog", () => {
    const ids = connectedCatalogIds({
      publishing: [
        { type: "webhook", status: "connected" },
        { type: "wordpress", status: "connected" },
      ],
      analytics: [{ provider: SEARCH_CONSOLE, status: "connected" }],
    });
    expect(ids.has("webhook")).toBe(true);
    expect(ids.has("wordpress")).toBe(true);
    expect(ids.has(SEARCH_CONSOLE_CATALOG_ID)).toBe(true);
  });

  it("does not treat a disconnected or broken grant as Connected", () => {
    const ids = connectedCatalogIds({
      publishing: [{ type: "webhook", status: "error" }],
      analytics: [
        { provider: SEARCH_CONSOLE, status: "disconnected" },
        { provider: SEARCH_CONSOLE, status: "error" },
      ],
    });
    expect(ids.size).toBe(0);
  });

  it("does not invent a connection when both tables are empty", () => {
    expect(
      connectedCatalogIds({ publishing: [], analytics: [] }).size
    ).toBe(0);
  });
});
