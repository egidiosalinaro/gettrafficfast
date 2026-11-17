import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { selectedBusinessId } from "@/lib/tenancy";
import { loadTodayScreen } from "@/lib/today/read";

/**
 * Today (`/today`): the progress, the tabs' counts and "Also today" for the
 * selected site (lib/today/read.ts), through the user's own session, so RLS
 * is the access control. `get_today` answers the same. `tz` is the browser's
 * IANA zone; UTC when absent.
 */
export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const businessId = await selectedBusinessId(supabase, user.id);
    if (!businessId) return NextResponse.json({ hasBusiness: false });

    const screen = await loadTodayScreen(supabase, businessId, {
      // The platform's X ledger, read only to say whether GTF is looking for a link.
      admin: createAdminClient,
      timeZone: request.nextUrl.searchParams.get("tz"),
    });
    return NextResponse.json({ hasBusiness: true, ...screen });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
