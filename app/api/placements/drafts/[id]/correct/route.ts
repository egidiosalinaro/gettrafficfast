import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { NO_BUSINESS_RESPONSE, selectedBusinessId } from "@/lib/tenancy";
import { requireCorrectionCapacity, requirePaidAccess } from "@/lib/paid-access";
import { requireAccountCapacity } from "@/lib/limits/guard";
import { FeedbackReason } from "@/lib/placements/feedback";
import { correctDraft } from "@/lib/placements/correct";

/**
 * "Fix with a note" on a draft: the owner says why it is wrong, the note is
 * kept, and the draft is rewritten once following it and judged again by
 * the gate (lib/placements/correct.ts, docs/PLACEMENTS.md "Corrections").
 *
 * Body: `{ reason, body? }`. `reason` is 3 to 300 characters; `body` is the
 * text as the person edited it, when they did, else the stored draft is
 * rewritten. One model call inside the request, so the paywall and the
 * daily correction cap come first.
 */

export const maxDuration = 60;

/** Under maxDuration, so a slow provider is cut off before the function is. */
const DEADLINE_MS = 55_000;

const CorrectInput = z.object({
  reason: FeedbackReason,
  body: z.string().trim().min(1).max(20_000).nullable().optional(),
});

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

  const parsed = CorrectInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const error =
      issue?.path[0] === "reason" ? issue.message : issue ? `${issue.path.join(".") || "input"}: ${issue.message}` : "Invalid input";
    return NextResponse.json({ error }, { status: 400 });
  }

  const capped = await requireCorrectionCapacity(supabase, user.id);
  if (capped) return capped;
  // One model call: the account's daily AI spend limit (lib/limits/guard.ts).
  const limited = await requireAccountCapacity(createAdminClient, user.id, null);
  if (limited) return limited;

  const { id } = await context.params;
  const result = await correctDraft({
    supabase,
    admin: createAdminClient(),
    userId: user.id,
    businessId,
    draftId: id,
    reason: parsed.data.reason,
    body: parsed.data.body ?? null,
    signal: AbortSignal.timeout(DEADLINE_MS),
  });
  if (!result.ok) {
    return NextResponse.json(
      {
        error: result.error,
        ...(result.settingsHref ? { settingsHref: result.settingsHref } : {}),
        ...(result.feedbackId ? { feedbackId: result.feedbackId } : {}),
      },
      { status: result.status }
    );
  }
  return NextResponse.json({
    draft: result.draft,
    audit: result.audit,
    targetStatus: result.targetStatus,
    feedbackId: result.feedbackId,
  });
}
