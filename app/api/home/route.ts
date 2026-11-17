import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { selectedBusinessId } from "@/lib/tenancy";
import { emptyHomeSnapshot, loadHomeSnapshot } from "@/lib/home-snapshot";

/**
 * Snapshot the home view needs: the operating loop, the next action, and
 * enough of the calendar and keyword pool to show what is actually in
 * motion — without pulling article bodies. Assembled by
 * lib/home-snapshot.ts, which `get_home` reads too.
 */

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const businessId = await selectedBusinessId(supabase, user.id);
  if (!businessId) {
    return NextResponse.json(emptyHomeSnapshot());
  }

  const home = await loadHomeSnapshot(supabase, businessId);
  if (!home.ok) {
    return NextResponse.json({ error: home.error }, { status: 500 });
  }
  return NextResponse.json(home.snapshot);
}
