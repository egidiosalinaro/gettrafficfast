import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { MAX_BULK_SCHEDULE, scheduleKeywords } from "@/lib/calendar/manage";
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
    // Every queued article is one the generation cron will pay to write.
    const denied = await requirePaidAccess(user);
    if (denied) return denied;

    const businessId = await selectedBusinessId(supabase, user.id);
    if (!businessId) {
      return NextResponse.json(NO_BUSINESS_RESPONSE, { status: 409 });
    }

    const body = await request.json();
    const keywordIds: unknown = body?.keywordIds;

    if (!Array.isArray(keywordIds) || keywordIds.length === 0) {
      return NextResponse.json(
        { error: "keywordIds must be a non-empty array" },
        { status: 400 }
      );
    }

    if (keywordIds.length > MAX_BULK_SCHEDULE) {
      return NextResponse.json(
        { error: `You can add at most ${MAX_BULK_SCHEDULE} keywords at a time` },
        { status: 400 }
      );
    }

    // Only keywords of this site that are not already on the calendar, on
    // the site's free days: the function the schedule_keywords tool calls.
    const result = await scheduleKeywords({
      supabase,
      userId: user.id,
      businessId,
      keywordIds: keywordIds.filter((id): id is string => typeof id === "string"),
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    // `overlapping`: keywords left out because a near-duplicate is already
    // scheduled, being written or published, each with its reason.
    return NextResponse.json({
      success: true,
      added: result.added,
      message: result.message,
      ...(result.overlapping.length > 0 ? { overlapping: result.overlapping } : {}),
    });
  } catch (error) {
    console.error("Error in bulk calendar add:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
