import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { NO_BUSINESS_RESPONSE, selectedBusinessId } from "@/lib/tenancy";
import { DISCOVERY_RUN_NOW_BUDGET_MS, requestDiscovery } from "@/lib/placements/runs";
import { requirePaidAccess } from "@/lib/paid-access";
import { requireAccountCapacity } from "@/lib/limits/guard";
import { runJobWithin } from "@/lib/tools/jobs";

/**
 * "Run discovery" for the selected site. Same durable job as the scheduled
 * sweep, asked for by `requestDiscovery` (shared with the API's
 * `run_reply_discovery`). Finds and judges; posts nothing.
 *
 * Since 2026-11-12 the job starts in this request and the answer does not
 * wait for it: the worker runs it step after step, without going back to the
 * queue between steps, for up to DISCOVERY_RUN_NOW_BUDGET_MS after the
 * response (`after`), and the page follows it through its poll ("Searching…",
 * "Judging 23 of 60…"). Until then the request ran it for 50 s and the rest
 * waited for the 5-minute tick, step by step: 675 s for a run whose steps
 * took about 250 s. What the budget does not cover, the tick still finishes.
 */
export const maxDuration = 300;

export async function POST() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePaidAccess(user);
  if (denied) return denied;

  const businessId = await selectedBusinessId(supabase, user.id);
  if (!businessId) return NextResponse.json(NO_BUSINESS_RESPONSE, { status: 409 });

  // The account's daily AI spend limit and its daily cap on discovery,
  // counted with the API's run_reply_discovery (lib/limits/guard.ts).
  const limited = await requireAccountCapacity(createAdminClient, user.id, "run_reply_discovery");
  if (limited) return limited;

  const admin = createAdminClient();
  const started = await requestDiscovery({ admin, userId: user.id, businessId });
  if (!started.ok) return NextResponse.json({ error: started.error, code: started.code }, { status: 409 });
  if (started.alreadyRunning || !started.jobId) {
    return NextResponse.json({ success: true, alreadyRunning: true });
  }

  await runJobWithin(admin, started.jobId, { budgetMs: DISCOVERY_RUN_NOW_BUDGET_MS, waitMs: 0 });
  return NextResponse.json({ success: true, jobId: started.jobId, outcome: "started", providers: started.providers });
}
