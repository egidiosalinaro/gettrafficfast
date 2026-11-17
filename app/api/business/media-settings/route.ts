import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { videoEnrichmentAvailable } from "@/lib/media/availability";
import { MediaSettings, parseMediaSettings } from "@/lib/media/settings";
import { saveMediaSettings } from "@/lib/business/save-settings";
import { selectedBusinessId } from "@/lib/tenancy";

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const businessId = await selectedBusinessId(supabase, user.id);
  const { data: business } = businessId
    ? await supabase
        .from("businesses")
        .select("id, media_settings")
        .eq("id", businessId)
        .eq("user_id", user.id)
        .maybeSingle()
    : { data: null };

  return NextResponse.json({
    hasBusiness: Boolean(business),
    settings: parseMediaSettings(business?.media_settings),
    // Whether the platform can look for videos at all. The form does not
    // offer a switch that would do nothing.
    videoAvailable: videoEnrichmentAvailable(),
  });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  // Strict here, unlike the tolerant read path: this is our own form, so an
  // invalid value is a bug to surface, not something to paper over.
  const parsed = MediaSettings.safeParse(body);
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

  // A site the user has, or "set up your business first": the function the
  // update_media_settings tool calls (lib/business/save-settings.ts).
  const businessId = await selectedBusinessId(supabase, user.id);
  const saved = await saveMediaSettings({ supabase, userId: user.id, businessId, settings: parsed.data });
  if (!saved.ok) {
    return NextResponse.json({ error: saved.error }, { status: saved.status });
  }

  return NextResponse.json({ success: true, settings: saved.settings });
}
