import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createAdminClient } from "@/lib/supabase/admin";
import { isCronAuthorized } from "@/lib/cron-auth";
import { runXCloseTrial } from "@/lib/placements/x-close-cron";

/**
 * The close-accounts trial (docs/PLACEMENTS.md, "Close accounts trial"):
 * every three hours from 06:00 to 21:00 UTC, one `x-close-trial` job per
 * site listed in X_CLOSE_TRIAL_BUSINESS_IDS, until X_CLOSE_TRIAL_UNTIL.
 * Off unless the platform has the X API on; every call to X is checked
 * against the monthly cap. Nothing is posted on X.
 */

export const maxDuration = 60;

async function run(request: NextRequest) {
  if (!isCronAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json(await runXCloseTrial({ admin: createAdminClient() }));
  } catch (err) {
    Sentry.captureException(err, { tags: { stage: "x_close_trial" } });
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
