import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePaidAccess } from "@/lib/paid-access";
import { requireAccountCapacity } from "@/lib/limits/guard";
import { requestArticleGeneration } from "@/lib/articles/generate-now";
import { runJobNow } from "@/lib/jobs/worker";
import { NO_BUSINESS_RESPONSE, selectedBusinessId } from "@/lib/tenancy";

/**
 * Manual "generate now" / "regenerate".
 *
 * Same durable job as the daily run — only the trigger differs. It is executed
 * inline because the user is waiting, but the checkpoints are identical: if the
 * request runs out of time the worker tick finishes the job, and the UI (which
 * polls) shows the article completing on its own.
 *
 * Which statuses may start (or restart) production, one job per article, and
 * the enqueue are `requestArticleGeneration` (lib/articles/generate-now.ts),
 * which the `generate_article` tool calls too. A published article is
 * rewritten; `published_url` stays so the next deliver updates the existing
 * post instead of opening a second one.
 */
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = await requirePaidAccess(user);
  if (denied) return denied;

  const body = await request.json().catch(() => ({}));
  const articleId = typeof body.articleId === "string" ? body.articleId : "";
  if (!articleId) {
    return NextResponse.json({ error: "articleId is required" }, { status: 400 });
  }

  // The selected site scopes the lookup to the calendar the request came
  // from: an id from another of the user's sites is not found.
  const businessId = await selectedBusinessId(supabase, user.id);
  if (!businessId) {
    return NextResponse.json(NO_BUSINESS_RESPONSE, { status: 409 });
  }

  // The account's daily AI spend limit and its daily cap on generations,
  // counted with the API's generate_article (lib/limits/guard.ts).
  const limited = await requireAccountCapacity(createAdminClient, user.id, "generate_article");
  if (limited) return limited;

  // Jobs are service-role owned; ownership is checked first, on the user's client.
  const admin = createAdminClient();
  const started = await requestArticleGeneration({ supabase, admin, userId: user.id, businessId, articleId });
  if (!started.ok) {
    return NextResponse.json({ error: started.error }, { status: started.status });
  }
  if (started.alreadyRunning) {
    return NextResponse.json({ success: true, status: "generating", alreadyRunning: true });
  }
  const jobId = started.jobId;

  // Leave headroom under maxDuration so the response is never cut off.
  const outcome = await runJobNow(admin, jobId, 45_000);

  const { data: updated } = await admin
    .from("articles")
    .select("status, last_error")
    .eq("id", articleId)
    .maybeSingle();

  if (outcome === "failed") {
    return NextResponse.json(
      { error: updated?.last_error ?? "Failed to generate article", status: updated?.status },
      { status: 500 }
    );
  }

  return NextResponse.json({
    success: true,
    jobId,
    outcome,
    status: updated?.status ?? "generating",
  });
}
