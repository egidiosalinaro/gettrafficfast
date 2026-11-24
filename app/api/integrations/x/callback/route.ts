import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { X_SETTINGS_PATH, completeXConnect } from "@/lib/integrations/x-connect";
import { X_OAUTH_COOKIE } from "@/lib/integrations/x-oauth-state";

/**
 * Where X's consent screen sends the person back. Registered in X's
 * developer portal as `<your origin>/api/integrations/x/callback`.
 *
 * The work is `completeXConnect` (lib/integrations/x-connect.ts): the sealed
 * state must match what X sent and the person signed in, the code is traded
 * with the PKCE verifier, the account is read, and the connection is stored
 * (encrypted) for the site the round trip started from. The cookie is
 * dropped whatever the outcome.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL("/auth/sign-up", request.nextUrl.origin));

  const params = request.nextUrl.searchParams;
  const result = await completeXConnect({
    supabase,
    admin: createAdminClient(),
    userId: user.id,
    sealed: request.cookies.get(X_OAUTH_COOKIE)?.value,
    query: { code: params.get("code"), state: params.get("state"), error: params.get("error") },
  });

  const url = new URL(X_SETTINGS_PATH, request.nextUrl.origin);
  if (result.ok) url.searchParams.set("x_connected", result.username);
  else url.searchParams.set("x_error", result.error);
  url.hash = "connections-x";
  const response = NextResponse.redirect(url);
  response.cookies.delete(X_OAUTH_COOKIE);
  return response;
}
