import { z } from "zod";
import { API_KEY_SCOPES } from "@/lib/api-keys";
import { listBusinesses } from "@/lib/tenancy";
import { defineTool } from "./tool";

/**
 * Tools about the caller rather than a site. `whoami` is the first call an
 * agent makes: which account, which credential, which scopes, and which
 * site every other tool will act on (and which it could name with
 * `x-gtf-business`).
 */

const Site = z.object({ id: z.string(), name: z.string().nullable(), websiteUrl: z.string().nullable() });

export const whoami = defineTool({
  name: "whoami",
  title: "Who am I",
  description:
    "Who this credential acts for: the account, whether it is a session, an API key or an app connected with OAuth (claude.ai), its scopes, the site every other tool acts on, and the sites it may name with the x-gtf-business header. Call it first.",
  input: z.object({}),
  output: z.object({
    userId: z.string(),
    via: z.enum(["session", "api_key", "oauth"]),
    keyId: z.string().nullable(),
    oauthClientId: z.string().nullable().describe("The connected app, for an OAuth caller; null otherwise."),
    scopes: z.array(z.enum(API_KEY_SCOPES)),
    business: Site.nullable().describe("The site tools act on; null when the account has none yet."),
    businesses: z.array(Site).describe("The sites this credential may act on."),
  }),
  scope: "read",
  paid: false,
  needsBusiness: false,
  async handler(ctx) {
    const { caller } = ctx;
    const owned = await listBusinesses(caller.client, caller.userId);
    const allowed = owned
      .filter((b) => caller.businessIds.includes(b.id))
      .map((b) => ({ id: b.id, name: b.name, websiteUrl: b.website_url }));
    return {
      userId: caller.userId,
      via: caller.via,
      keyId: caller.keyId,
      oauthClientId: caller.oauth?.clientId ?? null,
      scopes: [...caller.scopes],
      business: allowed.find((b) => b.id === caller.businessId) ?? null,
      businesses: allowed,
    };
  },
});

export const ACCOUNT_TOOLS = [whoami] as const;
