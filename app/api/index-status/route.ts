import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { listIndexStatus } from "@/lib/analytics/index-status";
import { summarizeIndexing } from "@/lib/analytics/index-status-display";
import { selectedBusinessId } from "@/lib/tenancy";

/**
 * The selected site's indexing status: the summary (counts per Google state,
 * "N of M checked") and the rows, optionally one article's
 * (`?articleId=`) or one state's (`?state=not_indexed`).
 *
 * Read through the person's own session, so RLS is the access control. The
 * same function `list_index_status` calls (lib/analytics/index-status.ts).
 */

const STATES = new Set(["indexed", "not_indexed", "unknown"]);

export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const businessId = await selectedBusinessId(supabase, user.id);
    if (!businessId) {
      return NextResponse.json({ connected: false, siteUrl: null, summary: summarizeIndexing([], 0), rows: [] });
    }

    const params = request.nextUrl.searchParams;
    const state = params.get("state");
    return NextResponse.json(
      await listIndexStatus(supabase, businessId, {
        articleId: params.get("articleId") ?? undefined,
        state: state && STATES.has(state) ? (state as "indexed" | "not_indexed" | "unknown") : undefined,
      })
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
