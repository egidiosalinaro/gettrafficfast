import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { selectedBusinessId } from "@/lib/tenancy";
import { OVERLAP_NOTE, loadOverlappingTopics } from "@/lib/keywords/overlap";

/**
 * "Overlapping topics" on the Keywords screen: clusters of the selected
 * site's keywords that are near-duplicates, each with its articles, what
 * Search Console counted for them, and the one to keep. The same read as
 * `list_duplicate_keywords` (lib/keywords/overlap.ts): the site's own rows,
 * no model, nothing changed.
 */
export async function GET() {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // No site yet means no keywords yet: no clusters, as the pool answers.
    const businessId = await selectedBusinessId(supabase, user.id);
    if (!businessId) {
      return NextResponse.json({ clusters: [], note: OVERLAP_NOTE });
    }

    const read = await loadOverlappingTopics(supabase, businessId);
    if (!read.ok) {
      console.error("Error fetching overlapping topics:", read.error);
      return NextResponse.json({ error: "Failed to fetch overlapping topics" }, { status: 500 });
    }

    return NextResponse.json({ clusters: read.clusters, note: OVERLAP_NOTE });
  } catch (error) {
    console.error("Error in overlaps endpoint:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
