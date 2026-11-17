import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { kickFirstSearchConsoleSync } from "@/lib/analytics/runs";
import { NO_BUSINESS_RESPONSE, selectedBusinessId } from "@/lib/tenancy";

/**
 * First Search Console pull for the selected site.
 *
 * The daily sweep remains the overlapping tail. This is the exceptional
 * ingest: a property with no watermark is pulled now so Results never tells
 * the customer to wait until 07:00 UTC. Idempotent: a watermark already set
 * is left to the cron.
 */
export const maxDuration = 60;

export async function POST() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const businessId = await selectedBusinessId(supabase, user.id);
  if (!businessId) {
    return NextResponse.json(NO_BUSINESS_RESPONSE, { status: 409 });
  }

  const result = await kickFirstSearchConsoleSync({
    supabase: createAdminClient(),
    userId: user.id,
    businessId,
    waitMs: 45_000,
  });

  return NextResponse.json({
    ok: true,
    skipped: result.skipped ?? null,
    lastSyncedOn: result.lastSyncedOn,
    syncing: result.syncing,
    outcome: result.outcome ?? null,
  });
}
