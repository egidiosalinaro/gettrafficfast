import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isXApiEnabled } from "@/lib/providers/x/api";
import { loadReplyStats } from "@/lib/placements/reply-stats-read";
import { selectedBusinessId } from "@/lib/tenancy";

/**
 * Results → Replies on X: the week of the selected site's replies on X,
 * summed, and its own account's followers (lib/placements/reply-stats.ts).
 * Stored rows only, no call to X; through the user's own session, so RLS
 * is the access control. `get_reply_stats` answers the same.
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

    const stats = await loadReplyStats(supabase, businessId, { xApiEnabled: isXApiEnabled() });
    return NextResponse.json({ hasBusiness: true, ...stats });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
