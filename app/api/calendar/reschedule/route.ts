import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { rescheduleArticle, rescheduleDateRefusal, sessionMove } from "@/lib/calendar/manage";
import { NO_BUSINESS_RESPONSE, selectedBusinessId } from "@/lib/tenancy";

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const articleId = typeof body.articleId === "string" ? body.articleId : "";
    const targetDate = typeof body.targetDate === "string" ? body.targetDate : "";

    const refused = articleId
      ? rescheduleDateRefusal(targetDate)
      : "articleId and targetDate (YYYY-MM-DD) are required";
    if (refused) {
      return NextResponse.json({ error: refused }, { status: 400 });
    }

    // move_article() checks the user; the selected site is checked in
    // rescheduleArticle, like every other calendar route, so an id from
    // another of the user's sites (a stale tab) is not found rather than
    // moved on a calendar not on screen. The same function the
    // reschedule_article tool calls (lib/calendar/manage.ts).
    const businessId = await selectedBusinessId(supabase, user.id);
    if (!businessId) {
      return NextResponse.json(NO_BUSINESS_RESPONSE, { status: 409 });
    }

    const result = await rescheduleArticle({
      supabase,
      userId: user.id,
      businessId,
      articleId,
      targetDate,
      move: sessionMove(supabase),
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error in calendar reschedule:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
