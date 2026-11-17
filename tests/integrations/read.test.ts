import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "../support/fake-supabase";

/**
 * The integration reads the settings screens make, now lib functions the
 * tools share: the publishing destinations without their credentials
 * (lib/integrations/read.ts) and the Search Console properties
 * (lib/analytics/properties.ts). Pinned: both routes' answers, captured
 * before the reads moved.
 */

const m = vi.hoisted(() => ({
  db: null as unknown as FakeSupabase,
  businessId: "biz-1" as string | null,
  listSites: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => m.db.from(table),
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => m.db }));
vi.mock("@/lib/tenancy", () => ({
  selectedBusinessId: async () => m.businessId,
  selectedBusiness: async () =>
    m.businessId ? { id: m.businessId, name: "Acme", website_url: "https://acme.test" } : null,
}));
vi.mock("@/lib/integrations/crypto", () => ({
  decryptSecret: (value: string) => `plain:${value}`,
  encryptSecret: (value: string) => `enc:${value}`,
}));
vi.mock("@/lib/providers/analytics/search-console", () => ({
  refreshAccessToken: async (token: string) => `access-for-${token}`,
  listSites: (...args: unknown[]) => m.listSites(...args),
  SearchConsoleProvider: class {},
}));

import { GET as listIntegrations } from "@/app/api/integrations/list/route";
import { GET as listProperties } from "@/app/api/integrations/search-console/sites/route";

const owned = { user_id: "user-1", business_id: "biz-1" };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-09T12:00:00.000Z"));
  m.businessId = "biz-1";
  m.listSites.mockReset();
  m.listSites.mockResolvedValue([
    { siteUrl: "sc-domain:acme.test", permissionLevel: "siteOwner" },
    { siteUrl: "https://blog.acme.test/", permissionLevel: "siteFullUser" },
  ]);
  m.db = new FakeSupabase({
    integrations: [
      {
        id: "int-1",
        ...owned,
        type: "wordpress",
        status: "connected",
        last_error: null,
        last_sync_at: "2026-11-08T08:00:00.000Z",
        created_at: "2026-10-01T00:00:00.000Z",
        config: { site_url: "https://acme.test", username: "editor", application_password_encrypted: "SECRET-1" },
      },
      {
        id: "int-2",
        ...owned,
        type: "webhook",
        status: "error",
        last_error: "HTTP 500",
        last_sync_at: null,
        created_at: "2026-10-02T00:00:00.000Z",
        config: { url: "https://hooks.acme.test/gtf", secret_encrypted: "SECRET-2" },
      },
      {
        id: "int-9",
        user_id: "user-1",
        business_id: "biz-2",
        type: "webhook",
        status: "connected",
        config: { url: "https://other.test" },
      },
    ],
    analytics_connections: [
      {
        id: "ac-1",
        ...owned,
        provider: "search_console",
        site_url: "sc-domain:acme.test",
        status: "connected",
        last_error: null,
        last_synced_on: "2026-11-06",
        updated_at: "2026-11-09T07:00:00.000Z",
        refresh_token_encrypted: "REFRESH",
      },
    ],
    jobs: [],
  });
});

describe("GET /api/integrations/list", () => {
  it("answers exactly what it answered before the read moved to lib, without credentials", async () => {
    const response = await listIntegrations();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(JSON.stringify(body)).not.toMatch(/SECRET|_encrypted/);
    expect(body).toMatchInlineSnapshot(`
      {
        "integrations": [
          {
            "business_id": "biz-1",
            "config": {
              "site_url": "https://acme.test",
              "username": "editor",
            },
            "created_at": "2026-10-01T00:00:00.000Z",
            "id": "int-1",
            "last_error": null,
            "last_sync_at": "2026-11-08T08:00:00.000Z",
            "status": "connected",
            "type": "wordpress",
            "user_id": "user-1",
          },
          {
            "business_id": "biz-1",
            "config": {
              "url": "https://hooks.acme.test/gtf",
            },
            "created_at": "2026-10-02T00:00:00.000Z",
            "id": "int-2",
            "last_error": "HTTP 500",
            "last_sync_at": null,
            "status": "error",
            "type": "webhook",
            "user_id": "user-1",
          },
        ],
      }
    `);
  });
});

describe("GET /api/integrations/search-console/sites", () => {
  it("answers exactly what it answered before the read moved to lib", async () => {
    const response = await listProperties();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(JSON.stringify(body)).not.toMatch(/REFRESH/);
    expect(body).toMatchInlineSnapshot(`
      {
        "connected": true,
        "lastSyncedOn": "2026-11-06",
        "pulledAt": "2026-11-09T07:00:00.000Z",
        "selected": "sc-domain:acme.test",
        "sites": [
          {
            "permissionLevel": "siteOwner",
            "siteUrl": "sc-domain:acme.test",
          },
          {
            "permissionLevel": "siteFullUser",
            "siteUrl": "https://blog.acme.test/",
          },
        ],
        "stale": true,
        "syncing": false,
        "websiteUrl": "https://acme.test",
      }
    `);
    expect(m.listSites).toHaveBeenCalledWith("access-for-plain:REFRESH");
  });

  it("answers not connected without asking Google", async () => {
    m.db.tables.analytics_connections = [];
    const response = await listProperties();
    expect(await response.json()).toMatchInlineSnapshot(`
      {
        "connected": false,
        "sites": [],
        "websiteUrl": "https://acme.test",
      }
    `);
    expect(m.listSites).not.toHaveBeenCalled();
  });

  it("answers 502 with the reason when Google refuses", async () => {
    m.listSites.mockRejectedValue(new Error("Search Console API error 403"));
    const response = await listProperties();
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Search Console API error 403" });
  });
});
