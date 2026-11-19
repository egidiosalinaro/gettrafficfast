import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { dismissTodayArticles, MAX_DISMISS } from "@/lib/calendar/manage";
import { NO_BUSINESS_RESPONSE, selectedBusinessId } from "@/lib/tenancy";

/**
 * Ignore on Today's article cards, failed or held (2026-11-19). `{ articleIds }`
 * for some, `{}` for all of them on the selected site. The articles keep their
 * state and stay on the Content board; only their Today card goes.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  let articleIds: string[] | undefined;
  if (body.articleIds !== undefined) {
    if (
      !Array.isArray(body.articleIds) ||
      body.articleIds.length === 0 ||
      body.articleIds.length > MAX_DISMISS ||
      body.articleIds.some((id: unknown) => typeof id !== "string" || id.length === 0)
    ) {
      return NextResponse.json({ error: `articleIds must be 1 to ${MAX_DISMISS} article ids` }, { status: 400 });
    }
    articleIds = body.articleIds;
  }

  const businessId = await selectedBusinessId(supabase, user.id);
  if (!businessId) {
    return NextResponse.json(NO_BUSINESS_RESPONSE, { status: 409 });
  }

  // The same function the dismiss_today_articles tool calls (lib/calendar/manage.ts).
  const result = await dismissTodayArticles({ supabase, userId: user.id, businessId, articleIds });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ success: true, dismissed: result.dismissed, articleIds: result.articleIds });
}
