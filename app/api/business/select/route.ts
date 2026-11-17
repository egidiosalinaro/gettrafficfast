import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import {
  BUSINESS_COOKIE,
  BUSINESS_COOKIE_MAX_AGE,
  listBusinesses,
} from "@/lib/tenancy";

/**
 * Switch the selected site.
 *
 * The id is verified against the account's own businesses before it is stored:
 * the cookie is what the rest of the app trusts, so this route is the one place
 * where "the user asked for this business" becomes "the user owns this
 * business". A miss is a 404, not a silent fallback — a switcher that quietly
 * lands you somewhere else is worse than an error.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let businessId: unknown;
  try {
    ({ businessId } = await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  if (typeof businessId !== "string" || !businessId) {
    return NextResponse.json({ error: "businessId is required" }, { status: 400 });
  }

  try {
    const businesses = await listBusinesses(supabase, user.id);
    const owned = businesses.some((business) => business.id === businessId);

    if (!owned) {
      return NextResponse.json({ error: "Site not found" }, { status: 404 });
    }

    const store = await cookies();
    store.set(BUSINESS_COOKIE, businessId, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: BUSINESS_COOKIE_MAX_AGE,
    });

    return NextResponse.json({ success: true, selectedId: businessId });
  } catch (error) {
    console.error("Error selecting business:", error);
    return NextResponse.json({ error: "Failed to switch site" }, { status: 500 });
  }
}
