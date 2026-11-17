import { z } from "zod";
import { loadSearchConsoleProperties } from "@/lib/analytics/properties";
import { listIntegrations } from "@/lib/integrations/read";
import { loadSearchConsoleStatus } from "@/lib/lifecycle/load-results";
import { listBusinesses } from "@/lib/tenancy";
import { SearchConsoleView } from "./read-results";
import { defineTool, ToolError } from "./tool";

/**
 * Settings → Connections as tools: where the site publishes and whether
 * Search Console is connected (`list_integrations`), and which Search
 * Console properties the grant can read (`list_search_console_properties`).
 *
 * Never a secret. A destination's credentials (`config.*_encrypted`) are
 * dropped by lib/integrations/read.ts before anything here sees the config,
 * and the output names only the fields below; the Search Console refresh
 * token is decrypted inside lib/analytics/properties.ts and never returned.
 * Free: listing properties asks Google, which costs nothing.
 */

const str = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

export const listIntegrationsTool = defineTool({
  name: "list_integrations",
  title: "List integrations",
  description:
    "Where this site publishes (WordPress or a webhook: status connected, error or disconnected, the last error, the last delivery, the address it posts to) and its Search Console connection (absent, connected or error; the property; the newest day fetched). Never a password, secret or token.",
  input: z.object({}),
  output: z.object({
    publishing: z.array(
      z.object({
        id: z.string(),
        type: z.string().describe("wordpress or webhook."),
        status: z.string().describe("connected, error or disconnected."),
        lastError: z.string().nullable(),
        lastSyncAt: z.string().nullable(),
        createdAt: z.string().nullable(),
        destination: z.string().nullable().describe("The WordPress site, or the webhook's URL."),
        username: z.string().nullable().describe("The WordPress user articles are published as."),
      })
    ),
    searchConsole: SearchConsoleView,
  }),
  scope: "read",
  paid: false,
  async handler(ctx) {
    const [listed, searchConsole] = await Promise.all([
      listIntegrations(ctx.client, ctx.businessId),
      loadSearchConsoleStatus(ctx.client, ctx.businessId),
    ]);
    if (!listed.ok) throw new Error(`integrations: ${listed.error}`);
    return {
      publishing: listed.integrations.map((row) => ({
        id: row.id as string,
        type: String(row.type ?? ""),
        status: String(row.status ?? ""),
        lastError: str(row.last_error),
        lastSyncAt: str(row.last_sync_at),
        createdAt: str(row.created_at),
        destination: str(row.config.site_url) ?? str(row.config.url),
        username: str(row.config.username),
      })),
      searchConsole,
    };
  },
});

export const listSearchConsoleProperties = defineTool({
  name: "list_search_console_properties",
  title: "List Search Console properties",
  description:
    "The Search Console properties the site's Google grant can read, with the one selected for this site, the site's own URL, the newest day fetched and whether a first pull is running. connected false (and no properties) when Search Console is not connected for this site.",
  input: z.object({}),
  output: z.object({
    connected: z.boolean(),
    selected: z.string().nullable(),
    websiteUrl: z.string().nullable(),
    lastSyncedOn: z.string().nullable(),
    pulledAt: z.string().nullable(),
    stale: z.boolean(),
    syncing: z.boolean(),
    sites: z.array(z.object({ siteUrl: z.string(), permissionLevel: z.string() })),
  }),
  scope: "read",
  paid: false,
  async handler(ctx) {
    const business = (await listBusinesses(ctx.client, ctx.userId)).find((b) => b.id === ctx.businessId);
    if (!business) throw new ToolError("not_found", "This site is no longer part of the account.", 404);

    let properties;
    try {
      // The service role, as the screen's route: the token is decrypted there and never returned.
      properties = await loadSearchConsoleProperties(ctx.admin(), business);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ToolError(
        "unavailable",
        `Search Console did not list the properties: ${reason.slice(0, 300)}`,
        503,
        "Reconnect Search Console in Settings → Connections if this keeps happening."
      );
    }
    if (!properties.connected) {
      return {
        connected: false,
        selected: null,
        websiteUrl: properties.websiteUrl,
        lastSyncedOn: null,
        pulledAt: null,
        stale: false,
        syncing: false,
        sites: [],
      };
    }
    return properties;
  },
});

export const INTEGRATION_READ_TOOLS = [listIntegrationsTool, listSearchConsoleProperties] as const;
