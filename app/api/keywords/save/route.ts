import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { addKeywords } from "@/lib/keywords/manage";
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

    const businessId = await selectedBusinessId(supabase, user.id);
    if (!businessId) {
      return NextResponse.json(NO_BUSINESS_RESPONSE, { status: 409 });
    }

    const body = await request.json();
    const { keywords } = body;

    if (!keywords || !Array.isArray(keywords) || keywords.length === 0) {
      return NextResponse.json(
        { error: "Keywords array is required" },
        { status: 400 }
      );
    }

    // The same function the add_keywords tool calls (lib/keywords/manage.ts).
    // A phrase that overlaps a topic the site already has is not added and
    // comes back in `duplicates`; `allowDuplicates: true` is the override.
    const result = await addKeywords({
      supabase,
      userId: user.id,
      businessId,
      keywords,
      allowDuplicates: body.allowDuplicates === true,
    });
    if (!result.ok) {
      return NextResponse.json(
        result.status === 409 ? { error: result.error, keywords: [] } : { error: result.error },
        { status: result.status }
      );
    }

    return NextResponse.json({
      success: true,
      keywords: result.keywords,
      ...(result.message ? { message: result.message } : {}),
      ...(result.duplicates.length > 0 ? { duplicates: result.duplicates } : {}),
    });
  } catch (error) {
    console.error("Error in save endpoint:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
