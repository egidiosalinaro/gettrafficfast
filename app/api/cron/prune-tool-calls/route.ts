import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createAdminClient } from "@/lib/supabase/admin";
import { isCronAuthorized } from "@/lib/cron-auth";
import { TOOL_CALLS_RETENTION_DAYS, pruneToolCalls } from "@/lib/tools/retention";

/**
 * The retention sweep of the API's audit log: deletes `tool_calls` rows
 * older than 90 days, oldest first, in bounded batches
 * (lib/tools/retention.ts). Daily, `CRON_SECRET`-protected like every
 * scheduled route. Spends nothing.
 */

export const maxDuration = 300;

async function run(request: NextRequest) {
  if (!isCronAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await pruneToolCalls(createAdminClient());
    console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", event: "cron.prune_tool_calls", ...result }));
    return NextResponse.json({ retentionDays: TOOL_CALLS_RETENTION_DAYS, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", event: "cron.prune_tool_calls", error: message }));
    Sentry.captureException(error, { tags: { cron: "prune-tool-calls" } });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  return run(request);
}

export async function POST(request: NextRequest) {
  return run(request);
}
