import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createAdminClient } from "@/lib/supabase/admin";
import { SEARCH_CONSOLE } from "@/lib/analytics/search-console";
import { inspectBusinessIndex } from "@/lib/analytics/index-status";
import { isSearchConsoleConfigured } from "@/lib/providers/analytics/search-console";
import { isCronAuthorized } from "@/lib/cron-auth";

/**
 * Daily indexing status: Google's URL Inspection for the published URLs of
 * every site with a Search Console property (docs/ANALYTICS.md, "Indexing
 * status").
 *
 * Free (Google does not charge for the Search Console API), so it needs no
 * opt-in; bounded all the same, because Google's quota is per property:
 * at most DAILY_INSPECTION_CAP inspections per site per day, rotated so the
 * freshly published and the never-checked go first. A quiet hour (02:10
 * UTC), away from the 07:00 Search Analytics pull on the same grants.
 *
 * One site's refused grant or spent quota never stops the others. The
 * sites start in a different order each day, so a run cut by the time
 * budget does not always starve the same one.
 */

export const maxDuration = 300;

/** Leave room to answer before Vercel cuts the function. */
const TIME_BUDGET_MS = 270_000;

async function run(request: NextRequest) {
  if (!isCronAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isSearchConsoleConfigured()) {
    return NextResponse.json({ inspected: 0, status: "disabled (no Google OAuth credentials configured)" });
  }

  const started = Date.now();
  const deadline = started + TIME_BUDGET_MS;
  const supabase = createAdminClient();

  const { data: connections, error } = await supabase
    .from("analytics_connections")
    .select("business_id")
    .eq("provider", SEARCH_CONSOLE)
    .eq("status", "connected")
    .not("site_url", "is", null);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const businessIds = (connections ?? [])
    .map((row) => (row.business_id as string | null) ?? null)
    .filter((id): id is string => Boolean(id))
    .sort();
  const day = Math.floor(started / 86_400_000);
  const offset = businessIds.length ? day % businessIds.length : 0;
  const ordered = [...businessIds.slice(offset), ...businessIds.slice(0, offset)];

  let inspected = 0;
  let notified = 0;
  const notes: string[] = [];

  for (const businessId of ordered) {
    if (Date.now() >= deadline) {
      notes.push("time budget reached; the rest go first tomorrow");
      break;
    }
    try {
      const result = await inspectBusinessIndex({ admin: supabase, businessId, deadline });
      if (result.status === "skipped") continue;
      inspected += result.inspected;
      notified += result.notified;
      if (result.stopped && result.stopped !== "deadline") notes.push(`${businessId}: stopped (${result.stopped})`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      notes.push(`${businessId}: ${message}`);
      Sentry.captureException(err, { tags: { stage: "index_inspection" }, extra: { business_id: businessId } });
    }
  }

  return NextResponse.json({ sites: ordered.length, inspected, notified, notes: notes.slice(0, 10) });
}

export async function GET(request: NextRequest) {
  return run(request);
}

export async function POST(request: NextRequest) {
  return run(request);
}
