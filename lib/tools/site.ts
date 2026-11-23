import { z } from "zod";
import type { Caller, DefaultSiteSource } from "@/lib/api-auth";
import { HINTS } from "@/lib/api-errors";
import { findLiveApiKey, setApiKeyDefaultSite } from "@/lib/api-keys";
import { findLiveConnectedApp, setConnectedAppDefaultSite } from "@/lib/oauth/tokens";
import { ownerScopedClient } from "@/lib/supabase/owner-scoped";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listBusinesses, type BusinessSummary } from "@/lib/tenancy";
import { ToolError, type Tool } from "./tool";

/**
 * The `site` argument (docs/API.md "Choosing the site"): every site-scoped
 * tool takes it, so an agent that cannot send the `x-gtf-business` header
 * (claude.ai, the Claude apps) can still choose the site in each call.
 *
 * It is added here, once, not in each tool's schema: `describeTool`
 * (lib/tools/schema.ts) adds it to the published input schema of every
 * tool that `needsBusiness`, and the runner (lib/tools/runner.ts) takes it
 * off the input, resolves it, and hands the handler that site, before the
 * ownership checks. A handler never sees `site`.
 *
 * The site is one of the sites the credential covers (`caller.businessIds`),
 * named by its id, its name or its domain, case-insensitively, and only when
 * exactly one site matches. A grant or a key limited to one site can never
 * reach another through it. Without `site`, nothing changes: the header's
 * site, the key's or the grant's, else the oldest.
 */

export const SITE_ARGUMENT_NAME = "site";

export const SiteArgument = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe(
    "Optional. Which site this call acts on: its id, its name or its domain (case does not matter), one of the sites whoami lists. Without it, the connection's default site (whoami's business)."
  );

/** Whether `tool` takes the `site` argument: every tool that acts on a site. */
export function takesSite(tool: Pick<Tool, "needsBusiness">): boolean {
  return tool.needsBusiness !== false;
}

/** `example.com` from `https://www.Example.com/blog/`, or null when it is not an address. */
export function siteHost(value: string | null | undefined): string | null {
  const raw = value?.trim().toLowerCase();
  if (!raw) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(raw) ? raw : `https://${raw}`);
    const host = url.hostname.replace(/^www\./, "").replace(/\.$/, "");
    return host.includes(".") ? host : null;
  } catch {
    return null;
  }
}

/** A site as an error message lists it: `Acme (acme.test, id …)`. */
function label(site: BusinessSummary): string {
  const host = siteHost(site.website_url);
  const name = site.name?.trim() || host || "Unnamed site";
  return `${name} (${host && host !== name.toLowerCase() ? `${host}, ` : ""}id ${site.id})`;
}

/** The sites `value` names among `sites`: by id first, else by name or domain. */
export function matchSites(sites: readonly BusinessSummary[], value: string): BusinessSummary[] {
  const wanted = value.trim().toLowerCase();
  if (!wanted) return [];
  const byId = sites.filter((site) => site.id.toLowerCase() === wanted);
  if (byId.length > 0) return byId;
  const host = siteHost(wanted);
  return sites.filter(
    (site) => site.name?.trim().toLowerCase() === wanted || (host !== null && siteHost(site.website_url) === host)
  );
}

export type SiteChoice = { ok: true; site: BusinessSummary } | { ok: false; error: ToolError };

/**
 * Which of the caller's sites `value` names. Pure: `owned` is every site of
 * the account, oldest first; `allowed` the ids the credential covers.
 * Refusals list the sites it covers, so the agent can ask the person.
 */
export function chooseSite(
  owned: readonly BusinessSummary[],
  allowed: readonly string[],
  value: string,
  via: Caller["via"] = "oauth"
): SiteChoice {
  const covered = owned.filter((site) => allowed.includes(site.id));
  const list = covered.length > 0 ? covered.map(label).join("; ") : "none";
  const hint = "Pass site as one of these, or leave it out for the default site. whoami lists them.";
  const matches = matchSites(covered, value);
  if (matches.length === 1) return { ok: true, site: matches[0] };
  if (matches.length > 1) {
    return {
      ok: false,
      error: new ToolError(
        "invalid_input",
        `site: "${value}" names ${matches.length} sites (${matches.map(label).join("; ")}). Name it by its id or its domain.`,
        400,
        hint
      ),
    };
  }
  if (matchSites(owned, value).length > 0) {
    return {
      ok: false,
      error: new ToolError(
        "forbidden_business",
        `This ${via === "api_key" ? "key" : "connection"} is limited to one site and cannot act on "${value}". Sites it may use: ${list}.`,
        403,
        via === "api_key"
          ? `Use a key for every site. ${HINTS.keys}`
          : `Remove the connector and connect again, choosing All my sites on the consent screen. ${HINTS.connectedApps}`
      ),
    };
  }
  return {
    ok: false,
    error: new ToolError(
      "business_not_found",
      `No site this ${via === "api_key" ? "key" : "connection"} may use is called "${value}". Sites it may use: ${list}.`,
      404,
      hint
    ),
  };
}

/**
 * `caller`, moved to the site `value` names: its `businessId`, and for a key
 * or a connected app its owner-scoped client narrowed to that site (a
 * session keeps its RLS client). Throws a `ToolError` when `value` names no
 * site the caller covers, or several.
 */
export async function callerForSite(caller: Caller, value: string, admin: () => SupabaseClient): Promise<Caller> {
  const owned = await listBusinesses(caller.client, caller.userId);
  const choice = chooseSite(owned, caller.businessIds, value, caller.via);
  if (!choice.ok) throw choice.error;
  const businessId = choice.site.id;
  if (businessId === caller.businessId) return caller;
  return {
    ...caller,
    businessId,
    client:
      caller.via === "session" ? caller.client : ownerScopedClient(admin(), { userId: caller.userId, businessIds: [businessId] }),
  };
}

/** The credential whose default site is saved: an API key, or a connected app's grant. */
export type DefaultSiteCredential = { kind: "api_key"; id: string } | { kind: "oauth"; grantId: string };

export type SaveDefaultSiteResult =
  | { ok: true; site: BusinessSummary | null; source: Exclude<DefaultSiteSource, "selected"> }
  | { ok: false; error: ToolError };

/**
 * Saves the site a key or a connected app acts on when a call names none
 * (docs/API.md "The default site"): what `set_default_site` does for the
 * credential it is called with, and what Settings → Claude and API does for
 * any of the person's keys and apps (PATCH /api/api-keys/:id and
 * /api/connected-apps/:id). One function for both, so the screen and the
 * tool cannot disagree.
 *
 * `value` names the site as the `site` argument does (`chooseSite`: id,
 * name or domain, among the sites the credential covers); null clears the
 * default, back to the oldest site. A credential limited to one site keeps
 * that site whatever is saved: naming it is accepted (and saved), naming
 * another is refused like the `site` argument refuses it.
 *
 * `db` reads the sites and the credential and writes the default, always
 * naming `userId`: the person's own client or the service role. A grant's
 * rows have no owner update policy, so the connected-app path needs the
 * service role.
 */
export async function saveDefaultSite(
  db: SupabaseClient,
  input: { userId: string; credential: DefaultSiteCredential; value: string | null }
): Promise<SaveDefaultSiteResult> {
  const { userId, credential } = input;
  const via: Caller["via"] = credential.kind;
  const notFound = new ToolError(
    "not_found",
    credential.kind === "api_key" ? "Key not found." : "Connected app not found.",
    404,
    credential.kind === "api_key" ? HINTS.keys : HINTS.connectedApps
  );
  const found =
    credential.kind === "api_key"
      ? await findLiveApiKey(db, userId, credential.id)
      : await findLiveConnectedApp(db, userId, credential.grantId);
  if (!found) return { ok: false, error: notFound };

  const owned = await listBusinesses(db, userId);
  const allowed = found.businessId ? [found.businessId] : owned.map((site) => site.id);
  const value = input.value?.trim() || null;

  let chosen: BusinessSummary | null = null;
  if (value) {
    const choice = chooseSite(owned, allowed, value, via);
    if (!choice.ok) return { ok: false, error: choice.error };
    chosen = choice.site;
  }

  const saved =
    credential.kind === "api_key"
      ? await setApiKeyDefaultSite(db, userId, credential.id, chosen?.id ?? null)
      : await setConnectedAppDefaultSite(db, userId, credential.grantId, chosen?.id ?? null);
  if (!saved.ok) {
    if (saved.status === 404) return { ok: false, error: notFound };
    throw new Error(`default site: ${saved.error}`);
  }

  if (found.businessId) {
    return { ok: true, site: owned.find((site) => site.id === found.businessId) ?? null, source: "only_site" };
  }
  if (chosen) return { ok: true, site: chosen, source: "saved" };
  return { ok: true, site: owned[0] ?? null, source: "oldest" };
}
