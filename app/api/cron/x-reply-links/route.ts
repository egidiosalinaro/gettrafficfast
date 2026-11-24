import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createAdminClient } from "@/lib/supabase/admin";
import { isCronAuthorized } from "@/lib/cron-auth";
import { findReplyLinks } from "@/lib/placements/reply-link-search";

/**
 * Every 5 minutes (docs/PLACEMENTS.md, "The link of your reply, found on
 * X"): for the replies marked as posted on X with no link yet, the search
 * whose turn has come (2 min, 15 min, 2 h and 12 h after "I posted it"), at
 * most 10 a run, each through the metered X call. Off unless the platform
 * set X_API_ENABLED=1 and X_API_BEARER_TOKEN, and only for sites whose
 * owner pays and whose X account is known, at most 25 new replies a site a
 * day. With nothing due it makes one
 * or two small reads and no call to X. Nothing is posted on X.
 */

export const maxDuration = 60;

async function run(request: NextRequest) {
  if (!isCronAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const outcome = await findReplyLinks({ admin: createAdminClient() });
    // Quiet when there was nothing to do: this runs every 5 minutes.
    if (outcome.searched > 0 || outcome.stopped) {
      console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", event: "cron.x_reply_links", ...outcome }));
    }
    return NextResponse.json(outcome);
  } catch (err) {
    Sentry.captureException(err, { tags: { stage: "x_reply_links" } });
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
