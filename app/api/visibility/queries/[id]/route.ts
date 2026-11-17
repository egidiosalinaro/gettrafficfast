import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { selectedBusinessId } from "@/lib/tenancy";
import { loadQueryDetail } from "@/lib/visibility/read";

/** One query's history: every probe, per engine, plus what recurs around it. */
export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const businessId = await selectedBusinessId(supabase, user.id);
    if (!businessId) return NextResponse.json({ error: "No business" }, { status: 409 });

    const { id } = await context.params;
    const detail = await loadQueryDetail(supabase, businessId, id);
    if (!detail) return NextResponse.json({ error: "Prompt not found" }, { status: 404 });

    return NextResponse.json(detail);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
