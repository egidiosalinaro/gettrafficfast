import { NextRequest, NextResponse } from "next/server";
import {
  DEFAULT_COMPARISON_DAYS,
  emptyProviderComparison,
  loadProviderComparison,
  MAX_COMPARISON_DAYS,
  withoutCosts,
} from "@/lib/articles/provider-comparison";
import { isPlatformOwner } from "@/lib/owner";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { selectedBusinessId } from "@/lib/tenancy";

/**
 * The article rotation read back for the selected site: what each provider
 * arm did, per agent and per article (docs/CONTENT_PIPELINE.md, "The
 * provider rotation"). The same read as the `compare_article_providers`
 * tool (lib/articles/provider-comparison.ts).
 *
 * The site's jobs are read through the person's own session, so RLS decides
 * what is theirs; the service role reads only the checkpoints and agent
 * runs of those jobs, by id. Asks no model.
 *
 * Every agent's `avgCostUsd` (an estimate of what the platform pays per run)
 * is answered to a platform owner only (lib/owner.ts); everyone else, like
 * the tool, gets the comparison without it.
 */

export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const asked = Number(request.nextUrl.searchParams.get("days") ?? DEFAULT_COMPARISON_DAYS);
    const days = Number.isFinite(asked)
      ? Math.min(MAX_COMPARISON_DAYS, Math.max(1, Math.floor(asked)))
      : DEFAULT_COMPARISON_DAYS;

    const businessId = await selectedBusinessId(supabase, user.id);
    if (!businessId) {
      return NextResponse.json(emptyProviderComparison(days));
    }

    const comparison = await loadProviderComparison({ client: supabase, admin: createAdminClient(), businessId, days });
    // The cost per run is what the platform pays: a platform owner's, never a customer's.
    return NextResponse.json(isPlatformOwner(user.id) ? comparison : withoutCosts(comparison));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
