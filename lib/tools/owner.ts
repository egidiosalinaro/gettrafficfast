import { z } from "zod";
import { isPlatformOwner, isPlatformOwnerHere } from "@/lib/owner";
import { readPlatformCosts } from "@/lib/limits/platform-costs";
import { ToolError, defineTool, type Tool } from "./tool";
import { TOOLS, createRegistry, type ToolRegistry } from "./registry";

/**
 * The owner's tools (docs/API.md "The owner's costs"): what the platform
 * pays, read over the API and MCP by a platform owner (lib/owner.ts) only.
 *
 * They are NOT in `TOOLS`, the registry everyone sees: the public catalogue
 * (`GET /api/v1/tools`), the public docs and a customer's `tools/list` never
 * name them. `registryFor` adds them for an owner's session, key or connected
 * app; for anyone else a call is the 404 `unknown_tool` a name that does not
 * exist gets, so nothing says they are there. Each handler checks the owner
 * again, so a registry built by mistake still refuses.
 *
 * Per site (lib/owner.ts `isPlatformOwnerHere`): with
 * PLATFORM_OWNER_BUSINESS_IDS set, they are listed and answer only when the
 * call's site is one of the platform's own. They take no `site` argument
 * (they are not about a site), so the call's site is the connection's: the
 * `x-gtf-business` header, else the key's or the app's saved default site,
 * else the oldest; in the browser, the selected site. `tools/list` (one per
 * connection) and the call are decided by that same site, so what is listed
 * is what answers. On another site an owner's `tools/list` is a customer's,
 * and a call by name is refused with `offSiteOwnerTool`'s 404, which says
 * where the tool answers (only an owner ever reads it).
 *
 * Read only, on purpose: setting an account's ceiling stays a signed-in
 * session's act on /settings/costs, so a key, even an owner's, can never
 * raise a spend ceiling.
 */

const ProviderCostSchema = z.object({
  provider: z.string(),
  label: z.string(),
  costUsd: z.number().describe("The month's estimated cost from the ledger (provider_spend); 0 when nothing was called."),
  calls: z.number(),
  posts: z.number(),
  capUsd: z.number().nullable().describe("The platform's hard monthly cap for this provider, when it has one."),
  capReached: z.boolean(),
  enabled: z.boolean().nullable(),
  pausedUntil: z.string().nullable(),
});

const AccountCostSchema = z.object({
  userId: z.string(),
  email: z.string().nullable(),
  site: z.string().nullable(),
  subscription: z.string().nullable(),
  spentUsd: z.number().describe("Model cost over the rolling 24 hours: measured plus estimated."),
  measuredUsd: z.number(),
  estimatedUsd: z.number().describe("Runs that recorded no cost, counted at a conservative estimate, never $0."),
  runs: z.number().int(),
  unmeasuredRuns: z.number().int(),
  ceilingUsd: z.number(),
  ceilingSource: z.enum(["account", "env", "default"]),
  reached: z.boolean(),
  freesAt: z.string().nullable(),
});

export const getPlatformCosts = defineTool({
  name: "get_platform_costs",
  title: "Get the platform's costs",
  description:
    "Owner only. This month's platform spend per provider from the ledger (the X API against its monthly cap, and any other provider it holds), and each account's model cost over the last 24 hours against its daily AI spend ceiling, with the estimated part apart. Figures are estimates from published prices, not invoices. Changing a ceiling is not a tool: it is done signed in, on /settings/costs.",
  input: z.object({}),
  output: z.object({
    month: z.string(),
    resetsAt: z.string(),
    providers: z.array(ProviderCostSchema).nullable(),
    providersError: z.string().nullable(),
    since: z.string(),
    accounts: z.array(AccountCostSchema).nullable(),
    accountsError: z.string().nullable(),
    accountsComplete: z.boolean().describe("False when there were more runs than were read: the totals are floors."),
    aiTotalUsd: z.number().nullable(),
    defaultCeiling: z.object({ usd: z.number(), source: z.enum(["account", "env", "default"]) }),
    bounds: z.object({ minUsd: z.number(), maxUsd: z.number() }),
  }),
  scope: "read",
  paid: false,
  needsBusiness: false,
  // The platform's books, not product use: the handler's owner check is the gate.
  withoutPlan: true,
  async handler(ctx) {
    if (!isPlatformOwnerHere(ctx.userId, ctx.businessId || null)) throw new ToolError("unknown_tool", "There is no tool named get_platform_costs.", 404);
    return readPlatformCosts(ctx.admin());
  },
});

export const OWNER_TOOLS: readonly Tool[] = [getPlatformCosts];

let ownerRegistry: ToolRegistry | null = null;

/**
 * The registry `userId` may use on `businessId`, the site of the connection
 * or of the call: everyone's tools, plus the owner's tools for a platform
 * owner on one of the platform's own sites (any site when
 * PLATFORM_OWNER_BUSINESS_IDS is unset). Fail closed: with
 * `PLATFORM_OWNER_USER_IDS` unset, nobody gets them.
 */
export function registryFor(
  userId: string,
  businessId: string | null,
  env: Record<string, string | undefined> = process.env
): ToolRegistry {
  if (!isPlatformOwnerHere(userId, businessId, env)) return TOOLS;
  ownerRegistry ??= createRegistry([...TOOLS.list(), ...OWNER_TOOLS]);
  return ownerRegistry;
}

/**
 * The refusal for an owner's tool called by a platform owner on a site that
 * is not one of the platform's (PLATFORM_OWNER_BUSINESS_IDS): the same 404
 * `unknown_tool` a customer gets, saying where it answers. Null for anyone
 * else (a customer gets the plain "no tool named" 404, word for word) and
 * for a name that is not an owner's tool.
 */
export function offSiteOwnerTool(
  userId: string,
  name: string,
  env: Record<string, string | undefined> = process.env
): ToolError | null {
  if (!OWNER_TOOLS.some((tool) => tool.name === name)) return null;
  if (!isPlatformOwner(userId, env)) return null;
  return new ToolError(
    "unknown_tool",
    `${name} answers only on the platform's own site, and this call acts on another site.`,
    404,
    "Send the x-gtf-business header with the platform's site, or make it this connection's default site (set_default_site): tools/list then lists it."
  );
}
