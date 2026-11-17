import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { disconnectSearchConsole } from "@/lib/analytics/search-console-connection";
import { selectedBusinessId } from "@/lib/tenancy";

/**
 * Drops the grant.
 *
 * The row is deleted rather than flagged, so the refresh token stops existing
 * here the moment the customer says stop. The metrics already ingested stay:
 * they are the customer's own history, not the credential. The same function
 * the disconnect_search_console tool calls
 * (lib/analytics/search-console-connection.ts).
 */
export async function POST() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const businessId = await selectedBusinessId(supabase, user.id);
  if (!businessId) return NextResponse.json({ ok: true });

  const result = await disconnectSearchConsole({ admin: createAdminClient(), userId: user.id, businessId });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true });
}
