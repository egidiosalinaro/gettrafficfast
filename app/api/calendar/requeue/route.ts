import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { retryArticle } from "@/lib/calendar/manage";
import { NO_BUSINESS_RESPONSE, selectedBusinessId } from "@/lib/tenancy";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const articleId = typeof body.articleId === "string" ? body.articleId : "";
  if (!articleId) {
    return NextResponse.json({ error: "articleId is required" }, { status: 400 });
  }

  // Scoped to the selected site as well as the user, like the other calendar
  // routes. No paid guard: re-queueing spends nothing by itself, and the
  // generation cron does not produce for an account without a subscription.
  const businessId = await selectedBusinessId(supabase, user.id);
  if (!businessId) {
    return NextResponse.json(NO_BUSINESS_RESPONSE, { status: 409 });
  }

  // The same function the retry_article tool calls (lib/calendar/manage.ts).
  const result = await retryArticle({ supabase, userId: user.id, businessId, articleId });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json({ success: true });
}
