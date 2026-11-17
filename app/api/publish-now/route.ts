import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePaidAccess } from "@/lib/paid-access";
import { publishArticleNow } from "@/lib/articles/publish-now";

// Publishing hits a customer endpoint (up to 10s) plus DB writes.
export const maxDuration = 30;

/**
 * Manual publish / republish.
 *
 * From `needs_review` this doubles as the human approval path: the user has
 * seen the quality report in the UI and is explicitly overriding it, so this
 * route acknowledges the quality issues on every call. Every other state
 * must pass the gates on its own. The logic is `publishArticleNow`
 * (lib/articles/publish-now.ts), which the `publish_article` tool calls too.
 */
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

  // Service role: publishing writes publish_attempts (no user insert policy) and
  // toggles integration status. Every query is still scoped to this user's id.
  const result = await publishArticleNow({
    admin: createAdminClient(),
    userId: user.id,
    articleId,
    // The screen showed the quality report; pressing Publish is the override.
    acknowledgeQualityIssues: true,
  });

  if (!result.ok) {
    return NextResponse.json(
      {
        error: result.error,
        ...(result.parked ? { status: "needs_review" } : {}),
        ...(result.issues ? { issues: result.issues } : {}),
        // Only a delivery failure belongs in Integrations.
        ...(result.code === "delivery_failed" ? { hint: "integrations" } : {}),
      },
      { status: result.status }
    );
  }

  return NextResponse.json({ success: true, url: result.url, republished: result.republished });
}
