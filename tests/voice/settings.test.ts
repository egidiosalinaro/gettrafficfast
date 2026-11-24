import { describe, expect, it } from "vitest";
import {
  CONFIRMED_FACTS_MAX,
  DEFAULT_VOICE_SETTINGS,
  VOICE_PERSONS,
  VOICE_PRESETS,
  VoiceSettings,
  VoiceSettingsChange,
  describeVoice,
  normalizeXHandle,
  noteRules,
  notesAsRules,
  parseVoiceSettings,
  voiceForWriter,
  withLiveConfirmations,
  xHandleProblem,
} from "@/lib/voice/settings";

/**
 * The voice is settings the draft agent reads as prompt lines. What is
 * asserted: an old or broken row never breaks drafting, and the empty
 * "about you" is spelled out as "claim nothing", not left to the model.
 */

describe("parseVoiceSettings", () => {
  it("defaults to a plain voice that claims nothing about the writer", () => {
    expect(parseVoiceSettings(null)).toEqual(DEFAULT_VOICE_SETTINGS);
    expect(parseVoiceSettings({})).toEqual(DEFAULT_VOICE_SETTINGS);
    expect(DEFAULT_VOICE_SETTINGS).toEqual({ preset: "plain", person: "auto", aboutYou: "", articleFacts: "", instructions: "", dailyReplyGoal: null, xHandle: null, confirmedFacts: {} });
  });

  it("keeps a stored voice and falls back whole when a value is not one we know", () => {
    expect(parseVoiceSettings({ preset: "technical", person: "we", aboutYou: "I built it." })).toEqual({
      preset: "technical",
      person: "we",
      aboutYou: "I built it.",
      articleFacts: "",
      instructions: "",
      dailyReplyGoal: null,
      xHandle: null,
      confirmedFacts: {},
    });
    expect(parseVoiceSettings({ preset: "shouty" })).toEqual(DEFAULT_VOICE_SETTINGS);
    expect(parseVoiceSettings("garbage")).toEqual(DEFAULT_VOICE_SETTINGS);
  });

  it("refuses an over-long note on the strict write path", () => {
    // About you holds 2,000 characters since 12 November 2026 (it held 400).
    expect(VoiceSettings.safeParse({ aboutYou: "x".repeat(2_000) }).success).toBe(true);
    expect(VoiceSettings.safeParse({ aboutYou: "x".repeat(2_001) }).success).toBe(false);
    expect(VoiceSettings.safeParse({ instructions: "x".repeat(601) }).success).toBe(false);
    // Facts for articles has the same room as About you (12 November 2026).
    expect(VoiceSettings.safeParse({ articleFacts: "x".repeat(2_000) }).success).toBe(true);
    expect(VoiceSettings.safeParse({ articleFacts: "x".repeat(2_001) }).success).toBe(false);
  });

  it("keeps Facts for articles apart from About you, and an old row without it reads as empty", () => {
    expect(parseVoiceSettings({ aboutYou: "9 impressions a week.", articleFacts: "I build GetTrafficFast." })).toMatchObject({
      aboutYou: "9 impressions a week.",
      articleFacts: "I build GetTrafficFast.",
    });
    expect(parseVoiceSettings({ aboutYou: "9 impressions a week." }).articleFacts).toBe("");
  });
});

describe("the site's X account (xHandle, 2026-11-24)", () => {
  it("is stored lowercased without the @, and only as X allows: 1 to 15 letters, digits or underscores", () => {
    expect(VoiceSettings.parse({ xHandle: "@SamRivDev" }).xHandle).toBe("samrivdev");
    expect(VoiceSettings.parse({ xHandle: "  sam_riv_2 " }).xHandle).toBe("sam_riv_2");
    expect(VoiceSettings.parse({ xHandle: null }).xHandle).toBeNull();
    for (const bad of ["", "@", "sam riv", "sam-riv", "a".repeat(16), "https://x.com/samriv", "sam.riv"]) {
      expect(VoiceSettings.safeParse({ xHandle: bad }).success, bad).toBe(false);
    }
    expect(normalizeXHandle(" @Postwren ")).toBe("postwren");
    expect(xHandleProblem("@postwren")).toBeNull();
    expect(xHandleProblem("")).toMatch(/Type your X username/);
    expect(xHandleProblem("post wren")).toMatch(/1 to 15 letters/);
  });

  it("is written alone by a partial change, and an old row reads as none", () => {
    expect(VoiceSettingsChange.parse({ xHandle: "@Postwren" })).toEqual({ xHandle: "postwren" });
    expect(VoiceSettingsChange.parse({ xHandle: null })).toEqual({ xHandle: null });
    expect(VoiceSettingsChange.safeParse({ xHandle: "not a handle" }).success).toBe(false);
    expect(parseVoiceSettings({ aboutYou: "I run it." }).xHandle).toBeNull();
  });

  it("ignores the removed Find posts on X switch: a stored value is dropped, and an old page's PATCH saves nothing of it", () => {
    expect(parseVoiceSettings({ aboutYou: "I run it.", findPostsOnX: false })).toEqual(parseVoiceSettings({ aboutYou: "I run it." }));
    expect("findPostsOnX" in parseVoiceSettings({ findPostsOnX: true })).toBe(false);
    expect(VoiceSettingsChange.parse({ findPostsOnX: true })).toEqual({});
    expect(VoiceSettingsChange.parse({ findPostsOnX: false, dailyReplyGoal: 4 })).toEqual({ dailyReplyGoal: 4 });
    expect(VoiceSettingsChange.safeParse({ somethingElse: 1 }).success).toBe(false);
  });
});

describe("confirmedFacts (Still true, 2026-11-14)", () => {
  const ABOUT = "I run GetTrafficFast. Co-founded Postwren: 12 paying stores in October 2026.";
  const CONFIRMED = { "co-founded postwren: 12 paying stores in october 2026": "2026-11-14" };

  it("reads as none on an old row, holds days only, and is bounded", () => {
    expect(parseVoiceSettings({ aboutYou: ABOUT }).confirmedFacts).toEqual({});
    expect(VoiceSettings.safeParse({ aboutYou: ABOUT, confirmedFacts: CONFIRMED }).success).toBe(true);
    expect(VoiceSettings.safeParse({ confirmedFacts: { a: "November 14, 2026" } }).success).toBe(false);
    const many = Object.fromEntries(Array.from({ length: CONFIRMED_FACTS_MAX + 1 }, (_, i) => [`fact ${i}`, "2026-11-14"]));
    expect(VoiceSettings.safeParse({ confirmedFacts: many }).success).toBe(false);
    // A partial change leaves it as stored when it is not sent.
    expect(VoiceSettingsChange.parse({ aboutYou: ABOUT })).toEqual({ aboutYou: ABOUT });
  });

  it("never reaches the drafter: the voice it is handed, and the lines it reads, are the same with or without it", () => {
    const without = parseVoiceSettings({ aboutYou: ABOUT, instructions: "Lowercase." });
    const withIt = parseVoiceSettings({ aboutYou: ABOUT, instructions: "Lowercase.", confirmedFacts: CONFIRMED });
    expect(voiceForWriter(withIt)).toEqual(without);
    expect(describeVoice(withIt)).toEqual(describeVoice(without));
    expect(notesAsRules(withIt)).toEqual(notesAsRules(without));
    expect(describeVoice(withIt).join("\n")).not.toMatch(/2026-11-14|confirm|still true/i);
    // About you itself is the person's words, untouched.
    expect(withIt.aboutYou).toBe(ABOUT);
  });

  it("keeps only the confirmations of facts About you still has", () => {
    const settings = parseVoiceSettings({ aboutYou: ABOUT, confirmedFacts: { ...CONFIRMED, "a fact since deleted": "2026-11-01" } });
    expect(withLiveConfirmations(settings).confirmedFacts).toEqual(CONFIRMED);
    expect(withLiveConfirmations({ ...settings, aboutYou: "I run GetTrafficFast." }).confirmedFacts).toEqual({});
  });
});

describe("describeVoice", () => {
  it("is what replies read: About you, as before, and never Facts for articles", () => {
    const lines = describeVoice({
      ...DEFAULT_VOICE_SETTINGS,
      aboutYou: "9 impressions a week at the start, still 0 clicks.",
      articleFacts: "Only for the blog.",
    }).join("\n");
    expect(lines).toContain("9 impressions a week at the start, still 0 clicks.");
    expect(lines).not.toContain("Only for the blog.");
  });

  it("names the preset and the person, and tells the model to claim no experience when none is given", () => {
    const lines = describeVoice(DEFAULT_VOICE_SETTINGS).join("\n");
    expect(lines).toContain("Plain: direct and specific");
    expect(lines).toContain('Use "I", "we" or no first person');
    expect(lines).toMatch(/claims none/);
    expect(lines).toContain("I've been using");
    expect(lines).not.toContain("own notes");
  });

  it("passes what is true about the writer through, and the business's notes, verbatim", () => {
    const lines = describeVoice({
      preset: "casual",
      person: "i",
      aboutYou: "I built the tool and run it on my own blog.",
      articleFacts: "",
      instructions: "Never call it an AI agent.",
      dailyReplyGoal: null,
      xHandle: null,
      confirmedFacts: {},
    }).join("\n");
    expect(lines).toContain("Casual:");
    expect(lines).toContain('Write as "I"');
    expect(lines).toContain("I built the tool and run it on my own blog.");
    expect(lines).toContain("the only personal experience the reply may claim");
    expect(lines).toContain("Never call it an AI agent.");
    expect(lines).not.toMatch(/claims none/);
  });

  it("has a prompt line for every preset and every person the form offers", () => {
    for (const preset of VOICE_PRESETS) {
      for (const person of VOICE_PERSONS) {
        const lines = describeVoice({ ...DEFAULT_VOICE_SETTINGS, preset: preset.value, person: person.value });
        expect(lines[0]).toContain(preset.label);
        expect(lines[1].length).toBeGreaterThan(10);
      }
    }
  });
});

/** The owner's notes as stored on 9 November 2026. */
const OWNER_NOTES =
  "Lowercase, short lines, like a reply typed on a phone. One idea per reply. Lead with a number or a concrete thing I did. Never name a product, never a link. No em dashes, no hashtags, no 'great post', no lists. Disagree when I disagree. Ask one precise question when I have nothing to add.";

describe("the writer's notes as rules", () => {
  it("reads lowercase from the notes, and not a note that refuses it", () => {
    expect(noteRules(OWNER_NOTES)).toEqual({ lowercase: true });
    expect(noteRules("write in lower case, always").lowercase).toBe(true);
    expect(noteRules("all lower-case please").lowercase).toBe(true);
    expect(noteRules("Never write in lowercase.").lowercase).toBe(false);
    expect(noteRules("no lowercase, proper sentences").lowercase).toBe(false);
    expect(noteRules("Short lines. No hashtags.").lowercase).toBe(false);
    expect(noteRules("").lowercase).toBe(false);
    expect(noteRules(undefined).lowercase).toBe(false);
  });

  it("states the notes as hard rules, verbatim, with the lowercase line only when they ask for it", () => {
    expect(notesAsRules(DEFAULT_VOICE_SETTINGS)).toBeNull();
    const rules = notesAsRules({ ...DEFAULT_VOICE_SETTINGS, instructions: OWNER_NOTES }) ?? "";
    expect(rules).toContain("These are hard rules, not background");
    expect(rules).toContain("the note wins");
    expect(rules).toContain("Only the rules on inventing nothing, using a fact only where it fits the post, naming no product and carrying no link stand above them.");
    expect(rules).toContain("start every sentence with a lowercase letter");
    expect(rules).toContain(OWNER_NOTES);
    const other = notesAsRules({ ...DEFAULT_VOICE_SETTINGS, instructions: "Never call it an AI agent." }) ?? "";
    expect(other).toContain("Never call it an AI agent.");
    expect(other).not.toContain("lowercase");
  });

  it("leaves the notes out of the voice lines when the prompt carries them elsewhere, and points back at them", () => {
    const settings = { ...DEFAULT_VOICE_SETTINGS, aboutYou: "Self-taught dev.", instructions: OWNER_NOTES };
    const inline = describeVoice(settings).join("\n");
    expect(inline).toContain(OWNER_NOTES);
    expect(inline).toContain("hard rules that win over the preset");
    const elsewhere = describeVoice(settings, { notes: "elsewhere" }).join("\n");
    expect(elsewhere).not.toContain(OWNER_NOTES);
    expect(elsewhere).toContain("Your own notes, at the top, are hard rules");
    expect(describeVoice(DEFAULT_VOICE_SETTINGS, { notes: "elsewhere" }).join("\n")).not.toContain("own notes");
  });
});
