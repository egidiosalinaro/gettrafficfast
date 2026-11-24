import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { selectedBusinessId } from "@/lib/tenancy";
import { loadCalendarArticles } from "@/lib/calendar/read";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The calendar's articles, bodies included. `?articleId=` narrows it to one
 * article of the selected site, in the same shape, without reading every
 * body.
 */
export async function GET(request?: Request) {
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
      return NextResponse.json({ articles: [] });
    }

    const articleId = request ? new URL(request.url).searchParams.get("articleId")?.trim() || undefined : undefined;
    // Not an id at all: no article has it (and Postgres would refuse the uuid).
    if (articleId !== undefined && !UUID.test(articleId)) {
      return NextResponse.json({ articles: [] });
    }

    // The same read as `list_calendar` and `get_article` (lib/calendar/read.ts).
    const calendar = await loadCalendarArticles(supabase, businessId, { articleId });
    if (!calendar.ok) {
      console.error("Error fetching calendar:", calendar.error);
      return NextResponse.json(
        { error: "Failed to fetch calendar" },
        { status: 500 }
      );
    }

    return NextResponse.json({ articles: calendar.articles });
  } catch (error) {
    console.error("Error in calendar get:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
