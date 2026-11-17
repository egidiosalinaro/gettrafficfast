import { describe, expect, it } from "vitest";
import { FakeSupabase } from "../support/fake-supabase";
import { loadVoiceSettings } from "@/lib/voice/read";

/**
 * Settings → Voice as the form and `get_voice_settings` read it. Pinned:
 * the stale facts ride along with the settings, derived on read from About
 * you and the day, and the stored text is answered untouched.
 */

const OWNER_ABOUT =
  "Former agency designer, learned to code at night. Co-founded Postwren, email marketing for Shopify stores: 12 paying stores in October 2026. Since late September an AI pipeline writes and publishes my own blog: 9 impressions a week at the start, 342 in the week of Oct 26, still 0 clicks, articles sit around position 30-40. Left Porto on Oct 27 2026, working from Taipei.";

const db = (aboutYou: string) =>
  new FakeSupabase({
    businesses: [{ id: "biz-1", user_id: "user-1", voice_settings: { preset: "warm", aboutYou } }],
  });

describe("loadVoiceSettings", () => {
  it("answers the stale facts beside the settings, and the text as stored", async () => {
    const voice = await loadVoiceSettings(db(OWNER_ABOUT) as never, "user-1", "biz-1", new Date("2026-11-10T09:30:00Z"));
    expect(voice.hasBusiness).toBe(true);
    expect(voice.settings.aboutYou).toBe(OWNER_ABOUT);
    expect(voice.staleAfterDays).toBe(30);
    expect(voice.staleFacts).toEqual([
      {
        sentence: "Co-founded Postwren, email marketing for Shopify stores: 12 paying stores in October 2026.",
        date: "2026-10-01",
        dateLabel: "October 2026",
        precision: "month",
        yearAssumed: false,
        confirmedOn: null,
        ageDays: 40,
        age: "last month",
        line: "Dated October 2026 (last month): still true?",
      },
    ]);
  });

  it("answers none when nothing is dated, nothing is old, or there is no site", async () => {
    const now = new Date("2026-11-10T09:30:00Z");
    expect((await loadVoiceSettings(db("We build Acme.") as never, "user-1", "biz-1", now)).staleFacts).toEqual([]);
    expect((await loadVoiceSettings(db("40 signups on Nov 3 2026.") as never, "user-1", "biz-1", now)).staleFacts).toEqual([]);
    expect(await loadVoiceSettings(db(OWNER_ABOUT) as never, "user-1", null, now)).toMatchObject({ hasBusiness: false, staleFacts: [] });
    // Another account's site reads as none, stale facts included.
    expect(await loadVoiceSettings(db(OWNER_ABOUT) as never, "user-2", "biz-1", now)).toMatchObject({ hasBusiness: false, staleFacts: [] });
  });
});
