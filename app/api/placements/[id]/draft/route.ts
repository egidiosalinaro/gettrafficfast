import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runJobNow } from "@/lib/jobs/worker";
import { NO_BUSINESS_RESPONSE, selectedBusinessId } from "@/lib/tenancy";
import { draftFailureForCard } from "@/lib/placements/draft-progress";
import { draftAuditOf, requestDraft } from "@/lib/placements/generate";
import { requirePaidAccess } from "@/lib/paid-access";
import { requireAccountCapacity } from "@/lib/limits/guard";

/**
 * "Generate draft" for one qualified target. The agent writes, the gate
 * judges, the agent writes again what did not pass, the rows land; nothing
 * is posted. What to do (refuse, start, resume, report) is `requestDraft`
 * (lib/placements/generate.ts), shared with the API's `draft_reply`; this
 * route runs the job inline.
 *
 * The inline window fits the job's MAX_WRITES quality-tier calls, at the
 * 20–30 s each they take in production: a person who clicked would rather
 * wait than be handed a draft the gate refused.
 */
export const maxDuration = 120;

const INLINE_BUDGET_MS = 105_000;

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePaidAccess(user);
  if (denied) return denied;

  const businessId = await selectedBusinessId(supabase, user.id);
  if (!businessId) return NextResponse.json(NO_BUSINESS_RESPONSE, { status: 409 });

  const { id } = await context.params;
  const admin = createAdminClient();
  // A follow-up from the open card must not enqueue a second draft. It only
  // continues the one already asked for, or reports how that one ended.
  // `anyway`: "Write it anyway" after a decline.
  const body = (await request.json().catch(() => null)) as { continue?: boolean; anyway?: boolean } | null;
  const mode = body?.continue === true ? "continue" : "start";
  // The account's daily AI spend limit (lib/limits/guard.ts), before a new
  // draft is asked for. Following one already asked for is refused only
  // when it would run it (below): a poll that finds the draft written
  // still shows it. `kind: "paused"`: the card offers no "Write it anyway".
  const spendLimit = () => requireAccountCapacity(createAdminClient, user.id, null, { kind: "paused" });
  if (mode === "start") {
    const limited = await spendLimit();
    if (limited) return limited;
  }
  const decided = await requestDraft({
    supabase,
    admin,
    userId: user.id,
    businessId,
    targetId: id,
    mode,
    anyway: body?.anyway === true,
  });

  if (!decided.ok) {
    if (decided.code === "cap_reached") {
      return NextResponse.json({ error: decided.error, code: "draft_limit" }, { status: 429 });
    }
    return NextResponse.json(
      { error: decided.error, ...(decided.settingsHref ? { settingsHref: decided.settingsHref } : {}) },
      { status: decided.status }
    );
  }

  const next = decided.next;
  switch (next.kind) {
    case "run": {
      if (mode === "continue") {
        const limited = await spendLimit();
        if (limited) return limited;
      }
      return respondWithJob(admin, next.jobId);
    }
    case "running":
      return NextResponse.json({ success: true, alreadyRunning: true, outcome: "running", jobId: next.jobId });
    case "idle":
      return NextResponse.json({ success: true, outcome: "idle" });
    case "failed":
      return failedResponse(next.lastError);
    case "completed":
      return NextResponse.json({ success: true, outcome: "completed", jobId: next.jobId, ...next.audit });
  }
}

async function respondWithJob(admin: ReturnType<typeof createAdminClient>, jobId: string) {
  const outcome = await runJobNow(admin, jobId, INLINE_BUDGET_MS);
  const { data: job } = await admin.from("jobs").select("last_error, result").eq("id", jobId).maybeSingle();
  if (outcome === "failed") return failedResponse((job?.last_error as string | null) ?? null);
  // What actually happened, so the inbox never says "written" when the
  // gate blocked every variant.
  return NextResponse.json({ success: true, jobId, outcome, ...draftAuditOf(job?.result ?? null) });
}

/**
 * How a draft that ended without text is told to the card. The job's own
 * sentence (a setting to fill in, a decline with its reason, a check that
 * stopped it), never a generic "failed"; a billing or provider failure is
 * one line saying drafting is paused, never the vendor's wording and never a
 * verdict on the thread. `kind` tells the card whether to offer "Write it
 * anyway" (a decline) or nothing (paused, failed).
 */
function failedResponse(lastError: string | null) {
  const { kind, text } = draftFailureForCard(lastError);
  return NextResponse.json({ error: text, kind }, { status: kind === "paused" ? 503 : 500 });
}
