import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { selectSearchConsoleProperty } from "@/lib/analytics/search-console-connection";
import { NO_BUSINESS_RESPONSE, selectedBusinessId } from "@/lib/tenancy";

/**
 * Picks the property to ingest from.
 *
 * Changing it clears last_synced_on: the history already stored belongs to the
 * old property, and resuming from its watermark would leave a silent gap. The
 * first pull for the new property is kicked here so Results does not wait for
 * the daily sweep. The same function the select_search_console_property tool
 * calls (lib/analytics/search-console-connection.ts).
 */
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const businessId = await selectedBusinessId(supabase, user.id);
  if (!businessId) {
    return NextResponse.json(NO_BUSINESS_RESPONSE, { status: 409 });
  }

  const body = (await request.json().catch(() => ({}))) as { siteUrl?: string };
  const siteUrl = body.siteUrl?.trim();
  if (!siteUrl) {
    return NextResponse.json({ error: "siteUrl is required" }, { status: 400 });
  }

  const result = await selectSearchConsoleProperty({
    admin: createAdminClient(),
    userId: user.id,
    businessId,
    siteUrl,
    waitMs: 45_000,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

  return NextResponse.json({
    ok: true,
    siteUrl: result.siteUrl,
    lastSyncedOn: result.lastSyncedOn,
    syncing: result.syncing,
  });
}
