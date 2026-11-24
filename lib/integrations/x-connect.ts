import type { SupabaseClient } from "@supabase/supabase-js";
import { updateVoiceSettings } from "@/lib/business/save-settings";
import { SITE_URL } from "@/lib/site";
import { listBusinesses } from "@/lib/tenancy";
import { loadVoiceSettings } from "@/lib/voice/read";
import { normalizeXHandle } from "@/lib/voice/settings";
import { X_USER_LOOKUP_USD_PER_USER } from "@/lib/providers/x/api";
import {
  X_CALLBACK_PATH,
  XOAuthError,
  buildXAuthorizeUrl,
  createOAuthState,
  createPkce,
  exchangeXCode,
  fetchXMe,
  xOAuthClientFromEnv,
  type XMe,
  type XOAuthClient,
} from "@/lib/providers/x/oauth";
import { meteredXCall } from "@/lib/placements/x-budget";
import { X_OAUTH_STATE_TTL_SECONDS, openXOAuthState, sealXOAuthState } from "./x-oauth-state";
import { saveXConnection } from "./x-posting";

/**
 * The two halves of connecting a site's X account (docs/INTEGRATIONS.md, "X:
 * the account GTF posts from"), called by `/api/integrations/x/connect` and
 * `/api/integrations/x/callback`. Kept here so they are tested without a
 * request.
 */

/** Where X sends the person back: the deployment's public origin, never the request's (X matches it exactly). */
export function xRedirectUri(origin: string = SITE_URL): string {
  return `${origin.replace(/\/+$/, "")}${X_CALLBACK_PATH}`;
}

/** Where the person lands afterwards: Settings → Connections, X. */
export const X_SETTINGS_PATH = "/settings/integrations";

/** The address a person opens, signed in, to connect the site `businessId` (onboarding, `get_x_posting_account`). */
export function xConnectPath(businessId?: string | null): string {
  return businessId ? `/api/integrations/x/connect?business=${encodeURIComponent(businessId)}` : "/api/integrations/x/connect";
}

export type StartXConnect = { ok: true; authorizeUrl: string; cookie: string } | { ok: false; error: "not_configured" };

/** X's consent address for this round trip, and the sealed cookie that remembers it. */
export function startXConnect(params: {
  userId: string;
  businessId: string;
  oauthClient?: XOAuthClient | null;
  redirectUri?: string;
  now?: Date;
}): StartXConnect {
  const oauthClient = params.oauthClient === undefined ? xOAuthClientFromEnv() : params.oauthClient;
  if (!oauthClient) return { ok: false, error: "not_configured" };
  const now = params.now ?? new Date();
  const state = createOAuthState();
  const { verifier, challenge } = createPkce();
  const cookie = sealXOAuthState({
    state,
    verifier,
    userId: params.userId,
    businessId: params.businessId,
    expiresAt: now.getTime() + X_OAUTH_STATE_TTL_SECONDS * 1000,
  });
  return {
    ok: true,
    authorizeUrl: buildXAuthorizeUrl({ clientId: oauthClient.clientId, redirectUri: params.redirectUri ?? xRedirectUri(), state, challenge }),
    cookie,
  };
}

export type CompleteXConnectError =
  | "not_configured"
  | "denied"
  | "state_mismatch"
  | "site_not_found"
  | "exchange_failed"
  | "cap_reached"
  | "save_failed";

export type CompleteXConnect =
  | { ok: true; businessId: string; username: string; handleSaved: boolean }
  | { ok: false; error: CompleteXConnectError; detail?: string };

/**
 * Finishes the round trip: checks the sealed state against what X sent and
 * against the person signed in, trades the code for tokens, reads which
 * account it is (one metered user read), stores the connection for the site
 * the round trip was started for, and, when the site has no X account saved
 * yet, saves the connected @username as its xHandle (the account its
 * replies' links are looked for under).
 */
export async function completeXConnect(params: {
  /** The person's own client (RLS), for the site check and the voice settings. */
  supabase: SupabaseClient;
  admin: SupabaseClient;
  userId: string;
  sealed: string | null | undefined;
  query: { code?: string | null; state?: string | null; error?: string | null };
  oauthClient?: XOAuthClient | null;
  redirectUri?: string;
  fetchImpl?: typeof fetch;
  now?: Date;
}): Promise<CompleteXConnect> {
  const oauthClient = params.oauthClient === undefined ? xOAuthClientFromEnv() : params.oauthClient;
  if (!oauthClient) return { ok: false, error: "not_configured" };
  const now = params.now ?? new Date();
  if (params.query.error) return { ok: false, error: "denied" };

  const opened = openXOAuthState(params.sealed, now);
  if (!opened || !params.query.state || opened.state !== params.query.state || opened.userId !== params.userId) {
    return { ok: false, error: "state_mismatch" };
  }
  const code = params.query.code?.trim();
  if (!code) return { ok: false, error: "exchange_failed", detail: "X sent no code." };

  // The site the round trip was started for, still one of the person's own.
  const owned = await listBusinesses(params.supabase, params.userId);
  if (!owned.some((business) => business.id === opened.businessId)) return { ok: false, error: "site_not_found" };

  let tokens;
  try {
    tokens = await exchangeXCode(
      oauthClient,
      { code, verifier: opened.verifier, redirectUri: params.redirectUri ?? xRedirectUri() },
      { fetchImpl: params.fetchImpl, now }
    );
  } catch (err) {
    return { ok: false, error: "exchange_failed", detail: err instanceof XOAuthError ? err.message.slice(0, 160) : "X did not answer." };
  }

  const read = await meteredXCall<{ me: XMe; billedPosts: number; costUsd: number }, { accessToken: string }>({
    supabase: params.admin,
    client: { accessToken: tokens.accessToken },
    worstCaseUsd: X_USER_LOOKUP_USD_PER_USER,
    run: async (client) => ({
      me: await fetchXMe(client.accessToken, { fetchImpl: params.fetchImpl, now }),
      billedPosts: 1,
      costUsd: X_USER_LOOKUP_USD_PER_USER,
    }),
    now,
  });
  if (!read.ok) {
    if (read.reason === "cap" || read.reason === "paused" || read.reason === "billing") return { ok: false, error: "cap_reached" };
    return { ok: false, error: "exchange_failed", detail: read.message.slice(0, 160) };
  }
  const me = read.result.me;

  const saved = await saveXConnection({ admin: params.admin, userId: params.userId, businessId: opened.businessId, me, tokens, now });
  if (!saved.ok) return { ok: false, error: "save_failed", detail: saved.error.slice(0, 160) };

  // The connected account becomes the site's X account when none is saved:
  // the person is not asked for their username by hand any more.
  let handleSaved = false;
  const voice = await loadVoiceSettings(params.supabase, params.userId, opened.businessId);
  if (voice.hasBusiness && !voice.settings.xHandle) {
    const updated = await updateVoiceSettings({
      supabase: params.supabase,
      userId: params.userId,
      businessId: opened.businessId,
      changes: { xHandle: normalizeXHandle(me.username) },
    });
    handleSaved = updated.ok;
  }
  return { ok: true, businessId: opened.businessId, username: me.username, handleSaved };
}
