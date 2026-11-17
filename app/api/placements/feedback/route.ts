import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { NO_BUSINESS_RESPONSE, selectedBusinessId } from "@/lib/tenancy";
import { listFeedback } from "@/lib/placements/feedback";

/**
 * The notes the owner gave on the selected site's drafts, newest first, for
 * a settings view: each with the text before and after its rewrite and
 * whether it was added to Settings → Voice → notes. A read through the
 * person's own client: RLS is the access control, `business_id` the scope.
 */

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const businessId = await selectedBusinessId(supabase, user.id);
  if (!businessId) return NextResponse.json(NO_BUSINESS_RESPONSE, { status: 409 });

  const listed = await listFeedback(supabase, businessId);
  if (!listed.ok) return NextResponse.json({ error: listed.error }, { status: 500 });
  return NextResponse.json({ feedback: listed.feedback });
}
