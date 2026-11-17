import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isPlatformOwner } from "@/lib/owner";
import { provisionReviewerAccount } from "@/lib/reviewer-account";

/**
 * /settings/costs: a platform owner sets up the MCP directory reviewers'
 * account (lib/reviewer-account.ts, docs/API.md "The reviewer account").
 *
 * Body: `{ email }`, an address on PASSWORD_LOGIN_EMAILS. Idempotent: the
 * user, the complimentary plan, the $1 ceiling and the demo site are created
 * only when missing; every call asks Supabase for a fresh set-password email.
 *
 * Anyone who is not an owner (lib/owner.ts) gets the same 404 a path that
 * does not exist gets. Session only: no API key reaches it. No password is
 * chosen, returned or logged here.
 */

const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404 });

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isPlatformOwner(user.id)) return notFound();

  const body = await request.json().catch(() => null);
  const provisioned = await provisionReviewerAccount({ admin: createAdminClient(), input: body });
  if (!provisioned.ok) {
    return NextResponse.json({ error: provisioned.error, code: provisioned.code }, { status: provisioned.status });
  }

  const { result } = provisioned;
  console.info(
    JSON.stringify({
      level: "info",
      event: "reviewer_account.provisioned",
      owner_id: user.id,
      user_id: result.userId,
      user: result.user,
      plan: result.plan,
      ceiling_usd: result.ceiling.usd,
      site_created: result.site.created,
      password_email_requested: result.passwordEmail.requested,
    })
  );
  return NextResponse.json(result);
}
