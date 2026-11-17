import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { NO_BUSINESS_RESPONSE, selectedBusinessId } from "@/lib/tenancy";
import { promoteToNotes } from "@/lib/placements/feedback";

/**
 * Makes one correction note permanent: its reason becomes the last line of
 * the writer's notes (Settings → Voice), which every draft carries as rules.
 * No model is called. Refused with a sentence when the notes are full.
 */

export async function POST(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const businessId = await selectedBusinessId(supabase, user.id);
  if (!businessId) return NextResponse.json(NO_BUSINESS_RESPONSE, { status: 409 });

  const { id } = await context.params;
  const result = await promoteToNotes({
    supabase,
    admin: createAdminClient(),
    userId: user.id,
    businessId,
    feedbackId: id,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({
    feedback: result.feedback,
    instructions: result.instructions,
    appended: result.appended,
  });
}
