import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { NO_BUSINESS_RESPONSE, selectedBusinessId } from "@/lib/tenancy";
import { loadContentView } from "@/lib/calendar/content";

/**
 * The Content screen (`/content`): today's article, the week, the next
 * topics and the counts behind its links. Assembled by
 * lib/calendar/content.ts, which `get_content` reads too. No bodies.
 */
export async function GET() {
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

  const content = await loadContentView(supabase, businessId);
  if (!content.ok) {
    console.error("Error reading Content:", content.error);
    return NextResponse.json({ error: "Failed to read Content" }, { status: 500 });
  }
  return NextResponse.json(content.view);
}
