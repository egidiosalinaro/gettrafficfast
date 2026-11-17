import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { loadGrowth } from "@/lib/growth/read";
import { parseGrowthDays } from "@/lib/growth/period";
import { loadResults } from "@/lib/lifecycle/load-results";
import { isXApiEnabled } from "@/lib/providers/x/api";
import { selectedBusinessId } from "@/lib/tenancy";

/**
 * Growth (`/growth`) in one request: the period's three blocks
 * (`loadGrowth`, the function `get_growth` calls) and the articles behind
 * Google (`loadResults`, the function `get_results` calls) for "By article"
 * and the traffic chart. `?days=28` for 28 days, else 7.
 *
 * Through the user's own session, so RLS is the access control. Stored rows
 * only: nothing here asks an engine, Google or X.
 */
export async function GET(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const businessId = await selectedBusinessId(supabase, user.id);
    if (!businessId) return NextResponse.json({ hasBusiness: false });

    const days = parseGrowthDays(new URL(request.url).searchParams.get("days"));
    const [growth, results] = await Promise.all([
      loadGrowth(supabase, businessId, { days, xApiEnabled: isXApiEnabled() }),
      loadResults(supabase, businessId),
    ]);
    return NextResponse.json({ hasBusiness: true, growth, results });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
