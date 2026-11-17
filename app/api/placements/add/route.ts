import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { NO_BUSINESS_RESPONSE, selectedBusinessId } from "@/lib/tenancy";
import { AddXPostBody, addXPost } from "@/lib/placements/add";
import { requirePaidAccess } from "@/lib/paid-access";
import { requireAccountCapacity } from "@/lib/limits/guard";

/**
 * "Add a post from X": one post, by its link, into the selected site's
 * inbox, qualified by the person who pasted it, and its draft started
 * (`addXPost`, lib/placements/add.ts, shared with the API's `add_x_post`).
 *
 * The draft is enqueued, not run: the card appears at once and follows the
 * job the way "Generate draft" does (`POST /api/placements/:id/draft` with
 * `continue`, which runs it inline), and the worker tick finishes it if the
 * tab is closed.
 */
export const maxDuration = 30;

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePaidAccess(user);
  if (denied) return denied;

  const businessId = await selectedBusinessId(supabase, user.id);
  if (!businessId) return NextResponse.json(NO_BUSINESS_RESPONSE, { status: 409 });

  const parsed = AddXPostBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Paste the link of a post on X.", code: "not_x_post" }, { status: 400 });
  }

  // Adding a post starts its draft: the account's daily AI spend limit
  // first (lib/limits/guard.ts); the draft cap is addXPost's own.
  const limited = await requireAccountCapacity(createAdminClient, user.id, null);
  if (limited) return limited;

  const added = await addXPost({
    supabase,
    admin: createAdminClient(),
    userId: user.id,
    businessId,
    url: parsed.data.url,
    pastedText: parsed.data.text ?? null,
  });
  if (!added.ok) return NextResponse.json({ error: added.error, code: added.code }, { status: 400 });

  return NextResponse.json({
    success: true,
    outcome: added.outcome,
    textFrom: added.textFrom,
    target: added.target,
    draft: added.draft,
  });
}
