import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { NO_BUSINESS_RESPONSE, selectedBusinessId } from "@/lib/tenancy";
import { EditDraftBody, editDraft } from "@/lib/placements/edit";

/**
 * Editing a draft. The save is `editDraft` (lib/placements/edit.ts), the
 * same function as the API's `edit_reply_draft`: the gate runs again on
 * every save, a reply never gets a link added, and in the variants that
 * carry one the link is placed by code on the business's name.
 */

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const businessId = await selectedBusinessId(supabase, user.id);
  if (!businessId) return NextResponse.json(NO_BUSINESS_RESPONSE, { status: 409 });

  const parsed = EditDraftBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ") },
      { status: 400 }
    );
  }

  const { id } = await context.params;
  const result = await editDraft({
    supabase,
    businessId,
    draftId: id,
    body: parsed.data.body,
    linkUrl: parsed.data.linkUrl ?? null,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ draft: result.draft, targetStatus: result.targetStatus });
}
