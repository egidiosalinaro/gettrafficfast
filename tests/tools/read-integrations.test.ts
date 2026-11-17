import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeSupabase } from "../support/fake-supabase";
import { SITE_B, apiCaller } from "./support";
import { readSeed } from "./read-support";

/**
 * The integration read tools, as an API-key caller on site A with the read
 * scope only. What is pinned: never a credential (the WordPress password,
 * the webhook secret, the Search Console refresh token) in any answer; the
 * site's destinations only; Google refusing is a 503 that changes nothing.
 */

const m = vi.hoisted(() => ({ db: null as unknown, listSites: vi.fn(), refreshed: [] as string[] }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => m.db }));
vi.mock("@/lib/integrations/crypto", () => ({
  decryptSecret: (value: string) => `plain:${value}`,
  encryptSecret: (value: string) => `enc:${value}`,
}));
vi.mock("@/lib/providers/analytics/search-console", () => ({
  refreshAccessToken: async (token: string) => {
    m.refreshed.push(token);
    return "ACCESS-TOKEN";
  },
  listSites: (...args: unknown[]) => m.listSites(...args),
  SearchConsoleProvider: class {},
}));

import { runTool } from "@/lib/tools/runner";

let db: FakeSupabase;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-09T12:00:00.000Z"));
  db = readSeed();
  m.db = db;
  m.refreshed = [];
  m.listSites.mockReset();
  m.listSites.mockResolvedValue([{ siteUrl: "sc-domain:acme.test", permissionLevel: "siteOwner" }]);
});

const call = (name: string, input: unknown = {}) => runTool(apiCaller(db, { scopes: ["read"] }), name, input);
const SECRETS = /SECRET|ACCESS-TOKEN|plain:|_encrypted|password|refresh_token/i;

describe("list_integrations", () => {
  it("lists the site's destinations and Search Console, never a credential", async () => {
    const run = await call("list_integrations");
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(JSON.stringify(run.output)).not.toMatch(SECRETS);
    expect(run.output.publishing).toEqual([
      {
        id: expect.any(String),
        type: "wordpress",
        status: "connected",
        lastError: null,
        lastSyncAt: "2026-11-01T09:00:00.000Z",
        createdAt: "2026-10-01T00:00:00.000Z",
        destination: "https://acme.test",
        username: "editor",
      },
      {
        id: expect.any(String),
        type: "webhook",
        status: "error",
        lastError: "HTTP 500",
        lastSyncAt: null,
        createdAt: "2026-10-02T00:00:00.000Z",
        destination: "https://hooks.acme.test/gtf",
        username: null,
      },
    ]);
    expect(run.output.searchConsole).toMatchObject({ status: "connected", siteUrl: "sc-domain:acme.test", lastSyncedOn: "2026-11-06" });
  });
});

describe("list_search_console_properties", () => {
  it("lists the properties the grant can read, without the token", async () => {
    const run = await call("list_search_console_properties");
    expect(run).toMatchObject({
      ok: true,
      output: {
        connected: true,
        selected: "sc-domain:acme.test",
        websiteUrl: "https://acme.test",
        lastSyncedOn: "2026-11-06",
        sites: [{ siteUrl: "sc-domain:acme.test", permissionLevel: "siteOwner" }],
      },
    });
    expect(JSON.stringify(run)).not.toMatch(SECRETS);
    expect(m.refreshed).toEqual(["plain:SECRET-REFRESH"]);
    expect(m.listSites).toHaveBeenCalledWith("ACCESS-TOKEN");
  });

  it("answers not connected without asking Google", async () => {
    db.tables.analytics_connections = [];
    expect(await call("list_search_console_properties")).toMatchObject({
      ok: true,
      output: { connected: false, selected: null, sites: [], websiteUrl: "https://acme.test" },
    });
    expect(m.listSites).not.toHaveBeenCalled();
  });

  it("reads only this site's connection, never the same account's other site's", async () => {
    db.tables.analytics_connections[0].business_id = SITE_B;
    expect(await call("list_search_console_properties")).toMatchObject({ ok: true, output: { connected: false } });
    expect(await call("list_integrations")).toMatchObject({ ok: true, output: { searchConsole: { status: "absent" } } });
    expect(m.listSites).not.toHaveBeenCalled();
  });

  it("answers 503 unavailable when Google refuses", async () => {
    m.listSites.mockRejectedValue(new Error("Search Console API error 403"));
    expect(await call("list_search_console_properties")).toMatchObject({
      ok: false,
      status: 503,
      error: { code: "unavailable", message: expect.stringContaining("error 403") },
    });
  });
});
