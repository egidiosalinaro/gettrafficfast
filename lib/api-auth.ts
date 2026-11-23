import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ownerScopedClient } from "@/lib/supabase/owner-scoped";
import { API_KEY_PREFIX, API_KEY_SCOPES, bearerToken, verifyApiKey, type ApiKeyScope } from "@/lib/api-keys";
import { SECRET_PREFIX } from "@/lib/oauth/crypto";
import { verifyAccessToken } from "@/lib/oauth/tokens";
import { apiError, HINTS, type ApiError } from "@/lib/api-errors";
import { BUSINESS_COOKIE, listBusinesses, pickBusiness, type BusinessSummary } from "@/lib/tenancy";

/**
 * Who is calling, for which site, through which client: the one question
 * every API surface (the REST tool runner, MCP) answers before it does
 * anything (docs/API.md "Authentication").
 *
 * Two credentials, one answer:
 *
 * - **the session cookie**, as the screens use it. `client` is the person's
 *   own Supabase client, so RLS is the access control, as in every route.
 * - **`Authorization: Bearer gtf_…`**, an API key (lib/api-keys.ts). There
 *   is no user JWT behind it, so `client` is the service role narrowed to
 *   the key's owner (lib/supabase/owner-scoped.ts): every read, update and
 *   delete carries `user_id = owner`, every write must name the owner and
 *   the caller's site. That reproduces what RLS does for a session; the tool
 *   runner then hands handlers only this client and this site, and checks
 *   every id an input names against both (lib/tools/runner.ts).
 * - **`Authorization: Bearer gtfat_…`**, an OAuth access token an app such
 *   as claude.ai got from this site's authorization server (lib/oauth/).
 *   Accepted only where the caller names the resource it is
 *   (`oauthResource`: the MCP endpoint), because a token is valid only for
 *   the resource it was issued for. It resolves exactly like a key: the
 *   grant's owner, its one site or every site, its scopes, the owner-scoped
 *   service role. So the runner, ownership, scopes, the paywall and the
 *   caps apply unchanged; the per-key limits count per app instead.
 *
 * Why not a real user JWT for key callers: minting one needs a secret
 * Supabase trusts (the legacy HS256 JWT secret, or a signing key imported
 * into the project), and the app holds neither today; adding one would put a
 * second all-powerful secret in the environment to save a filter the code
 * already applies. See docs/API.md "Why the service role, narrowed".
 *
 * A Bearer header always wins over a cookie, and a Bearer header that does
 * not verify is a refusal, never a fall-back to the cookie: a caller who sent
 * a credential meant that one.
 *
 * The site, like everywhere else (lib/tenancy.ts), is always one of the
 * owner's own businesses:
 *
 * 1. a key limited to one site acts on that site; `x-gtf-business` naming
 *    another of the owner's sites is 403 `forbidden_business`;
 * 2. `x-gtf-business` naming a site the owner does not have is 404
 *    `business_not_found`, never a quiet fall-back: a caller who named a
 *    site and got another one would act on the wrong data;
 * 3. no header: the key's site, else (a browser session only) the selected
 *    site from the cookie, which falls back to the oldest site as the
 *    screens do; a key or a connected app for every site gets its saved
 *    default (`default_business_id`, set with the `set_default_site` tool or
 *    in Settings → Claude and API) while that is still a site of the
 *    account, else the oldest.
 *
 * A tool's `site` argument (lib/tools/site.ts) then overrides the default
 * the same way the header does, among the sites the credential covers.
 */

export const BUSINESS_HEADER = "x-gtf-business";

export type CallerVia = "session" | "api_key" | "oauth";

/** What an OAuth caller is connected through (docs/API.md "Connect from claude.ai"). */
export interface OAuthCallerGrant {
  /** The registered app (`oauth_clients.client_id`): what the per-app limits count on, with the user. */
  clientId: string;
  /** The grant (`oauth_tokens.family_id`): one consent, and every token rotated from it. */
  grantId: string;
  /** True when the person granted one site only. */
  siteLimited: boolean;
}

/**
 * Where the site a call names none of comes from: `saved`, the credential's
 * saved default; `oldest`, the fall-back when none is saved (or the saved
 * one is gone); `only_site`, a key or a grant limited to one site;
 * `selected`, a browser session's site picker.
 */
export const DEFAULT_SITE_SOURCES = ["saved", "oldest", "only_site", "selected"] as const;
export type DefaultSiteSource = (typeof DEFAULT_SITE_SOURCES)[number];

/** The site a call acts on when it names none, and why that one. */
export interface DefaultSite {
  businessId: string | null;
  source: DefaultSiteSource;
}

export interface Caller {
  via: CallerVia;
  userId: string;
  /** The site this request is about; null when the account has none yet. */
  businessId: string | null;
  /** The sites this caller may act on: one for a site key, all of the account's otherwise. */
  businessIds: readonly string[];
  /** Session: the person's RLS client. API key: the owner-scoped service role. */
  client: SupabaseClient;
  /** What the credential may do. A session may do everything its owner may. */
  scopes: readonly ApiKeyScope[];
  /** The API key used, when one was. */
  keyId: string | null;
  /** The app and the grant, for an OAuth caller only. */
  oauth?: OAuthCallerGrant;
  /**
   * The site a call that names none acts on, and where it comes from
   * (`whoami` reports it). Set by `resolveCaller`; `businessId` differs from
   * it only when the header named another site. Optional so a caller built
   * by hand (a test) needs none.
   */
  defaultSite?: DefaultSite;
}

export interface CallerError {
  status: 401 | 403 | 404 | 500;
  error: ApiError;
}

export type ResolveCallerResult = { ok: true; caller: Caller } | ({ ok: false } & CallerError);

const KEY_REFUSALS: Record<"missing" | "malformed" | "unknown" | "revoked", CallerError> = {
  missing: {
    status: 401,
    error: apiError("unauthorized", "Sign in, or send an API key as Authorization: Bearer gtf_…", HINTS.keys),
  },
  malformed: {
    status: 401,
    error: apiError("invalid_api_key", "That is not a GetTrafficFast API key: keys start with gtf_.", HINTS.keys),
  },
  unknown: { status: 401, error: apiError("invalid_api_key", "Unknown API key.", HINTS.keys) },
  revoked: { status: 401, error: apiError("revoked_api_key", "This API key was revoked.", HINTS.keys) },
};

type TokenRefusal = "malformed" | "unknown" | "revoked" | "expired" | "wrong_resource" | "elsewhere";

const TOKEN_REFUSALS: Record<TokenRefusal, CallerError> = {
  malformed: {
    status: 401,
    error: apiError("invalid_token", "That is neither a GetTrafficFast API key (gtf_…) nor an access token this site issued.", HINTS.connectedApps),
  },
  unknown: { status: 401, error: apiError("invalid_token", "Unknown access token.", HINTS.connectedApps) },
  revoked: { status: 401, error: apiError("invalid_token", "This connection was revoked. Connect the app again.", HINTS.connectedApps) },
  expired: { status: 401, error: apiError("invalid_token", "This access token expired. Refresh it, or connect again.") },
  wrong_resource: { status: 401, error: apiError("invalid_token", "This access token was issued for another resource.") },
  elsewhere: {
    status: 401,
    error: apiError("invalid_token", "OAuth access tokens work at the MCP endpoint only. Send an API key (gtf_…) here.", HINTS.keys),
  },
};

export type BusinessChoice =
  | { ok: true; businessId: string | null; businessIds: string[]; defaultSite: DefaultSite }
  | ({ ok: false } & CallerError);

/**
 * Which site a request is about, and which sites it may touch. Pure, so the
 * rules above are tested without a request: `owned` is the owner's
 * businesses, oldest first. `preferred` (the cookie) is honoured, with the
 * screens' fall-back, only when `allowFallback` is set: a browser session.
 * `savedDefault` is a key's or a grant's saved default site: used when the
 * request names none and it is still one of `owned`; otherwise the oldest.
 */
export function chooseBusiness(
  owned: readonly Pick<BusinessSummary, "id">[],
  input: {
    keyBusinessId?: string | null;
    requested?: string | null;
    preferred?: string | null;
    allowFallback?: boolean;
    savedDefault?: string | null;
  }
): BusinessChoice {
  const ownedIds = owned.map((b) => b.id);
  const requested = input.requested?.trim() || null;

  if (requested && !ownedIds.includes(requested)) {
    return {
      ok: false,
      status: 404,
      error: apiError("business_not_found", `No site of this account has the id ${requested}.`, "Call whoami to list the sites."),
    };
  }

  if (input.keyBusinessId) {
    if (!ownedIds.includes(input.keyBusinessId)) {
      return {
        ok: false,
        status: 403,
        error: apiError("forbidden_business", "This key's site is no longer part of the account.", HINTS.keys),
      };
    }
    if (requested && requested !== input.keyBusinessId) {
      return {
        ok: false,
        status: 403,
        error: apiError(
          "forbidden_business",
          "This key is limited to one site and cannot act on another.",
          `Use a key for that site, or one for every site. ${HINTS.keys}`
        ),
      };
    }
    return {
      ok: true,
      businessId: input.keyBusinessId,
      businessIds: [input.keyBusinessId],
      defaultSite: { businessId: input.keyBusinessId, source: "only_site" },
    };
  }

  const saved = input.savedDefault && ownedIds.includes(input.savedDefault) ? input.savedDefault : null;
  const defaultSite: DefaultSite = input.allowFallback
    ? { businessId: pickBusiness([...owned], input.preferred ?? null)?.id ?? null, source: "selected" }
    : saved
      ? { businessId: saved, source: "saved" }
      : { businessId: ownedIds[0] ?? null, source: "oldest" };
  return { ok: true, businessId: requested ?? defaultSite.businessId, businessIds: ownedIds, defaultSite };
}

/** One cookie's value off a request, without Next's request scope. */
export function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    const raw = part.slice(index + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

/**
 * The caller of `request`. `allowSession: false` accepts a Bearer
 * credential only (the MCP endpoint, which a browser never calls).
 * `oauthResource` is the resource this endpoint is (the MCP endpoint's URL):
 * set, an OAuth access token issued for it is accepted too; unset, OAuth
 * tokens are refused, since none is issued for anything else.
 */
export async function resolveCaller(
  request: Request,
  options: { allowSession?: boolean; oauthResource?: string } = {}
): Promise<ResolveCallerResult> {
  const allowSession = options.allowSession ?? true;
  const authorization = request.headers.get("authorization");
  const requested = request.headers.get(BUSINESS_HEADER);

  try {
    // A Bearer token that is not an API key is looked up as an OAuth access
    // token where one is accepted; `gtf_` keeps the key path and its refusals.
    const token = bearerToken(authorization);
    if (token && !token.startsWith(API_KEY_PREFIX)) {
      if (!options.oauthResource) {
        return { ok: false, ...(token.startsWith(SECRET_PREFIX.access) ? TOKEN_REFUSALS.elsewhere : KEY_REFUSALS.malformed) };
      }
      const admin = createAdminClient();
      const verified = await verifyAccessToken(token, { admin, resource: options.oauthResource });
      if (!verified.ok) return { ok: false, ...TOKEN_REFUSALS[verified.reason] };
      const grant = verified.token;
      const owned = await listBusinesses(admin, grant.userId);
      const choice = chooseBusiness(owned, { keyBusinessId: grant.businessId, requested, savedDefault: grant.defaultBusinessId });
      if (!choice.ok) return choice;
      return {
        ok: true,
        caller: {
          via: "oauth",
          userId: grant.userId,
          businessId: choice.businessId,
          businessIds: choice.businessIds,
          client: ownerScopedClient(admin, {
            userId: grant.userId,
            businessIds: choice.businessId ? [choice.businessId] : [],
          }),
          scopes: grant.scopes,
          keyId: null,
          oauth: { clientId: grant.clientId, grantId: grant.familyId, siteLimited: grant.businessId !== null },
          defaultSite: choice.defaultSite,
        },
      };
    }

    if (authorization || !allowSession) {
      const verified = await verifyApiKey(authorization);
      if (!verified.ok) {
        // An Authorization header in another scheme, or "Bearer" with nothing: not a key.
        const reason = verified.reason === "missing" && authorization ? "malformed" : verified.reason;
        return { ok: false, ...KEY_REFUSALS[reason] };
      }
      const admin = createAdminClient();
      const owned = await listBusinesses(admin, verified.key.userId);
      const choice = chooseBusiness(owned, {
        keyBusinessId: verified.key.businessId,
        requested,
        savedDefault: verified.key.defaultBusinessId,
      });
      if (!choice.ok) return choice;
      return {
        ok: true,
        caller: {
          via: "api_key",
          userId: verified.key.userId,
          businessId: choice.businessId,
          businessIds: choice.businessIds,
          client: ownerScopedClient(admin, {
            userId: verified.key.userId,
            businessIds: choice.businessId ? [choice.businessId] : [],
          }),
          scopes: verified.key.scopes,
          keyId: verified.key.id,
          defaultSite: choice.defaultSite,
        },
      };
    }

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { ok: false, ...KEY_REFUSALS.missing };
    const owned = await listBusinesses(supabase, user.id);
    const choice = chooseBusiness(owned, {
      requested,
      preferred: cookieValue(request, BUSINESS_COOKIE),
      allowFallback: true,
    });
    if (!choice.ok) return choice;
    return {
      ok: true,
      caller: {
        via: "session",
        userId: user.id,
        businessId: choice.businessId,
        businessIds: choice.businessIds,
        client: supabase,
        scopes: API_KEY_SCOPES,
        keyId: null,
        defaultSite: choice.defaultSite,
      },
    };
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "api.resolve_caller_failed",
        error: error instanceof Error ? error.message.slice(0, 300) : String(error),
      })
    );
    return { ok: false, status: 500, error: apiError("internal", "Could not check who is calling. Try again.") };
  }
}
