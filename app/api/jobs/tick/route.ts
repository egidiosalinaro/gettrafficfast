import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createAdminClient } from "@/lib/supabase/admin";
import { tick } from "@/lib/jobs/worker";
import { isCronAuthorized } from "@/lib/cron-auth";
import { publishReadyArticles, type PublishReadyResult } from "@/lib/articles/publish-ready";

/**
 * The worker tick.
 *
 * Runs on a short schedule and drains whatever is claimable. Producers only
 * enqueue; this is the single place background work actually executes, so
 * concurrency, retries and time budgets are configured once.
 *
 * After the jobs, it publishes what has just become ready: a due `generated`
 * article whose production job finished after the daily run's publishing
 * phase (2026-11-10: a job that ran 08:00:39 → 08:08:10 was skipped as still
 * producing and would have waited a day). Same rules and the same atomic
 * delivery claim as the daily run (lib/articles/publish-ready.ts); bounded to
 * PUBLISH_PER_TICK articles changed in the last FRESH_WINDOW_MS, and one
 * indexed read when there is nothing to do. Failed deliveries are left to the
 * daily run's retry.
 */

export const maxDuration = 300;

const JOB_TIME_BUDGET_MS = 240_000;
const PUBLISH_PER_TICK = 3;
/** Wide enough for an article that finished just after a daily run to still be found the next morning. */
const FRESH_WINDOW_MS = 24 * 60 * 60_000;

function logLine(level: "info" | "warn" | "error", fields: Record<string, unknown>) {
  const line = JSON.stringify({ level, job: "jobs-tick", ts: new Date().toISOString(), ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

async function publishReady(supabase: ReturnType<typeof createAdminClient>): Promise<PublishReadyResult | null> {
  const runId = crypto.randomUUID();
  try {
    const result = await publishReadyArticles(supabase, {
      runId,
      today: new Date().toISOString().slice(0, 10),
      limit: PUBLISH_PER_TICK,
      freshSince: new Date(Date.now() - FRESH_WINDOW_MS).toISOString(),
      log: (level, fields) => logLine(level, { job_id: runId, ...fields }),
    });
    const { counts, error } = result;
    if (error) {
      logLine("error", { job_id: runId, phase: "publish_fetch", error });
    } else if (counts.published + counts.retry_pending + counts.needs_review > 0) {
      // Quiet when nothing was published or failed: this runs every 5 minutes.
      logLine("info", { job_id: runId, phase: "publish_done", ...counts });
    }
    return result;
  } catch (err) {
    // Publishing must not turn a good tick into a failed one.
    Sentry.captureException(err, { tags: { job: "jobs-tick", phase: "publish" } });
    logLine("error", { job_id: runId, phase: "publish", error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

async function run(request: NextRequest) {
  if (!isCronAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const supabase = createAdminClient();
    const result = await tick(supabase, {
      maxJobs: 5,
      timeBudgetMs: JOB_TIME_BUDGET_MS,
    });
    const published = await publishReady(supabase);
    return NextResponse.json({ ...result, publishing: published?.counts ?? null });
  } catch (err) {
    Sentry.captureException(err, { tags: { job: "jobs-tick" } });
    const message = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ level: "error", event: "jobs.tick_failed", error: message }));
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  return run(request);
}

export async function POST(request: NextRequest) {
  return run(request);
}
