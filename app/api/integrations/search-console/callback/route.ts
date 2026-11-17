import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  exchangeAuthorizationCode,
  listSites,
} from "@/lib/providers/analytics/search-console";
import { saveConnection } from "@/lib/analytics/search-console";
import { kickFirstSearchConsoleSync } from "@/lib/analytics/runs";
import { OAUTH_STATE_COOKIE, redirectUriFor, SETTINGS_PATH } from "../shared";
import { selectedBusinessId } from "@/lib/tenancy";

/**
 * Completes the consent flow.
 *
 * If Google returns no refresh token the connection is refused rather than
 * saved: it would work for one hour and then fail silently, which is the worst
 * of both outcomes. The access token is used once here to read the property
 * list and is then discarded, because only the refresh token is durable.
 */

function back(request: NextRequest, params: Record<string, string>): NextResponse {
  const url = new URL(SETTINGS_PATH, request.nextUrl.origin);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = NextResponse.redirect(url);
  response.cookies.delete(OAUTH_STATE_COOKIE);
  return response;
}

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(new URL("/auth/sign-up", request.nextUrl.origin));
  }

  const params = request.nextUrl.searchParams;
  if (params.get("error")) {
    return back(request, { error: "denied" });
  }

  const expectedState = request.cookies.get(OAUTH_STATE_COOKIE)?.value;
  const state = params.get("state");
  if (!expectedState || !state || state !== expectedState) {
    return back(request, { error: "state_mismatch" });
  }

  const code = params.get("code");
  if (!code) return back(request, { error: "missing_code" });

  try {
    const { accessToken, refreshToken } = await exchangeAuthorizationCode({
      code,
      redirectUri: redirectUriFor(request),
    });

    if (!refreshToken) {
      return back(request, { error: "no_refresh_token" });
    }

    // The grant is attached to the site being configured. Without one there
    // is nothing to attribute the traffic to, so the connection is refused
    // rather than stored against the account at large.
    const businessId = await selectedBusinessId(supabase, user.id);
    if (!businessId) {
      return back(request, { error: "no_business" });
    }

    const sites = await listSites(accessToken);

    // Writing the credential needs service role: the table's RLS lets an owner
    // read their row, never write it.
    const admin = createAdminClient();
    await saveConnection({
      supabase: admin,
      userId: user.id,
      businessId,
      refreshToken,
      // One property is the common case, and choosing it here saves a step.
      siteUrl: sites.length === 1 ? sites[0].siteUrl : null,
    });

    if (sites.length === 1) {
      // Enqueue only: this is the OAuth redirect and must not wait on Google.
      await kickFirstSearchConsoleSync({
        supabase: admin,
        userId: user.id,
        businessId,
      }).catch(() => undefined);
    }

    return back(request, { connected: "1" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return back(request, { error: "exchange_failed", detail: message.slice(0, 120) });
  }
}
