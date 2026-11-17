import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePaidAccess } from "@/lib/paid-access";
import { requireAccountCapacity } from "@/lib/limits/guard";
import { listArticlePushes, requestArticlePush } from "@/lib/lifecycle/push-store";
import { NO_BUSINESS_RESPONSE, selectedBusinessId } from "@/lib/tenancy";

/**
 * Push page 3 (docs/LIFECYCLE.md): GET lists the selected site's pushes
 * (`?articleId=` for one article), the `list_article_pushes` tool's read;
 * POST pushes one published article now, the `push_article` tool's
 * function (lib/lifecycle/push-store.ts). POST is paid: one model call,
 * behind the paywall and the account's spend ceiling.
 */

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const businessId = await selectedBusinessId(supabase, user.id);
  if (!businessId) return NextResponse.json(NO_BUSINESS_RESPONSE, { status: 409 });
  const articleId = request.nextUrl.searchParams.get("articleId");
  if (articleId && !z.string().uuid().safeParse(articleId).success) {
    return NextResponse.json({ error: "articleId must be a uuid" }, { status: 400 });
  }
  const pushes = await listArticlePushes(supabase, businessId, { articleId: articleId ?? undefined });
  return NextResponse.json({ pushes });
}

const Body = z.object({ articleId: z.string().uuid() });

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
  const parsed = Body.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "articleId is required" }, { status: 400 });
  const limited = await requireAccountCapacity(createAdminClient, user.id, null);
  if (limited) return limited;
  const result = await requestArticlePush({ admin: createAdminClient(), userId: user.id, businessId, articleId: parsed.data.articleId });
  if (!result.ok) return NextResponse.json({ error: result.error, code: result.code }, { status: result.status });
  return NextResponse.json({ push: result.push });
}
