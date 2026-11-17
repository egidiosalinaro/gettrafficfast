import { z } from "zod";
import {
  disconnectSearchConsole,
  searchConsoleConnectPath,
  searchConsoleState,
  selectSearchConsoleProperty,
} from "@/lib/analytics/search-console-connection";
import { kickFirstSearchConsoleSync } from "@/lib/analytics/runs";
import { DISCONNECTABLE_INTEGRATIONS, disconnectIntegration } from "@/lib/integrations/manage";
import { isSearchConsoleConfigured } from "@/lib/providers/analytics/search-console";
import { SITE_URL } from "@/lib/site";
import { MAX_WAIT_SECONDS } from "./jobs";
import { defineTool, ToolError } from "./tool";
import { libRefusal } from "./write-guards";

/**
 * Settings → Connections as tools: disconnecting a destination, and the
 * Search Console grant. Each handler calls the function the route calls
 * (lib/integrations/manage.ts, lib/analytics/search-console-connection.ts).
 *
 * Connecting is the one thing left to a person, on purpose. A WordPress
 * application password or a webhook secret must not pass through an AI
 * chat, so there is no connect_wordpress or connect_webhook tool; Search
 * Console is connected by a person on Google's consent screen, from the
 * link get_search_console_connect_url hands back. The Search Console grant
 * lives in a table users may read but never write, so its writes go
 * through the service role, narrowed by the verified site and user.
 */

export const disconnectIntegrationTool = defineTool({
  name: "disconnect_integration",
  title: "Disconnect a destination",
  description:
    "Disconnects one of this site's publishing destinations (wordpress, webflow, shopify, webhook): its stored credentials are deleted and nothing more is published there. Articles already published stay where they are. Reconnecting is done by a person in Settings → Connections.",
  input: z.object({ type: z.enum(DISCONNECTABLE_INTEGRATIONS) }),
  output: z.object({ type: z.string(), disconnected: z.boolean().describe("False when there was nothing to disconnect.") }),
  scope: "write",
  paid: false,
  destructive: true,
  async handler(ctx, input) {
    const result = await disconnectIntegration({
      supabase: ctx.client,
      userId: ctx.userId,
      businessId: ctx.businessId,
      type: input.type,
    });
    if (!result.ok) throw libRefusal(result);
    return { type: input.type, disconnected: result.disconnected > 0 };
  },
});

export const getSearchConsoleConnectUrl = defineTool({
  name: "get_search_console_connect_url",
  title: "Get the Search Console link",
  description:
    "The link a person opens, signed in, to connect Google Search Console to this site: Google's consent screen, then back to Settings. Nothing is connected until they accept there. Also says whether the site is connected already, and to which property.",
  input: z.object({}),
  output: z.object({
    url: z.string(),
    connected: z.boolean(),
    siteUrl: z.string().nullable().describe("The property ingested from; null until one is picked."),
  }),
  scope: "read",
  paid: false,
  async handler(ctx) {
    if (!isSearchConsoleConfigured()) {
      throw new ToolError("unavailable", "Search Console is not configured on this platform yet.", 503);
    }
    const state = await searchConsoleState({ admin: ctx.admin(), userId: ctx.userId, businessId: ctx.businessId });
    return { url: `${SITE_URL}${searchConsoleConnectPath(ctx.businessId)}`, connected: state.connected, siteUrl: state.siteUrl };
  },
});

export const selectSearchConsolePropertyTool = defineTool({
  name: "select_search_console_property",
  title: "Pick the Search Console property",
  description: `Picks which Search Console property this site's traffic is read from ("sc-domain:example.com" or a URL prefix, as Google lists it). The history read from the previous property stays; the first pull for the new one starts now and is waited for up to ${MAX_WAIT_SECONDS} seconds.`,
  input: z.object({ siteUrl: z.string().trim().min(1).max(500) }),
  output: z.object({
    siteUrl: z.string(),
    lastSyncedOn: z.string().nullable().describe("The newest day read so far."),
    syncing: z.boolean().describe("True while the first pull is still running."),
  }),
  scope: "write",
  paid: false,
  async handler(ctx, input) {
    const admin = ctx.admin();
    const state = await searchConsoleState({ admin, userId: ctx.userId, businessId: ctx.businessId });
    if (!state.connected) {
      throw new ToolError(
        "prerequisite_missing",
        "Search Console is not connected to this site.",
        409,
        "get_search_console_connect_url gives the link a person opens to connect it."
      );
    }
    const result = await selectSearchConsoleProperty({
      admin,
      userId: ctx.userId,
      businessId: ctx.businessId,
      siteUrl: input.siteUrl,
      waitMs: MAX_WAIT_SECONDS * 1000,
    });
    if (!result.ok) throw libRefusal(result);
    return { siteUrl: result.siteUrl, lastSyncedOn: result.lastSyncedOn, syncing: result.syncing };
  },
});

export const syncSearchConsoleTool = defineTool({
  name: "sync_search_console",
  title: "Read Search Console now",
  description: `The first Search Console pull for this site, now, as Growth and Settings → Connections start it when a property was picked but nothing was read yet, so Google's numbers do not wait for the daily read. Waited for up to ${MAX_WAIT_SECONDS} seconds; a longer pull is finished by the job worker. Idempotent: a site already read is left to the daily read (skipped already_synced). Free: Google does not charge for the Search Console API. Reads only, from Google.`,
  input: z.object({}),
  output: z.object({
    skipped: z
      .enum(["already_synced", "no_property", "no_connection"])
      .nullable()
      .describe("Why nothing was pulled: read already (the daily read goes on), no property picked (select_search_console_property), not connected (get_search_console_connect_url)."),
    lastSyncedOn: z.string().nullable().describe("The newest day read so far."),
    syncing: z.boolean().describe("True while the pull is still running."),
    outcome: z.string().nullable().describe("How the pull ended within the wait: completed, failed, retrying, yielded; null when skipped or still running."),
  }),
  scope: "write",
  paid: false,
  async handler(ctx) {
    const result = await kickFirstSearchConsoleSync({
      supabase: ctx.admin(),
      userId: ctx.userId,
      businessId: ctx.businessId,
      waitMs: MAX_WAIT_SECONDS * 1000,
    });
    return {
      skipped: result.skipped ?? null,
      lastSyncedOn: result.lastSyncedOn,
      syncing: result.syncing,
      outcome: result.outcome ?? null,
    };
  },
});

export const disconnectSearchConsoleTool = defineTool({
  name: "disconnect_search_console",
  title: "Disconnect Search Console",
  description:
    "Drops this site's Search Console grant: the stored token is deleted at once. The traffic already read stays; it is the site's own history.",
  input: z.object({}),
  output: z.object({ disconnected: z.boolean().describe("False when it was not connected.") }),
  scope: "write",
  paid: false,
  destructive: true,
  async handler(ctx) {
    const admin = ctx.admin();
    const state = await searchConsoleState({ admin, userId: ctx.userId, businessId: ctx.businessId });
    const result = await disconnectSearchConsole({ admin, userId: ctx.userId, businessId: ctx.businessId });
    if (!result.ok) throw libRefusal(result);
    return { disconnected: state.connected };
  },
});

export const WRITE_INTEGRATION_TOOLS = [
  disconnectIntegrationTool,
  getSearchConsoleConnectUrl,
  selectSearchConsolePropertyTool,
  syncSearchConsoleTool,
  disconnectSearchConsoleTool,
] as const;
