import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { inspectUrlNow } from "@/lib/analytics/index-status";
import { NO_BUSINESS_RESPONSE, selectedBusinessId } from "@/lib/tenancy";

/**
 * "Check now" on a published article: Google's URL Inspection for that one
 * URL, stored and returned. Free; the site's daily inspection cap counts it.
 * The same function `inspect_url` calls (lib/analytics/index-status.ts).
 *
 * The article is looked up among the selected site's published articles, so
 * an id of another site is simply not found.
 */

export const maxDuration = 60;

const Body = z.object({
  articleId: z.string().uuid().optional(),
  url: z.string().trim().min(1).max(2000).optional(),
});

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const businessId = await selectedBusinessId(supabase, user.id);
  if (!businessId) return NextResponse.json(NO_BUSINESS_RESPONSE, { status: 409 });

  const parsed = Body.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success || (!parsed.data.articleId && !parsed.data.url)) {
    return NextResponse.json({ error: "articleId or url is required" }, { status: 400 });
  }

  const result = await inspectUrlNow({
    admin: createAdminClient(),
    userId: user.id,
    businessId,
    articleId: parsed.data.articleId,
    url: parsed.data.url,
  });
  if (!result.ok) return NextResponse.json({ error: result.error, code: result.code }, { status: result.status });
  return NextResponse.json({ row: result.row, fresh: result.fresh });
}
