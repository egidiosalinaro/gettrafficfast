import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { NO_BUSINESS_RESPONSE, selectedBusinessId } from "@/lib/tenancy";
import { requirePaidAccess } from "@/lib/paid-access";
import { OWN_REPLY_MAX, saveOwnReply } from "@/lib/placements/own-reply";

/**
 * "Write your own": stores the reply a person typed on a card with no draft,
 * before Reply on X opens. The same gate as every draft judges it, no model
 * is called, and the row is the person's (lib/placements/own-reply.ts), so
 * "I posted it" can record which text went out.
 */

const OwnReplyInput = z.object({
  body: z.string().trim().min(1, "Write your reply first.").max(OWN_REPLY_MAX),
});

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePaidAccess(user);
  if (denied) return denied;

  const businessId = await selectedBusinessId(supabase, user.id);
  if (!businessId) return NextResponse.json(NO_BUSINESS_RESPONSE, { status: 409 });

  const parsed = OwnReplyInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Write your reply first." }, { status: 400 });
  }

  const { id } = await context.params;
  const saved = await saveOwnReply({
    supabase,
    admin: createAdminClient(),
    userId: user.id,
    businessId,
    targetId: id,
    body: parsed.data.body,
  });
  if (!saved.ok) return NextResponse.json({ error: saved.error }, { status: saved.status });
  return NextResponse.json({ draft: saved.draft, targetStatus: saved.targetStatus }, { status: 201 });
}
