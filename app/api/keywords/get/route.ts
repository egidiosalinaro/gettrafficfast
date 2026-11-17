import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { selectedBusinessId } from "@/lib/tenancy";
import { loadKeywords } from "@/lib/keywords/read";

export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // No site yet means no pool yet: an empty list, not an error, because
    // the page that fixes it is one click away in the sidebar.
    const businessId = await selectedBusinessId(supabase, user.id);
    if (!businessId) {
      return NextResponse.json({ keywords: [] });
    }

    const searchParams = request.nextUrl.searchParams;
    // The same read as `list_keywords` (lib/keywords/read.ts).
    const pool = await loadKeywords(supabase, businessId, {
      search: searchParams.get("search") || "",
      status: searchParams.get("status") || "",
    });

    if (!pool.ok) {
      console.error("Error fetching keywords:", pool.error);
      return NextResponse.json(
        { error: "Failed to fetch keywords" },
        { status: 500 }
      );
    }

    return NextResponse.json({ keywords: pool.keywords });
  } catch (error) {
    console.error("Error in get endpoint:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
