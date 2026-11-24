import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePaidAccess } from "@/lib/paid-access";
import { NO_BUSINESS_RESPONSE, selectedBusinessId } from "@/lib/tenancy";
import { postReplyOnX } from "@/lib/placements/x-post";

// One token refresh and one post on X, each up to 15 s.
export const maxDuration = 45;

const Body = z.object({ draftId: z.string().uuid() });

/**
 * Post on X: one press, one reply posted from the site's connected X account,
 * only on a post that mentions or quotes it (lib/placements/x-post.ts, the
 * function the post_on_x tool calls). The answer is the target, recorded as
 * posted with its real link; or the refusal with `code`, and, when X does
 * not allow the reply, `intentUrl`: X's composer with the text, which the
 * screen opens in the same click.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "You've been signed out. Sign in again." }, { status: 401 });
  const denied = await requirePaidAccess(user);
  if (denied) return denied;

  const businessId = await selectedBusinessId(supabase, user.id);
  if (!businessId) return NextResponse.json(NO_BUSINESS_RESPONSE, { status: 409 });

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "draftId: the draft to post" }, { status: 400 });

  const { id } = await context.params;
  const result = await postReplyOnX({
    supabase,
    admin: createAdminClient(),
    userId: user.id,
    businessId,
    targetId: id,
    draftId: parsed.data.draftId,
  });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, code: result.code, intentUrl: result.intentUrl ?? null, resetAt: result.resetAt ?? null },
      { status: result.status }
    );
  }
  return NextResponse.json({ target: result.target, url: result.url });
}
