import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { VoiceSettings, VoiceSettingsChange } from "@/lib/voice/settings";
import { saveVoiceSettings, updateVoiceSettings } from "@/lib/business/save-settings";
import { loadVoiceSettings } from "@/lib/voice/read";
import { selectedBusinessId } from "@/lib/tenancy";

/**
 * Tone of voice for the selected business (Settings → Voice). The same
 * shape as media-settings: tolerant on read, strict on write, and the row
 * is always picked from what the signed-in user owns.
 */

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const businessId = await selectedBusinessId(supabase, user.id);
  // The same read as `get_voice_settings` (lib/voice/read.ts).
  return NextResponse.json(await loadVoiceSettings(supabase, user.id, businessId));
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
  const parsed = VoiceSettings.safeParse(body);
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
  // update_voice_settings tool calls (lib/business/save-settings.ts).
  const businessId = await selectedBusinessId(supabase, user.id);
  const saved = await saveVoiceSettings({ supabase, userId: user.id, businessId, settings: parsed.data });
  if (!saved.ok) {
    return NextResponse.json({ error: saved.error }, { status: saved.status });
  }

  return NextResponse.json({ success: true, settings: saved.settings });
}

/**
 * PATCH: only the fields sent change, the rest stay as stored. POST takes
 * the whole object (a missing field is its default), which is right for the
 * Settings form and wrong for the Replies page's daily goal: sending
 * `{ dailyReplyGoal: 6 }` there would reset About you. The same merge as
 * `update_voice_settings` (lib/business/save-settings.ts).
 */
export async function PATCH(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = VoiceSettingsChange.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => `${i.path.join(".") || "settings"}: ${i.message}`).join("; ") },
      { status: 400 }
    );
  }

  const businessId = await selectedBusinessId(supabase, user.id);
  const saved = await updateVoiceSettings({ supabase, userId: user.id, businessId, changes: parsed.data });
  if (!saved.ok) {
    return NextResponse.json({ error: saved.error }, { status: saved.status });
  }
  return NextResponse.json({ success: true, settings: saved.settings });
}
