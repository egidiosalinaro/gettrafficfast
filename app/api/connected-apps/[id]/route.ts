import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { revokeConnectedApp } from "@/lib/oauth/tokens";
import { apiError, apiErrorResponse } from "@/lib/api-errors";

/**
 * Revokes an app connected over OAuth (Settings → API keys → Connected
 * apps): every token of that grant, access and refresh, stops working on
 * its next use. Session cookie only, like revoking a key: no token can
 * revoke grants, so a leaked one cannot keep itself alive. The write goes
 * through the service role, scoped to the signed-in person explicitly
 * (lib/oauth/tokens.ts); a grant of another account is not found.
 */
export async function DELETE(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return apiErrorResponse(401, apiError("unauthorized", "Sign in to manage connected apps."));

  const { id } = await context.params;
  if (!z.string().uuid().safeParse(id).success) return apiErrorResponse(404, apiError("not_found", "Connected app not found"));
  const revoked = await revokeConnectedApp(createAdminClient(), user.id, id);
  if (!revoked.ok) {
    return apiErrorResponse(revoked.status, apiError(revoked.status === 404 ? "not_found" : "internal", revoked.error));
  }
  return NextResponse.json({ revoked: true });
}
