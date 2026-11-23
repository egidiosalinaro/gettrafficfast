import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { revokeConnectedApp } from "@/lib/oauth/tokens";
import { apiError, apiErrorResponse } from "@/lib/api-errors";
import { saveDefaultSite } from "@/lib/tools/site";

const DefaultSiteBody = z.object({ defaultSite: z.string().trim().max(200).nullable() });

/**
 * Changes a connected app's default site (Settings → Claude and API): the
 * site its calls act on when they name none. `defaultSite` is a site's id
 * (the screen's picker), name or domain; null goes back to the oldest site.
 * The same function as the `set_default_site` tool (lib/tools/site.ts
 * `saveDefaultSite`). Session cookie only; the write goes through the
 * service role, scoped to the signed-in person explicitly, as Revoke does.
 */
export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return apiErrorResponse(401, apiError("unauthorized", "Sign in to manage connected apps."));

  const { id } = await context.params;
  if (!z.string().uuid().safeParse(id).success) return apiErrorResponse(404, apiError("not_found", "Connected app not found"));
  const body = DefaultSiteBody.safeParse(await request.json().catch(() => null));
  if (!body.success) return apiErrorResponse(400, apiError("invalid_input", "Send { defaultSite: a site id, or null for the oldest site }."));
  try {
    const saved = await saveDefaultSite(createAdminClient(), {
      userId: user.id,
      credential: { kind: "oauth", grantId: id },
      value: body.data.defaultSite,
    });
    if (!saved.ok) return apiErrorResponse(saved.error.status, apiError(saved.error.code, saved.error.message, saved.error.hint));
    return NextResponse.json({ defaultSite: saved.site, defaultSource: saved.source });
  } catch (error) {
    return apiErrorResponse(500, apiError("internal", error instanceof Error ? error.message : String(error)));
  }
}

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
