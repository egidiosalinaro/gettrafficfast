import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { createClient } from "@/lib/supabase/server";
import { CONNECT_BUSINESS_PARAM } from "@/lib/analytics/search-console-connection";
import {
  buildConsentUrl,
  isSearchConsoleConfigured,
} from "@/lib/providers/analytics/search-console";
import { BUSINESS_COOKIE, BUSINESS_COOKIE_MAX_AGE, listBusinesses } from "@/lib/tenancy";
import { OAUTH_STATE_COOKIE, redirectUriFor, SETTINGS_PATH } from "../shared";

/**
 * Starts the Google consent flow.
 *
 * The state is a random value kept in an httpOnly cookie and compared on the
 * way back: without it, anyone could hand a signed-in customer a crafted
 * callback URL and attach their own Search Console property to that account.
 *
 * `?business=<site id>` (the link get_search_console_connect_url hands out)
 * selects that site first, as the site switcher does, after checking it is
 * one of the signed-in person's own: the callback attaches the grant to the
 * selected site, and an agent asking for site B must not get site A's. A site
 * the person does not have is refused, never a quiet fall-back.
 */

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.redirect(new URL("/auth/sign-up", request.nextUrl.origin));
  }

  if (!isSearchConsoleConfigured()) {
    return NextResponse.redirect(
      new URL(`${SETTINGS_PATH}?error=not_configured`, request.nextUrl.origin)
    );
  }

  const requested = request.nextUrl.searchParams.get(CONNECT_BUSINESS_PARAM)?.trim() || null;
  if (requested) {
    const owned = await listBusinesses(supabase, user.id);
    if (!owned.some((business) => business.id === requested)) {
      return NextResponse.redirect(new URL(`${SETTINGS_PATH}?error=site_not_found`, request.nextUrl.origin));
    }
  }

  const state = randomBytes(32).toString("hex");
  const response = NextResponse.redirect(
    buildConsentUrl({ redirectUri: redirectUriFor(request), state })
  );

  response.cookies.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: request.nextUrl.protocol === "https:",
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });

  if (requested) {
    response.cookies.set(BUSINESS_COOKIE, requested, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: BUSINESS_COOKIE_MAX_AGE,
    });
  }

  return response;
}
