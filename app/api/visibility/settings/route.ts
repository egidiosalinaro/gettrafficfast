import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { NO_BUSINESS_RESPONSE, selectedBusinessId } from "@/lib/tenancy";
import { saveAeoSettings } from "@/lib/visibility/manage";
import { loadVisibilitySettings } from "@/lib/visibility/read";
import { AeoSettings } from "@/lib/visibility/settings";

/**
 * Per-business AI Visibility configuration: what counts as "us", which engines
 * to ask, how often. The engines the platform has keys for ride along so the
 * form can only offer what exists.
 */

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const businessId = await selectedBusinessId(supabase, user.id);
  if (!businessId) return NextResponse.json(NO_BUSINESS_RESPONSE, { status: 409 });

  // The same read as `get_visibility_settings` (lib/visibility/read.ts).
  const view = await loadVisibilitySettings(supabase, user.id, businessId);
  if (!view) return NextResponse.json(NO_BUSINESS_RESPONSE, { status: 409 });

  return NextResponse.json(view);
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Strict on write: this is our own form, so an invalid value is a bug worth
  // surfacing rather than something to paper over.
  const parsed = AeoSettings.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: parsed.error.issues
          .map((i) => `${i.path.join(".") || "settings"}: ${i.message}`)
          .join("; "),
      },
      { status: 400 }
    );
  }

  const businessId = await selectedBusinessId(supabase, user.id);
  if (!businessId) return NextResponse.json(NO_BUSINESS_RESPONSE, { status: 409 });

  // The same function the update_visibility_settings tool calls
  // (lib/visibility/manage.ts).
  const saved = await saveAeoSettings({ supabase, userId: user.id, businessId, settings: parsed.data });
  if (!saved.ok) return NextResponse.json({ error: saved.error }, { status: saved.status });

  return NextResponse.json({ settings: saved.settings });
}
