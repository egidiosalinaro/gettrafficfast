import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { emptyResults, loadResults } from "@/lib/lifecycle/load-results";
import { selectedBusinessId } from "@/lib/tenancy";

/**
 * Everything the customer's results view needs, in one request.
 *
 * Reads through the user's own session, so RLS is the access control: a user
 * can only ever see their own metrics, and this route cannot leak another
 * tenant's numbers even if it tried. The reading and the arithmetic are
 * lib/lifecycle/load-results.ts, which the Overview and `get_results` share.
 */

export async function GET() {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const businessId = await selectedBusinessId(supabase, user.id);
    if (!businessId) {
      return NextResponse.json(emptyResults());
    }

    return NextResponse.json(await loadResults(supabase, businessId));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
