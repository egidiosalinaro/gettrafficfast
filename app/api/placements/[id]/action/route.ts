import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { NO_BUSINESS_RESPONSE, selectedBusinessId } from "@/lib/tenancy";
import { ManualActionBody, applyManualAction } from "@/lib/placements/actions";

/**
 * The manual workflow: I posted it, add the reply's link, skip, snooze,
 * bring back (and approve, kept for a tab open across a deploy).
 *
 * The move itself is `applyManualAction` (lib/placements/actions.ts), the
 * same function the API's tools call: planned by `planManualAction` before
 * the row is touched, through the user's own client so RLS is the access
 * control, and, once a link is saved, the reply's text read back from X
 * after the response (`capturePublishedText`), never delaying or failing
 * the person's action.
 */

const SIGNED_OUT = "You've been signed out. Sign in again.";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: SIGNED_OUT }, { status: 401 });

  const businessId = await selectedBusinessId(supabase, user.id);
  if (!businessId) return NextResponse.json(NO_BUSINESS_RESPONSE, { status: 409 });

  const parsed = ManualActionBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ") },
      { status: 400 }
    );
  }

  const { id } = await context.params;
  const result = await applyManualAction({ supabase, businessId, targetId: id, input: parsed.data });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ target: result.target });
}
