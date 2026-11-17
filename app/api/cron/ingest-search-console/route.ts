import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  ingestBusinessSearchConsole,
  SEARCH_CONSOLE,
} from "@/lib/analytics/search-console";
import { hasActiveSearchConsoleIngest } from "@/lib/analytics/runs";
import { isSearchConsoleConfigured } from "@/lib/providers/analytics/search-console";
import { isCronAuthorized } from "@/lib/cron-auth";
import { measureDuePushes } from "@/lib/lifecycle/push-store";

/**
 * Pulls real traffic from every connected Search Console property.
 *
 * Daily, because the data settles over a few days and a daily pull with an
 * overlapping tail converges on the truth, while a weekly one would freeze
 * numbers that were still moving.
 *
 * One customer's broken grant must never stop the others: Google revokes
 * refresh tokens for its own reasons, and that is a per-connection problem,
 * recorded on the connection so the settings page can say so.
 */

export const maxDuration = 300;

async function run(request: NextRequest) {
  if (!isCronAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isSearchConsoleConfigured()) {
    return NextResponse.json({
      ingested: 0,
      status: "disabled (no Google OAuth credentials configured)",
    });
  }

  const supabase = createAdminClient();

  const { data: connections, error } = await supabase
    .from("analytics_connections")
    .select("user_id, business_id")
    .eq("provider", SEARCH_CONSOLE)
    .eq("status", "connected")
    .not("site_url", "is", null);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  let ingested = 0;
  let rows = 0;
  let measured = 0;
  const notes: string[] = [];

  for (const row of connections ?? []) {
    const userId = row.user_id as string;
    const businessId = (row.business_id as string | null) ?? null;
    if (!businessId) continue;
    try {
      // A first-connect job already owns this window; running it twice would
      // spend Google quota on the same unsettled days.
      if (await hasActiveSearchConsoleIngest(supabase, businessId)) continue;
      const result = await ingestBusinessSearchConsole({ supabase, businessId });
      if (result.status === "skipped") continue;
      ingested += result.matched;
      rows += result.rows;
      // Push page 3's after-values, the day their window settles (free).
      measured += (await measureDuePushes(supabase, businessId).catch(() => ({ measured: 0 }))).measured;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      notes.push(`${userId}: ${message}`);
      Sentry.captureException(err, {
        tags: { stage: "search_console_ingest" },
        extra: { user_id: userId, business_id: businessId },
      });
    }
  }

  return NextResponse.json({
    connections: connections?.length ?? 0,
    rowsFetched: rows,
    ingested,
    pushesMeasured: measured,
    notes: notes.slice(0, 10),
  });
}

export async function GET(request: NextRequest) {
  return run(request);
}

export async function POST(request: NextRequest) {
  return run(request);
}
