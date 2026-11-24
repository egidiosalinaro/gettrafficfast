import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { BUSINESS_COOKIE, BUSINESS_COOKIE_MAX_AGE, listBusinesses, selectedBusinessId } from "@/lib/tenancy";
import { X_SETTINGS_PATH, startXConnect } from "@/lib/integrations/x-connect";
import { X_OAUTH_COOKIE, X_OAUTH_STATE_TTL_SECONDS } from "@/lib/integrations/x-oauth-state";

/**
 * Starts connecting the X account a site posts from: X's consent screen
 * (OAuth 2.0 with PKCE), then back to /api/integrations/x/callback.
 *
 * GET is the link the onboarding step and `get_x_posting_account` hand out;
 * POST is the Connect button in Settings → Connections. Both do the same:
 * the round trip's state and PKCE verifier go into one sealed, httpOnly
 * cookie that expires in ten minutes, bound to the person and the site
 * (lib/integrations/x-oauth-state.ts). `?business=<site id>` connects that
 * site, after checking it is one of the signed-in person's own (and selects
 * it, as the site switcher does); without it, the selected site. Without
 * X_OAUTH_CLIENT_ID and X_OAUTH_CLIENT_SECRET nothing is offered.
 */

function back(request: NextRequest, error: string): NextResponse {
  const url = new URL(X_SETTINGS_PATH, request.nextUrl.origin);
  url.searchParams.set("x_error", error);
  return NextResponse.redirect(url, 303);
}

async function start(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL("/auth/sign-up", request.nextUrl.origin), 303);

  const requested = request.nextUrl.searchParams.get("business")?.trim() || null;
  let businessId: string | null;
  if (requested) {
    const owned = await listBusinesses(supabase, user.id);
    if (!owned.some((business) => business.id === requested)) return back(request, "site_not_found");
    businessId = requested;
  } else {
    businessId = await selectedBusinessId(supabase, user.id);
  }
  if (!businessId) return back(request, "no_business");

  const started = startXConnect({ userId: user.id, businessId });
  if (!started.ok) return back(request, started.error);

  const response = NextResponse.redirect(started.authorizeUrl, 303);
  response.cookies.set(X_OAUTH_COOKIE, started.cookie, {
    httpOnly: true,
    secure: request.nextUrl.protocol === "https:",
    sameSite: "lax",
    path: "/",
    maxAge: X_OAUTH_STATE_TTL_SECONDS,
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

export async function GET(request: NextRequest) {
  return start(request);
}

export async function POST(request: NextRequest) {
  return start(request);
}
