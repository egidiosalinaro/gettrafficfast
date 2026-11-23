import { z } from "zod";
import { DEFAULT_SITE_SOURCES, type Caller, type DefaultSite } from "@/lib/api-auth";
import { API_KEY_SCOPES } from "@/lib/api-keys";
import { HINTS } from "@/lib/api-errors";
import { listBusinesses, type BusinessSummary } from "@/lib/tenancy";
import { saveDefaultSite } from "./site";
import { defineTool, ToolError } from "./tool";

/**
 * Tools about the caller rather than a site. `whoami` is the first call an
 * agent makes: which account, which credential, which scopes, which site
 * every other tool acts on by default, and the sites it may name instead
 * with any tool's `site` argument (or the `x-gtf-business` header).
 * `set_default_site` changes that default for the credential it is called
 * with, as Settings → Claude and API does for any key or connected app.
 */

const Site = z.object({ id: z.string(), name: z.string().nullable(), websiteUrl: z.string().nullable() });

const site = (b: BusinessSummary) => ({ id: b.id, name: b.name, websiteUrl: b.website_url });

const DefaultSource = z
  .enum(DEFAULT_SITE_SOURCES)
  .describe(
    "Where the default comes from: saved (set with set_default_site or in Settings), oldest (none saved: the account's oldest site), only_site (this key or connection is limited to one site), selected (a browser session: the site picker)."
  );

/** The caller's default site; for a caller built without one, what resolveCaller would have said. */
export function defaultSiteOf(caller: Caller): DefaultSite {
  if (caller.defaultSite) return caller.defaultSite;
  if (caller.via === "session") return { businessId: caller.businessId, source: "selected" };
  const limited = caller.oauth ? caller.oauth.siteLimited : caller.businessIds.length === 1;
  return { businessId: caller.businessId, source: limited ? "only_site" : "oldest" };
}

export const whoami = defineTool({
  name: "whoami",
  title: "Who am I",
  description:
    "Who this credential acts for: the account, whether it is a session, an API key or an app connected with OAuth (claude.ai), its scopes, the site every other tool acts on by default (defaultSite: saved with set_default_site, else the oldest) and the sites it may use. Every site-scoped tool takes an optional site argument (one of these sites' id, name or domain) to act on another of them; with several sites, use the one the person named, else the saved default, else ask. Call it first.",
  input: z.object({}),
  output: z.object({
    userId: z.string(),
    via: z.enum(["session", "api_key", "oauth"]),
    keyId: z.string().nullable(),
    oauthClientId: z.string().nullable().describe("The connected app, for an OAuth caller; null otherwise."),
    scopes: z.array(z.enum(API_KEY_SCOPES)),
    business: Site.nullable().describe("The site this call acts on: the default, or the one the x-gtf-business header names; null when the account has none yet."),
    defaultSite: Site.nullable().describe("The site tools act on when a call names none; null when the account has none yet. set_default_site changes it."),
    defaultSource: DefaultSource,
    businesses: z.array(Site).describe("The sites this credential may act on, oldest first: any of them can be named with a tool's site argument."),
  }),
  scope: "read",
  paid: false,
  needsBusiness: false,
  async handler(ctx) {
    const { caller } = ctx;
    const owned = await listBusinesses(caller.client, caller.userId);
    const allowed = owned.filter((b) => caller.businessIds.includes(b.id)).map(site);
    const fallback = defaultSiteOf(caller);
    return {
      userId: caller.userId,
      via: caller.via,
      keyId: caller.keyId,
      oauthClientId: caller.oauth?.clientId ?? null,
      scopes: [...caller.scopes],
      business: allowed.find((b) => b.id === caller.businessId) ?? null,
      defaultSite: allowed.find((b) => b.id === fallback.businessId) ?? null,
      defaultSource: fallback.source,
      businesses: allowed,
    };
  },
});

/**
 * The default site of this key or this connection: the site its calls act
 * on when they name none. Saved on the credential (the key, or the grant
 * the connected app holds), so it lasts across chats until changed, and
 * shown in Settings → Claude and API, where the person can change it too
 * (the same function, lib/tools/site.ts `saveDefaultSite`). A browser
 * session has no credential to save it on: its site picker is the default,
 * so the call is refused with that said.
 */
export const setDefaultSite = defineTool({
  name: "set_default_site",
  title: "Set the default site",
  description:
    "Changes the site this connection (or API key) acts on when a call names none, and saves it on the connection: use it when the person says to make a site their default (\"work on Bravo by default\"). site is one of whoami's businesses, by id, name or domain; null goes back to the oldest site. A site named in a call still wins for that call. A connection limited to one site always acts on that site.",
  input: z.object({
    site: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .nullable()
      .describe("The new default site: its id, name or domain (case does not matter). null: no saved default, the oldest site."),
  }),
  output: z.object({
    defaultSite: Site.nullable().describe("The site calls that name none now act on; null when the account has no site yet."),
    defaultSource: DefaultSource,
  }),
  scope: "write",
  paid: false,
  needsBusiness: false,
  async handler(ctx, input) {
    const { caller } = ctx;
    if (caller.via === "session") {
      throw new ToolError(
        "invalid_state",
        "A browser session has no saved default site: the site picker at the top of the screens chooses it. set_default_site saves the default of an API key or a connected app.",
        409,
        HINTS.keys
      );
    }
    const credential =
      caller.via === "api_key" && caller.keyId
        ? ({ kind: "api_key", id: caller.keyId } as const)
        : caller.via === "oauth" && caller.oauth
          ? ({ kind: "oauth", grantId: caller.oauth.grantId } as const)
          : null;
    if (!credential) throw new Error("set_default_site: the caller names no credential.");
    const saved = await saveDefaultSite(ctx.admin(), { userId: caller.userId, credential, value: input.site });
    if (!saved.ok) throw saved.error;
    return { defaultSite: saved.site ? site(saved.site) : null, defaultSource: saved.source };
  },
});

export const ACCOUNT_TOOLS = [whoami] as const;

/** Registered with the write tools, after the site's own settings. */
export const DEFAULT_SITE_TOOLS = [setDefaultSite] as const;
