import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { setKeywordStarred, UpdateKeywordInput } from "@/lib/keywords/manage";
import { NO_BUSINESS_RESPONSE, selectedBusinessId } from "@/lib/tenancy";

/**
 * Stars or unstars a keyword: the only field the keywords page changes.
 * The body's rule (`UpdateKeywordInput`) and the write live in
 * lib/keywords/manage.ts, which the update_keyword tool shares.
 */
export async function PATCH(request: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const parsed = UpdateKeywordInput.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "keywordId and updates ({ is_starred: boolean }) are required" },
        { status: 400 }
      );
    }
    const { keywordId, updates } = parsed.data;

    // The selected site, like every other keyword route: an id from another
    // of the user's sites is not found here.
    const businessId = await selectedBusinessId(supabase, user.id);
    if (!businessId) {
      return NextResponse.json(NO_BUSINESS_RESPONSE, { status: 409 });
    }

    const result = await setKeywordStarred({
      supabase,
      userId: user.id,
      businessId,
      keywordId,
      starred: updates.is_starred,
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    return NextResponse.json({ success: true, keyword: result.keyword });
  } catch (error) {
    console.error("Error in update endpoint:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
