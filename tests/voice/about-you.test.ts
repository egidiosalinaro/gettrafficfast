import { describe, expect, it } from "vitest";
import {
  ABOUT_YOU_FACT_MAX,
  ABOUT_YOU_FULL,
  appendFact,
  confirmFact,
  factDateLabel,
  factFromSentence,
  removeFact,
  unconfirmFact,
} from "@/lib/voice/about-you";
import { ABOUT_YOU_MAX, VoiceSettings, withLiveConfirmations } from "@/lib/voice/settings";
import { aboutYouFacts, factKey, liveConfirmations, staleFacts } from "@/lib/voice/staleness";

/**
 * "It's true: add to About you" (docs/VOICE.md, 2026-11-12), the pure half.
 * Pinned: the owner's sentence becomes a dated fact by a fixed transform;
 * the add keeps the existing text byte for byte and goes at the end; the
 * date is one the staleness rule reads; the undo takes out exactly what was
 * added; a fact that would not fit is refused with the sentence.
 */

const NOW = new Date("2026-11-12T10:00:00Z");
const OWNER_SENTENCE = "during the last week i'm going 100% on marketing for both my startups too.";
const OWNER_FACT = "As of November 12, 2026: during the last week I'm going 100% on marketing for both my startups.";

describe("factFromSentence", () => {
  it("turns the owner's sentence into a dated first-person fact", () => {
    expect(factFromSentence(OWNER_SENTENCE, NOW)).toBe(OWNER_FACT);
  });

  it("strips the talk at either end, and keeps the rest as written", () => {
    expect(factFromSentence("honestly, but i run two startups as well!!", NOW)).toBe("As of November 12, 2026: I run two startups.");
    expect(factFromSentence("tbh I've shipped 40 articles lol", NOW)).toBe("As of November 12, 2026: I've shipped 40 articles.");
    // "it" and "is" are not the pronoun.
    expect(factFromSentence("it is what i do", NOW)).toBe("As of November 12, 2026: it is what I do.");
  });

  it("dates by the UTC day", () => {
    expect(factDateLabel(new Date("2026-01-03T23:59:00Z"))).toBe("January 3, 2026");
  });
});

describe("appendFact", () => {
  it("appends after the existing text, which it keeps byte for byte", () => {
    const about = "Self-taught dev.  I build GetTrafficFast.";
    const added = appendFact(about, OWNER_FACT);
    expect(added).toEqual({ ok: true, aboutYou: `${about} ${OWNER_FACT}`, fact: OWNER_FACT, appended: true });
    if (!added.ok) return;
    expect(added.aboutYou.startsWith(about)).toBe(true);
  });

  it("puts a line break after text that does not end a sentence, and nothing before an empty About you", () => {
    expect(appendFact("Dev in Taipei", "I run two startups")).toMatchObject({ aboutYou: "Dev in Taipei\nI run two startups." });
    expect(appendFact("", OWNER_FACT)).toMatchObject({ aboutYou: OWNER_FACT });
    expect(appendFact("Dev.\n", OWNER_FACT)).toMatchObject({ aboutYou: `Dev.\n${OWNER_FACT}` });
  });

  it("adds nothing when the fact is already there", () => {
    const about = `Dev. ${OWNER_FACT}`;
    expect(appendFact(about, OWNER_FACT.toLowerCase())).toEqual({ ok: true, aboutYou: about, fact: OWNER_FACT.toLowerCase(), appended: false });
  });

  it("refuses when About you would be full, and leaves it as it is", () => {
    const about = "x".repeat(ABOUT_YOU_MAX - 20) + ".";
    const refused = appendFact(about, OWNER_FACT);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.startsWith(ABOUT_YOU_FULL)).toBe(true);
    expect(refused.error).toBe("About you is full; edit it in Settings → Voice. With this fact it would be 2,077 characters, and it holds 2,000.");
  });

  it("refuses an empty fact and one over the limit", () => {
    expect(appendFact("Dev.", "   ")).toMatchObject({ ok: false });
    expect(appendFact("Dev.", "y".repeat(ABOUT_YOU_FACT_MAX + 1))).toMatchObject({ ok: false });
  });
});

describe("the dated fact and the staleness rule", () => {
  const about = `I build GetTrafficFast. ${OWNER_FACT}`;

  it("is read as dated November 12, 2026, and is fresh today", () => {
    const fact = aboutYouFacts(about, NOW).find((f) => f.sentence === OWNER_FACT);
    expect(fact?.date).toMatchObject({ iso: "2026-11-12", precision: "day" });
    expect(staleFacts(about, NOW)).toEqual([]);
  });

  it("is asked about once it is more than 30 days old", () => {
    const later = new Date("2026-12-20T10:00:00Z");
    expect(staleFacts(about, later)).toEqual([
      expect.objectContaining({ sentence: OWNER_FACT, date: "2026-11-12", line: "Dated Nov 12, 2026 (38 days ago): still true?" }),
    ]);
  });
});

describe("removeFact, the undo", () => {
  it.each(["Self-taught dev.  I build GetTrafficFast.", "Dev in Taipei", "", "Dev.\n"])("gives back exactly what was there before (%j)", (about) => {
    const added = appendFact(about, OWNER_FACT);
    if (!added.ok) throw new Error(added.error);
    expect(removeFact(added.aboutYou, added.fact)).toEqual({ aboutYou: about, removed: true });
  });

  it("removes a whole sentence only, and nothing when it is not there", () => {
    expect(removeFact("I run Acme. Inc.", "I run Acme")).toEqual({ aboutYou: "Inc.", removed: true });
    expect(removeFact("Say I run Acme.", "run Acme.")).toEqual({ aboutYou: "Say I run Acme.", removed: false });
    expect(removeFact("I run Acmeco.", "I run Acme.")).toEqual({ aboutYou: "I run Acmeco.", removed: false });
    expect(removeFact("Dev.", OWNER_FACT)).toEqual({ aboutYou: "Dev.", removed: false });
  });
});

describe("Still true (Today, 2026-11-14)", () => {
  const TODAY = new Date("2026-11-14T10:00:00Z");
  const STALE = "Co-founded Postwren: 12 paying stores in October 2026.";
  const ABOUT = `I run GetTrafficFast. ${STALE}\nI think a small menu beats a big one.`;

  const KEY = "co-founded postwren: 12 paying stores in october 2026";

  it("records the day apart from the text, keyed by the sentence's words, and never touches About you", () => {
    expect(factKey(STALE)).toBe(KEY);
    expect(confirmFact(ABOUT, {}, STALE, TODAY)).toEqual({
      ok: true,
      confirmedFacts: { [KEY]: "2026-11-14" },
      sentence: STALE,
      confirmedOn: "2026-11-14",
      previousConfirmedOn: null,
      changed: true,
    });
    // The confirmation has no About you to return: the words are the person's, as written.
    expect(ABOUT).toBe(`I run GetTrafficFast. ${STALE}\nI think a small menu beats a big one.`);
    // Spacing, case and the full stop are the same fact.
    expect(confirmFact(ABOUT, {}, "co-founded  Postwren: 12 paying stores in October 2026", TODAY)).toMatchObject({ ok: true, sentence: STALE });
  });

  it("stops the staleness question for 30 days, from the day it was confirmed", () => {
    expect(staleFacts(ABOUT, TODAY).map((f) => f.sentence)).toEqual([STALE]);
    const confirmed = confirmFact(ABOUT, {}, STALE, TODAY);
    if (!confirmed.ok) throw new Error(confirmed.error);
    const confirmations = confirmed.confirmedFacts;
    expect(staleFacts(ABOUT, TODAY, { confirmations })).toEqual([]);
    expect(staleFacts(ABOUT, new Date("2026-12-14T10:00:00Z"), { confirmations })).toEqual([]);
    const again = staleFacts(ABOUT, new Date("2026-12-15T10:00:00Z"), { confirmations });
    expect(again).toMatchObject([
      {
        sentence: STALE,
        // What a draft states it as of stays the sentence's own date.
        dateLabel: "October 2026",
        confirmedOn: "2026-11-14",
        ageDays: 31,
        age: "31 days ago",
        line: "Dated October 2026, confirmed Nov 14, 2026 (31 days ago): still true?",
      },
    ]);
  });

  it("moves the day when confirmed again, and changes nothing on the same day", () => {
    const first = confirmFact(ABOUT, {}, STALE, TODAY);
    if (!first.ok) throw new Error(first.error);
    const again = confirmFact(ABOUT, first.confirmedFacts, STALE, new Date("2026-12-20T10:00:00Z"));
    expect(again).toMatchObject({ ok: true, confirmedFacts: { [KEY]: "2026-12-20" }, previousConfirmedOn: "2026-11-14", changed: true });
    expect(confirmFact(ABOUT, first.confirmedFacts, STALE, TODAY)).toMatchObject({ ok: true, changed: false, confirmedFacts: first.confirmedFacts });
  });

  it("refuses a sentence that is not one of About you's, and one with no date", () => {
    expect(confirmFact(ABOUT, {}, "12 paying stores in October 2026.", TODAY)).toMatchObject({ ok: false });
    expect(confirmFact(ABOUT, {}, "Something never written.", TODAY)).toEqual({
      ok: false,
      error: "This fact is no longer in About you as it was. Edit it in Settings → Voice.",
    });
    expect(confirmFact(ABOUT, {}, "I run GetTrafficFast.", TODAY)).toMatchObject({ ok: false, error: expect.stringMatching(/carries no date/) });
  });

  it("an edit to the sentence drops its confirmation: it was for other words", () => {
    const confirmed = confirmFact(ABOUT, {}, STALE, TODAY);
    if (!confirmed.ok) throw new Error(confirmed.error);
    const edited = ABOUT.replace("12 paying stores", "14 paying stores");
    expect(staleFacts(edited, TODAY, { confirmations: confirmed.confirmedFacts }).map((f) => f.sentence)).toEqual([
      "Co-founded Postwren: 14 paying stores in October 2026.",
    ]);
    expect(liveConfirmations(edited, confirmed.confirmedFacts)).toEqual({});
    expect(liveConfirmations(ABOUT, confirmed.confirmedFacts)).toEqual(confirmed.confirmedFacts);
  });

  it("removing the fact removes its confirmation, and every write keeps only facts About you has", () => {
    const confirmed = confirmFact(ABOUT, {}, STALE, TODAY);
    if (!confirmed.ok) throw new Error(confirmed.error);
    const settings = VoiceSettings.parse({ aboutYou: ABOUT, confirmedFacts: { ...confirmed.confirmedFacts, "an old sentence": "2026-10-01" } });
    expect(withLiveConfirmations(settings).confirmedFacts).toEqual({ [KEY]: "2026-11-14" });
    const removed = removeFact(ABOUT, STALE);
    expect(withLiveConfirmations({ ...settings, aboutYou: removed.aboutYou }).confirmedFacts).toEqual({});
  });

  it("the undo puts the one entry back as it was: removed when there was none, the earlier day when there was", () => {
    const first = confirmFact(ABOUT, { other: "2026-11-01" }, STALE, TODAY);
    if (!first.ok) throw new Error(first.error);
    // "other" is no sentence of About you, so it is dropped on the way.
    expect(unconfirmFact(ABOUT, first.confirmedFacts, STALE, null)).toEqual({ confirmedFacts: {}, changed: true });
    const later = confirmFact(ABOUT, first.confirmedFacts, STALE, new Date("2026-12-20T10:00:00Z"));
    if (!later.ok) throw new Error(later.error);
    expect(unconfirmFact(ABOUT, later.confirmedFacts, STALE, later.previousConfirmedOn)).toEqual({
      confirmedFacts: { [KEY]: "2026-11-14" },
      changed: true,
    });
    expect(unconfirmFact(ABOUT, {}, STALE, null)).toEqual({ confirmedFacts: {}, changed: false });
    expect(unconfirmFact(ABOUT, first.confirmedFacts, "Never written.", null)).toEqual({ confirmedFacts: first.confirmedFacts, changed: false });
  });

  it("a sentence that still ends in an old \"(still true on …)\" is read like any other date, and never written", () => {
    const old = "12 paying stores in October 2026 (still true on November 14, 2026).";
    expect(staleFacts(old, new Date("2026-12-14T10:00:00Z"))).toEqual([]);
    expect(staleFacts(old, new Date("2026-12-15T10:00:00Z")).map((f) => f.dateLabel)).toEqual(["Nov 14, 2026"]);
    const confirmed = confirmFact(old, {}, old, TODAY);
    expect(confirmed).toMatchObject({ ok: true, sentence: old });
  });
});
