import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveArticlePush } from "@/lib/lifecycle/push-store";
import { NO_BUSINESS_RESPONSE, selectedBusinessId } from "@/lib/tenancy";

/**
 * The customer's answer to a push proposal (Today, the article modal):
 * `applied` ("I added it": the measurement starts today) or `dismissed`.
 * The `resolve_article_push` tool's function. Free.
 */

const Body = z.object({ action: z.enum(["applied", "dismissed"]) });

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const businessId = await selectedBusinessId(supabase, user.id);
  if (!businessId) return NextResponse.json(NO_BUSINESS_RESPONSE, { status: 409 });
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const parsed = Body.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "action must be applied or dismissed" }, { status: 400 });
  const result = await resolveArticlePush({ admin: createAdminClient(), userId: user.id, businessId, pushId: id, action: parsed.data.action });
  if (!result.ok) return NextResponse.json({ error: result.error, code: result.code }, { status: result.status });
  return NextResponse.json({ push: result.push });
}
