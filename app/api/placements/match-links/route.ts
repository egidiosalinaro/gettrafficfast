import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { NO_BUSINESS_RESPONSE, selectedBusinessId } from "@/lib/tenancy";
import { matchPastedReplyLinks } from "@/lib/placements/link-paste";
import { MAX_LINKS_PER_PASTE } from "@/lib/placements/paste";

/**
 * "Paste your reply links": says which posted reply each pasted link
 * belongs to (`matchPastedReplyLinks`, lib/placements/link-paste.ts, the
 * function the `paste_reply_links` tool calls). It decides and stores
 * nothing: a link that is assigned is then saved by the page through the
 * action route (`set_published_url`), the one path a link is ever saved
 * by, with its own check; a link that is not sure comes back as a question
 * with its candidates.
 *
 * Read through the caller's own session: RLS is the access control and
 * `business_id` the scope.
 */
export const maxDuration = 30;

const Body = z.object({ links: z.array(z.string().max(2_000)).min(1).max(MAX_LINKS_PER_PASTE) });

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "You've been signed out. Sign in again." }, { status: 401 });

  const businessId = await selectedBusinessId(supabase, user.id);
  if (!businessId) return NextResponse.json(NO_BUSINESS_RESPONSE, { status: 409 });

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: `Paste between 1 and ${MAX_LINKS_PER_PASTE} links.` }, { status: 400 });
  }

  const result = await matchPastedReplyLinks({ supabase, businessId, links: parsed.data.links });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 });
  return NextResponse.json({ matches: result.matches });
}
