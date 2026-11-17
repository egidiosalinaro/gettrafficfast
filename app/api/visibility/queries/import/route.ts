import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { NO_BUSINESS_RESPONSE, selectedBusinessId } from "@/lib/tenancy";
import { importPromptsFromKeywords } from "@/lib/visibility/manage";

/**
 * Seeds the query set from the site's own keywords.
 *
 * Deterministic and free: each keyword becomes one query, verbatim, in a
 * cluster named after the keyword's topic when it has one. The owner then
 * edits, groups or disables them. No model rewrites anything here: a query
 * the owner did not see is a probe they cannot interpret. The same function
 * the import_prompts_from_keywords tool calls (lib/visibility/manage.ts).
 */

export async function POST() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const businessId = await selectedBusinessId(supabase, user.id);
  if (!businessId) return NextResponse.json(NO_BUSINESS_RESPONSE, { status: 409 });

  const result = await importPromptsFromKeywords({ supabase, userId: user.id, businessId });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

  return NextResponse.json({ added: result.added, duplicates: result.duplicates, skipped: result.skipped });
}
