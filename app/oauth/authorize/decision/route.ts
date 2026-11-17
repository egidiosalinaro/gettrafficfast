import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { listBusinesses } from "@/lib/tenancy";
import { SITE_URL } from "@/lib/site";
import { decideConsent, signInLocation } from "@/lib/oauth/authorize";
import { isSameOrigin } from "@/lib/oauth/http";

/**
 * The consent screen's form posts here (app/oauth/authorize/page.tsx). It
 * re-checks the whole authorization request (nothing the form carries is
 * trusted for being in the form), requires the session, and answers with a
 * 303: to the client's redirect URI with a code or an error, or back to the
 * consent screen. A post from another site is refused (CSRF): a signed-in
 * person must not be able to grant access by visiting a page.
 */
export async function POST(request: Request) {
  if (!isSameOrigin(request, SITE_URL)) {
    return new NextResponse("This form can only be sent from GetTrafficFast's own consent screen.", {
      status: 403,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  const form = new URLSearchParams(await request.text().catch(() => ""));
  const go = (location: string) => NextResponse.redirect(new URL(location, request.url), 303);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return go(signInLocation(form));

  const owned = await listBusinesses(supabase, user.id);
  const decision = await decideConsent(form, {
    admin: createAdminClient(),
    userId: user.id,
    ownedBusinessIds: owned.map((business) => business.id),
  });
  return go(decision.location);
}
