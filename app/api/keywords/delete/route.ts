import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { deleteKeywords } from "@/lib/keywords/manage";
import { NO_BUSINESS_RESPONSE, selectedBusinessId } from "@/lib/tenancy";

export async function DELETE(request: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const searchParams = request.nextUrl.searchParams;
    const keywordIds = searchParams.get("ids");

    if (!keywordIds) {
      return NextResponse.json(
        { error: "Keyword IDs are required" },
        { status: 400 }
      );
    }

    const ids = keywordIds.split(",");

    // The selected site, like every other keyword route: ids from another of
    // the user's sites are left alone.
    const businessId = await selectedBusinessId(supabase, user.id);
    if (!businessId) {
      return NextResponse.json(NO_BUSINESS_RESPONSE, { status: 409 });
    }

    // The same function the delete_keywords tool calls (lib/keywords/manage.ts).
    const result = await deleteKeywords({ supabase, userId: user.id, businessId, ids });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error in delete endpoint:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
