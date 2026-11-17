import type { SupabaseClient } from "@supabase/supabase-js";
import { parseAutomationSettings, type AutomationSettings } from "@/lib/automation/settings";
import { parseMediaSettings, type MediaSettings } from "@/lib/media/settings";
import { parseAeoSettings, type AeoSettings } from "@/lib/visibility/settings";
import { VoiceSettings as VoiceSettingsSchema, parseVoiceSettings, withLiveConfirmations, type VoiceSettings } from "@/lib/voice/settings";

/**
 * A site's settings columns, read and written for the settings routes
 * (`/api/business/{automation,media,voice}-settings`) and the settings tools
 * (lib/tools/write-business.ts, write-voice.ts). The values arrive already
 * validated by the strict schemas; every write names the site and the user.
 */

type Failure = { ok: false; status: 400 | 404 | 500; error: string };

/** What a settings form says when the site is not set up. */
export const SET_UP_BUSINESS_FIRST = "Set up your business first (Settings → Business).";

/** Autopilot. No `updated_at`, as the route has always written it. */
export async function saveAutomationSettings(input: {
  supabase: SupabaseClient;
  userId: string;
  businessId: string;
  settings: AutomationSettings;
}): Promise<{ ok: true; settings: AutomationSettings } | Failure> {
  const { error } = await input.supabase
    .from("businesses")
    .update({ automation_settings: input.settings })
    .eq("id", input.businessId)
    .eq("user_id", input.userId);
  if (error) return { ok: false, status: 500, error: error.message };
  return { ok: true, settings: input.settings };
}

/** Writes one jsonb settings column of a site the user has, or says to set it up first. */
async function saveColumn<T>(
  input: { supabase: SupabaseClient; userId: string; businessId: string | null; now?: Date },
  column: "media_settings" | "voice_settings",
  settings: T
): Promise<{ ok: true; settings: T } | Failure> {
  const { supabase, userId, businessId } = input;
  const { data: business } = businessId
    ? await supabase.from("businesses").select("id").eq("id", businessId).eq("user_id", userId).maybeSingle()
    : { data: null };
  if (!business) return { ok: false, status: 400, error: SET_UP_BUSINESS_FIRST };

  const { error } = await supabase
    .from("businesses")
    .update({ [column]: settings, updated_at: (input.now ?? new Date()).toISOString() })
    .eq("id", business.id as string)
    .eq("user_id", userId);
  if (error) return { ok: false, status: 500, error: error.message };
  return { ok: true, settings };
}

export function saveMediaSettings(input: {
  supabase: SupabaseClient;
  userId: string;
  businessId: string | null;
  settings: MediaSettings;
  now?: Date;
}): Promise<{ ok: true; settings: MediaSettings } | Failure> {
  return saveColumn(input, "media_settings", input.settings);
}

/**
 * The voice, with the "Still true" confirmations of facts About you no
 * longer has dropped (`withLiveConfirmations`): a sentence edited or removed
 * in Settings takes its confirmation with it.
 */
export function saveVoiceSettings(input: {
  supabase: SupabaseClient;
  userId: string;
  businessId: string | null;
  settings: VoiceSettings;
  now?: Date;
}): Promise<{ ok: true; settings: VoiceSettings } | Failure> {
  return saveColumn(input, "voice_settings", withLiveConfirmations(input.settings));
}

/**
 * The site's stored settings, through the tolerant readers (a malformed
 * column reads as the defaults, which are "off"). What a tool merges a
 * partial change onto. Null when the site is not the user's.
 */
export async function loadSiteSettings(
  supabase: SupabaseClient,
  userId: string,
  businessId: string
): Promise<{
  automation: AutomationSettings;
  media: MediaSettings;
  voice: VoiceSettings;
  aeo: AeoSettings;
  /** The columns as stored, for a caller that must not mistake an unreadable value for the defaults. */
  raw: Record<string, unknown>;
} | null> {
  const { data } = await supabase
    .from("businesses")
    .select("id, automation_settings, media_settings, voice_settings, aeo_settings")
    .eq("id", businessId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) return null;
  return {
    automation: parseAutomationSettings(data.automation_settings),
    media: parseMediaSettings(data.media_settings),
    voice: parseVoiceSettings(data.voice_settings),
    aeo: parseAeoSettings(data.aeo_settings),
    raw: data as Record<string, unknown>,
  };
}

/** The four fields that are the voice: what replacing an unreadable value needs. */
export const VOICE_FIELDS = ["preset", "person", "aboutYou", "instructions"] as const;

/** What `updateVoiceSettings` says when a partial change would replace an unreadable value. */
export const VOICE_UNREADABLE =
  "This site's voice settings could not be read, and a partial change would replace them with the defaults.";

/**
 * A partial change of the voice: the fields given, merged onto what is
 * stored, the rest kept as they are. What `update_voice_settings` and the
 * Replies page's daily goal (PATCH /api/business/voice-settings) both call,
 * so changing the goal never resets About you or the notes.
 *
 * The tolerant reader turns an unreadable value into the defaults, and
 * merging onto those would erase the owner's notes: a change that does not
 * set every voice field is refused (409) over a value that cannot be read.
 */
export async function updateVoiceSettings(input: {
  supabase: SupabaseClient;
  userId: string;
  businessId: string | null;
  changes: Partial<VoiceSettings>;
  now?: Date;
}): Promise<{ ok: true; settings: VoiceSettings } | Failure | { ok: false; status: 409; error: string }> {
  if (!input.businessId) return { ok: false, status: 400, error: SET_UP_BUSINESS_FIRST };
  const stored = await loadSiteSettings(input.supabase, input.userId, input.businessId);
  if (!stored) return { ok: false, status: 404, error: "This site is no longer on the account." };
  const changes = Object.fromEntries(Object.entries(input.changes).filter(([, value]) => value !== undefined));
  const readable = VoiceSettingsSchema.safeParse(stored.raw.voice_settings ?? {}).success;
  if (!readable && VOICE_FIELDS.some((field) => !(field in changes))) {
    return { ok: false, status: 409, error: VOICE_UNREADABLE };
  }
  const parsed = VoiceSettingsSchema.safeParse({ ...stored.voice, ...changes });
  if (!parsed.success) {
    return {
      ok: false,
      status: 400,
      error: parsed.error.issues.map((i) => `${i.path.join(".") || "settings"}: ${i.message}`).join("; "),
    };
  }
  return saveVoiceSettings({ ...input, businessId: input.businessId, settings: parsed.data });
}
