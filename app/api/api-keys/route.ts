import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { API_KEY_NAME_MAX, API_KEY_SCOPES, createApiKey, listApiKeys } from "@/lib/api-keys";
import { apiError, apiErrorResponse, HINTS, type ApiErrorCode } from "@/lib/api-errors";
import { listBusinesses } from "@/lib/tenancy";

/**
 * Settings → API keys. Creating and listing keys takes the session cookie,
 * and only it: a key never mints or lists keys, so a leaked key cannot make
 * itself permanent. Everything goes through the person's own client (RLS).
 * Errors use the API's shape, `{ error: { code, message, hint? } }`.
 *
 * POST returns the raw key once, in `key`. It is not stored and cannot be
 * shown again.
 */

const CreateInput = z.object({
  name: z.string().trim().min(1, "Give the key a name.").max(API_KEY_NAME_MAX),
  businessId: z.string().uuid().nullable().optional(),
  scopes: z.array(z.enum(API_KEY_SCOPES)).min(1).max(API_KEY_SCOPES.length).optional(),
});

async function sessionUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return { supabase, user };
}

const signedOut = () => apiErrorResponse(401, apiError("unauthorized", "Sign in to manage API keys."));

export async function GET() {
  const { supabase, user } = await sessionUser();
  if (!user) return signedOut();
  try {
    const [apiKeys, businesses] = await Promise.all([listApiKeys(supabase, user.id), listBusinesses(supabase, user.id)]);
    return NextResponse.json({ apiKeys, businesses });
  } catch (err) {
    return apiErrorResponse(500, apiError("internal", err instanceof Error ? err.message : String(err)));
  }
}

export async function POST(request: NextRequest) {
  const { supabase, user } = await sessionUser();
  if (!user) return signedOut();

  const parsed = CreateInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return apiErrorResponse(
      400,
      apiError("invalid_input", issue ? `${issue.path.join(".") || "input"}: ${issue.message}` : "Invalid input")
    );
  }

  const created = await createApiKey(supabase, {
    userId: user.id,
    name: parsed.data.name,
    businessId: parsed.data.businessId ?? null,
    scopes: parsed.data.scopes ?? null,
  });
  if (!created.ok) {
    return apiErrorResponse(
      created.status,
      apiError(created.code as ApiErrorCode, created.error, created.code === "cap_reached" ? HINTS.keys : undefined)
    );
  }
  return NextResponse.json({ key: created.key, apiKey: created.apiKey }, { status: 201 });
}
