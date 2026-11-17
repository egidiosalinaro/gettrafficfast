import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { scheduleOverlap } from "@/lib/calendar/manage";
import { nextFreeDays } from "@/lib/calendar/schedule";
import { requirePaidAccess } from "@/lib/paid-access";
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
    // A queued article is one the generation cron will pay to write.
    const denied = await requirePaidAccess(user);
    if (denied) return denied;

    const businessId = await selectedBusinessId(supabase, user.id);
    if (!businessId) {
      return NextResponse.json(NO_BUSINESS_RESPONSE, { status: 409 });
    }

    const body = await request.json();
    const { keywordId } = body;

    if (!keywordId) {
      return NextResponse.json(
        { error: "keywordId is required" },
        { status: 400 }
      );
    }

    // Check keyword exists and belongs to user
    const { data: keyword, error: kwError } = await supabase
      .from("keywords")
      .select("id, keyword, search_volume, status, article_id")
      .eq("id", keywordId)
      .eq("business_id", businessId)
      .single();

    if (kwError || !keyword) {
      return NextResponse.json(
        { error: "Keyword not found" },
        { status: 404 }
      );
    }

    if (keyword.article_id) {
      return NextResponse.json(
        { error: "Keyword is already on the calendar" },
        { status: 409 }
      );
    }

    // Never two articles on one topic: a keyword whose near-duplicate is
    // already scheduled, being written or published is refused, with the
    // topic it overlaps (the rule the bulk add applies, lib/calendar/manage.ts).
    const overlap = await scheduleOverlap(supabase, businessId, keyword.id);
    if (overlap) {
      return NextResponse.json(
        { error: overlap.reason, code: "overlapping_topic", duplicateOf: overlap.duplicateOf },
        { status: 409 }
      );
    }

    // The first free day for THIS site (lib/calendar/schedule.ts).
    const [scheduledDateStr] = await nextFreeDays(supabase, businessId, 1);

    const { data: article, error: insertError } = await supabase
      .from("articles")
      .insert({
        user_id: user.id,
        business_id: businessId,
        keyword_id: keyword.id,
        scheduled_date: scheduledDateStr,
        status: "queued",
      })
      .select()
      .single();

    if (insertError) {
      console.error("Error adding to calendar:", insertError);
      return NextResponse.json(
        { error: "Failed to add to calendar" },
        { status: 500 }
      );
    }

    await supabase
      .from("keywords")
      .update({ status: "queued", article_id: article.id })
      .eq("id", keywordId)
      .eq("business_id", businessId)
      .eq("user_id", user.id);

    return NextResponse.json({ success: true, article });
  } catch (error) {
    console.error("Error in calendar add:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
