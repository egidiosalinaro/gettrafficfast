import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createAdminClient } from "@/lib/supabase/admin";
import { isCronAuthorized } from "@/lib/cron-auth";
import { runXDaily } from "@/lib/placements/x-daily";

/**
 * The daily X run (docs/PLACEMENTS.md, "Fresh posts and reply numbers from
 * the X API"): reads the numbers of the replies posted on X in the last 14
 * days (one batched call) and the followers of each site's own account (one
 * user lookup a site, once a day), then enqueues one search job per site
 * whose owner pays (at most 10 a run, the sites searched longest ago first;
 * every site takes part since 2026-11-24). Off unless the platform set
 * X_API_ENABLED=1 and X_API_BEARER_TOKEN; every call to X is checked
 * against the monthly cap (X_API_MONTHLY_CAP_USD, default $20) before it is
 * made. Nothing is posted on X.
 */

export const maxDuration = 60;

async function run(request: NextRequest) {
  if (!isCronAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json(await runXDaily({ admin: createAdminClient() }));
  } catch (err) {
    Sentry.captureException(err, { tags: { stage: "x_daily" } });
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  return run(request);
}

export async function POST(request: NextRequest) {
  return run(request);
}
