import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { selectedBusinessId } from "@/lib/tenancy";
import { loadOverview } from "@/lib/visibility/read";

/**
 * Everything the AI Visibility dashboard needs, in one request, read through
 * the user's own session so RLS is the access control and `business_id` is
 * the scope on top of it.
 */
export async function GET() {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const businessId = await selectedBusinessId(supabase, user.id);
    if (!businessId) return NextResponse.json({ hasBusiness: false });

    const overview = await loadOverview(supabase, businessId);
    return NextResponse.json({ hasBusiness: true, ...overview });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
