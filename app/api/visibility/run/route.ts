import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runJobNow } from "@/lib/jobs/worker";
import { NO_BUSINESS_RESPONSE, selectedBusinessId } from "@/lib/tenancy";
import { startVisibilityRun } from "@/lib/visibility/manage";
import { requirePaidAccess } from "@/lib/paid-access";
import { requireAccountCapacity } from "@/lib/limits/guard";

/**
 * "Run now".
 *
 * Same durable job as the scheduled run; only the trigger differs. It is
 * executed inline for as long as this request may live, because the person is
 * waiting, and whatever is still pending when time runs out is finished by the
 * worker tick. The UI polls, so the run completes on screen either way. The
 * start is the function the run_visibility_check tool calls
 * (lib/visibility/manage.ts).
 */
export const maxDuration = 60;

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

  // The account's daily AI spend limit and its daily cap on runs, counted
  // with the API's run_visibility_check (lib/limits/guard.ts).
  const limited = await requireAccountCapacity(createAdminClient, user.id, "run_visibility_check");
  if (limited) return limited;

  const admin = createAdminClient();
  const started = await startVisibilityRun({ supabase, admin, userId: user.id, businessId });
  if (!started.ok) {
    return NextResponse.json({ error: started.error, code: started.code }, { status: started.status });
  }
  if (started.alreadyRunning) {
    return NextResponse.json({ success: true, alreadyRunning: true });
  }

  // Leave headroom under maxDuration so the response is never cut off.
  const outcome = await runJobNow(admin, started.jobId, 50_000);

  return NextResponse.json({ success: true, runId: started.runId, jobId: started.jobId, outcome });
}
