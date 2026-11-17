import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { selectedBusinessId } from "@/lib/tenancy";
import { loadQuestionIdeas } from "@/lib/keywords/read";

/**
 * "Questions people ask" on the Keywords screen: questions asked in the
 * public threads discovery found for the selected site, as keyword ideas.
 * The same read as `list_question_ideas` (lib/keywords/read.ts): the site's
 * own rows, no model, nothing saved.
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

    // No site yet means no threads yet: an empty list, as the pool answers.
    const businessId = await selectedBusinessId(supabase, user.id);
    if (!businessId) {
      return NextResponse.json({ questions: [] });
    }

    const ideas = await loadQuestionIdeas(supabase, businessId);
    if (!ideas.ok) {
      console.error("Error fetching question ideas:", ideas.error);
      return NextResponse.json({ error: "Failed to fetch questions" }, { status: 500 });
    }

    return NextResponse.json({ questions: ideas.questions });
  } catch (error) {
    console.error("Error in questions endpoint:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
