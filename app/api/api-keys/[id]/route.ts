import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { revokeApiKey } from "@/lib/api-keys";
import { apiError, apiErrorResponse } from "@/lib/api-errors";

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
