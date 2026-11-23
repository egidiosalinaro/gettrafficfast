import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { revokeApiKey } from "@/lib/api-keys";
import { apiError, apiErrorResponse } from "@/lib/api-errors";
import { saveDefaultSite } from "@/lib/tools/site";

const DefaultSiteBody = z.object({ defaultSite: z.string().trim().max(200).nullable() });

/**
 * Changes a key's default site (Settings → Claude and API): the site its
 * calls act on when they name none. `defaultSite` is a site's id (the
 * screen's picker), name or domain; null goes back to the oldest site. The
 * same function as the `set_default_site` tool (lib/tools/site.ts
 * `saveDefaultSite`), through the person's own client: RLS lets the owner
 * update their keys, and the database checks the site is theirs.
 */
export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return apiErrorResponse(401, apiError("unauthorized", "Sign in to manage API keys."));

  const { id } = await context.params;
  if (!z.string().uuid().safeParse(id).success) return apiErrorResponse(404, apiError("not_found", "Key not found"));
  const body = DefaultSiteBody.safeParse(await request.json().catch(() => null));
  if (!body.success) return apiErrorResponse(400, apiError("invalid_input", "Send { defaultSite: a site id, or null for the oldest site }."));
  try {
    const saved = await saveDefaultSite(supabase, {
      userId: user.id,
      credential: { kind: "api_key", id },
      value: body.data.defaultSite,
    });
    if (!saved.ok) return apiErrorResponse(saved.error.status, apiError(saved.error.code, saved.error.message, saved.error.hint));
    return NextResponse.json({ defaultSite: saved.site, defaultSource: saved.source });
  } catch (error) {
    return apiErrorResponse(500, apiError("internal", error instanceof Error ? error.message : String(error)));
  }
}

/**
 * Revokes one of the signed-in person's API keys. Session cookie only, like
 * creating one; the row stays, with `revoked_at`, so Settings can say when a
 * key stopped working. A revoked key is refused on its next call.
 */
export async function DELETE(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return apiErrorResponse(401, apiError("unauthorized", "Sign in to manage API keys."));

  const { id } = await context.params;
  if (!z.string().uuid().safeParse(id).success) return apiErrorResponse(404, apiError("not_found", "Key not found"));
  const revoked = await revokeApiKey(supabase, user.id, id);
  if (!revoked.ok) {
    return apiErrorResponse(revoked.status, apiError(revoked.status === 404 ? "not_found" : "internal", revoked.error));
  }
  return NextResponse.json({ apiKey: revoked.apiKey });
}
