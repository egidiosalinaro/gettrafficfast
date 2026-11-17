import type { SupabaseClient } from "@supabase/supabase-js";
import { parseVoiceSettings, type VoiceSettings } from "./settings";
import { STALE_AFTER_DAYS, staleFacts, type StaleFact } from "./staleness";

/**
 * Settings → Voice as the form reads it (GET /api/business/voice-settings)
 * and `get_voice_settings` answers it: the site's tone, person, About you
 * and notes. Tolerant on read: a malformed column reads as the defaults.
 * The row is read by id AND owner, so another account's site reads as none.
 *
 * `staleFacts` is derived on read, never stored: the sentences of About you
 * whose date is more than `staleAfterDays` old as of `now`
 * (lib/voice/staleness.ts). Empty when nothing is dated, or nothing is old.
 */
export async function loadVoiceSettings(
  supabase: SupabaseClient,
  userId: string,
  businessId: string | null,
  now: Date = new Date()
): Promise<{ hasBusiness: boolean; settings: VoiceSettings; staleFacts: StaleFact[]; staleAfterDays: number }> {
  const { data: business } = businessId
    ? await supabase
        .from("businesses")
        .select("id, voice_settings")
        .eq("id", businessId)
        .eq("user_id", userId)
        .maybeSingle()
    : { data: null };

  const settings = parseVoiceSettings(business?.voice_settings);
  return {
    hasBusiness: Boolean(business),
    settings,
    staleFacts: staleFacts(settings.aboutYou, now, { confirmations: settings.confirmedFacts }),
    staleAfterDays: STALE_AFTER_DAYS,
  };
}
