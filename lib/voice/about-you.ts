import type { SupabaseClient } from "@supabase/supabase-js";
import { ABOUT_YOU_MAX, VoiceSettings, withLiveConfirmations } from "./settings";
import { confirmationOf, datesIn, factKey, factSentences, liveConfirmations, type FactConfirmations } from "./staleness";

/**
 * "It's true: add to About you": a sentence the gate flagged, confirmed by
 * the person as a true fact about themselves, appended to About you
 * (Settings → Voice), the only first-hand facts a draft may state.
 *
 * The case, 12 November 2026: a reply said "during the last week i'm going
 * 100% on marketing for both my startups too", the check failed on a number
 * nobody declared, and the sentence was true. The owner wanted to say so in
 * one tap, so the draft passes and later drafts may use the fact.
 *
 * Rules, each one a reason:
 *
 * - Nothing is added the person did not confirm. The tap opens a field,
 *   prefilled from the sentence by a fixed transform (`factFromSentence`, no
 *   model), and only the text they save is written.
 * - The fact is dated ("As of November 12, 2026: …"), so the staleness rule
 *   (lib/voice/staleness.ts) asks "still true?" once it is a month old.
 * - About you is appended to, never rewritten or reordered (`appendFact`).
 * - Undo removes exactly the sentence that was added (`removeFact`), and
 *   only while About you is as the add left it, when the caller says so.
 * - About you holds `ABOUT_YOU_MAX` characters. A fact that would not fit is
 *   refused with a sentence; nothing is cut to make room.
 */

/** The longest fact the tap, the API and MCP accept. */
export const ABOUT_YOU_FACT_MAX = 300;

export const ABOUT_YOU_FULL = "About you is full; edit it in Settings → Voice.";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "November 12, 2026", in UTC: the form the staleness reader reads as a day. */
export function factDateLabel(now: Date): string {
  return `${MONTHS[now.getUTCMonth()]} ${now.getUTCDate()}, ${now.getUTCFullYear()}`;
}

/**
 * Words a reply opens with that are talk, not fact: "i know that feeling",
 * "honestly", "tbh", "yeah", "but", "so". Stripped from the front, again and
 * again, until none is left. Lower case; matched case-insensitively.
 */
const LEADING_TALK =
  /^(?:(?:honestly|tbh|ngl|lol|haha|yeah|yes|yep|ok|okay|well|so|and|but|also|plus|anyway|fwiw|imo|imho|same|same here|for what it's worth|to be honest|for real)\b[,:;!.\s-]*)/i;

/** Words a reply closes with that only point back at the thread: "too", "as well", "lol". */
const TRAILING_TALK = /[,\s]+(?:too|as well|also|lol|haha|tbh|honestly|ngl)\s*$/i;

/** The pronoun "i" in a lowercase reply, as a fact writes it: "I", "I'm", "I've". */
function capitalI(text: string): string {
  return text.replace(/(^|[^\p{L}\p{N}'’])i(?=$|[^\p{L}\p{N}]|['’](?:m|ve|d|ll)\b)/gu, "$1I");
}

/** One line, the space collapsed and the end punctuation reduced to one full stop. */
export function factLine(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) return "";
  return /[.!?]$/.test(line) ? line.replace(/[.!?]+$/, ".") : `${line}.`;
}

/**
 * The sentence the gate flagged, as a dated first-person fact: its talk
 * stripped from both ends, the pronoun capitalised, "As of <Month D, YYYY>:"
 * in front. Deterministic: no model is called, and the person edits it
 * before anything is saved. "during the last week i'm going 100% on
 * marketing for both my startups too." on 12 November 2026 becomes "As of
 * November 12, 2026: during the last week I'm going 100% on marketing for
 * both my startups."
 */
export function factFromSentence(sentence: string, now: Date): string {
  let text = sentence.replace(/\s+/g, " ").trim().replace(/[.!?…]+$/u, "");
  for (let previous = ""; previous !== text; ) {
    previous = text;
    text = text.replace(LEADING_TALK, "").replace(TRAILING_TALK, "").trim();
  }
  const body = capitalI(text);
  return factLine(body ? `As of ${factDateLabel(now)}: ${body}` : "");
}

export type AppendFactResult =
  | { ok: true; aboutYou: string; fact: string; appended: boolean }
  | { ok: false; error: string };

/**
 * About you with `fact` as a new last sentence. The existing text is kept
 * byte for byte: the fact goes after it, separated by one space when it
 * ends a sentence, by a line break when it does not (so the two never read
 * as one sentence), and by nothing when it already ends in whitespace.
 * Unchanged (`appended` false) when the fact is already there. Refused with
 * a sentence when it is empty, longer than `ABOUT_YOU_FACT_MAX`, or would
 * not fit in `ABOUT_YOU_MAX`.
 */
export function appendFact(aboutYou: string, rawFact: string): AppendFactResult {
  const fact = factLine(rawFact);
  if (!fact) return { ok: false, error: "There is no fact to add." };
  if (fact.length > ABOUT_YOU_FACT_MAX) {
    return { ok: false, error: `Keep the fact under ${ABOUT_YOU_FACT_MAX} characters.` };
  }
  if (aboutYou.split(/\n+|(?<=[.!?;])\s+/).some((sentence) => factKey(sentence) === factKey(fact))) {
    return { ok: true, aboutYou, fact, appended: false };
  }
  const separator = aboutYou === "" || /\s$/.test(aboutYou) ? "" : /[.!?;]$/.test(aboutYou) ? " " : "\n";
  const next = `${aboutYou}${separator}${fact}`;
  if (next.length > ABOUT_YOU_MAX) {
    return {
      ok: false,
      error: `${ABOUT_YOU_FULL} With this fact it would be ${next.length.toLocaleString("en-US")} characters, and it holds ${ABOUT_YOU_MAX.toLocaleString("en-US")}.`,
    };
  }
  return { ok: true, aboutYou: next, fact, appended: true };
}

export type RemoveFactResult = { aboutYou: string; removed: boolean };

/**
 * About you without `fact`: the exact sentence, as `appendFact` wrote it,
 * and the one space or line break that was put before it. Unchanged
 * (`removed` false) when it is not there. The last copy is the one taken
 * out, since an add always writes at the end.
 */
export function removeFact(aboutYou: string, rawFact: string): RemoveFactResult {
  const fact = factLine(rawFact);
  if (!fact) return { aboutYou, removed: false };
  let at = aboutYou.lastIndexOf(fact);
  // A whole sentence only: "run Acme." is not removed from "I run Acme."
  while (at >= 0) {
    const head = aboutYou.slice(0, at);
    const after = aboutYou.slice(at + fact.length, at + fact.length + 1);
    const opens = head === "" || (/\s$/.test(head) && (head.trim() === "" || /[.!?;]\s+$|\n\s*$/.test(head)));
    if (opens && (after === "" || /\s/.test(after))) break;
    at = at === 0 ? -1 : aboutYou.lastIndexOf(fact, at - 1);
  }
  if (at < 0) return { aboutYou, removed: false };
  const end = at + fact.length;
  // The separator `appendFact` put before it, and only that: a space after
  // the end of a sentence, a line break after text that did not end one.
  // Whitespace that was already there stays.
  const prior = at >= 2 ? aboutYou[at - 2] : "";
  const added =
    (aboutYou[at - 1] === " " && /[.!?;]/.test(prior)) || (aboutYou[at - 1] === "\n" && prior !== "" && !/[\s.!?;]/.test(prior));
  const start = added ? at - 1 : at;
  // A fact that opens the text takes the space after it with it.
  const stop = at === 0 && /[ \n]/.test(aboutYou[end] ?? "") ? end + 1 : end;
  return { aboutYou: `${aboutYou.slice(0, start)}${aboutYou.slice(stop)}`, removed: true };
}

/**
 * "Still true" (2026-11-14, Today's "Still true?" card): a dated fact the
 * person confirms is still true. The confirmation is stored apart from the
 * text, in `confirmedFacts` (the fact's key, `factKey`, to the day), and
 * About you is left exactly as the person wrote it: the drafter reads About
 * you, and a date written into the sentence (the first version, rejected by
 * the owner the same day) reached the text the drafts are built from. The
 * staleness rule (lib/voice/staleness.ts) counts a fact's age from the
 * later of its own date and its confirmation, so it is not asked about for
 * another 30 days, and Settings, Today, the drafts' stale list and the gate
 * all read the same map. Confirming again moves the day.
 */
export type ConfirmFactResult =
  | {
      ok: true;
      /** The confirmations after this one, only for facts About you still has. */
      confirmedFacts: Record<string, string>;
      /** The sentence of About you confirmed, as written there. */
      sentence: string;
      confirmedOn: string;
      /** The day it was confirmed before, the Undo puts back; null when never. */
      previousConfirmedOn: string | null;
      changed: boolean;
    }
  | { ok: false; error: string };

const NOT_THERE = "This fact is no longer in About you as it was. Edit it in Settings → Voice.";

/** The sentence of About you these words are, as written there; null when About you has none. */
function sentenceOf(aboutYou: string, sentence: string): string | null {
  const key = factKey(sentence);
  return key ? (factSentences(aboutYou).find((candidate) => factKey(candidate) === key) ?? null) : null;
}

/**
 * The confirmations with that sentence confirmed today. The sentence must be
 * one of About you's (`factSentences`), with the same words as `staleFacts`
 * quoted it, and carry a date; otherwise nothing is changed and the person
 * edits About you in Settings. About you itself is never touched.
 */
export function confirmFact(aboutYou: string, confirmations: FactConfirmations, rawSentence: string, now: Date): ConfirmFactResult {
  if (!rawSentence.trim()) return { ok: false, error: "There is no fact to confirm." };
  const sentence = sentenceOf(aboutYou, rawSentence);
  if (sentence === null) return { ok: false, error: NOT_THERE };
  if (datesIn(sentence, now).length === 0) {
    return { ok: false, error: "This fact carries no date, so it is never asked about. Edit it in Settings → Voice." };
  }
  const key = factKey(sentence);
  const confirmedOn = now.toISOString().slice(0, 10);
  const previousConfirmedOn = confirmationOf(sentence, confirmations);
  const before = liveConfirmations(aboutYou, confirmations);
  const confirmedFacts = { ...before, [key]: confirmedOn };
  return {
    ok: true,
    confirmedFacts,
    sentence,
    confirmedOn,
    previousConfirmedOn,
    changed: previousConfirmedOn !== confirmedOn || Object.keys(before).length !== Object.keys(confirmations).length,
  };
}

/**
 * The Undo of "Still true": the confirmation of that sentence put back as it
 * was before (`previousConfirmedOn`), removed when there was none. Only that
 * entry changes; a sentence About you no longer has has nothing to undo.
 */
export function unconfirmFact(
  aboutYou: string,
  confirmations: FactConfirmations,
  rawSentence: string,
  previousConfirmedOn: string | null
): { confirmedFacts: Record<string, string>; changed: boolean } {
  const live = liveConfirmations(aboutYou, confirmations);
  const sentence = sentenceOf(aboutYou, rawSentence);
  const pruned = Object.keys(live).length !== Object.keys(confirmations).length;
  if (sentence === null) return { confirmedFacts: live, changed: pruned };
  const key = factKey(sentence);
  const { [key]: current, ...rest } = live;
  const confirmedFacts = previousConfirmedOn ? { ...rest, [key]: previousConfirmedOn } : rest;
  return { confirmedFacts, changed: pruned || current !== (previousConfirmedOn ?? undefined) };
}

export type AboutYouChangeResult =
  | { ok: true; aboutYou: string; fact: string; changed: boolean }
  | { ok: false; status: 404 | 409 | 500; error: string };

/**
 * The stored voice settings, read strictly: an unreadable value is refused,
 * never replaced with the defaults (which would erase the owner's notes).
 */
async function storedVoice(
  supabase: SupabaseClient,
  userId: string,
  businessId: string
): Promise<{ ok: true; settings: VoiceSettings } | { ok: false; status: 404 | 409; error: string }> {
  const { data: business } = await supabase
    .from("businesses")
    .select("id, voice_settings")
    .eq("id", businessId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!business) return { ok: false, status: 404, error: "Business not found" };
  const stored = VoiceSettings.safeParse((business as Record<string, unknown>).voice_settings ?? {});
  if (!stored.success) {
    return {
      ok: false,
      status: 409,
      error: "Your voice settings could not be read. Open Settings → Voice, save them once, then try again.",
    };
  }
  return { ok: true, settings: stored.data };
}

/**
 * Writes the voice with these fields changed. The confirmations of facts
 * About you no longer has go with them (`withLiveConfirmations`): removing
 * a fact removes its confirmation.
 */
async function writeVoice(
  supabase: SupabaseClient,
  userId: string,
  businessId: string,
  settings: VoiceSettings,
  change: Partial<Pick<VoiceSettings, "aboutYou" | "confirmedFacts">>,
  now: Date
): Promise<{ ok: true } | { ok: false; status: 409 | 500; error: string }> {
  const next = VoiceSettings.safeParse({ ...settings, ...change });
  if (!next.success) return { ok: false, status: 409, error: next.error.issues[0]?.message ?? "About you would not be valid." };
  const { error } = await supabase
    .from("businesses")
    .update({ voice_settings: withLiveConfirmations(next.data), updated_at: now.toISOString() })
    .eq("id", businessId)
    .eq("user_id", userId);
  if (error) return { ok: false, status: 500, error: error.message };
  return { ok: true };
}

/**
 * Appends one confirmed fact to the site's About you. The screen's "It's
 * true" Save and the API's `add_about_you_fact` call it. Through the
 * caller's client, so RLS proves the site is theirs.
 */
export async function addAboutYouFact(input: {
  supabase: SupabaseClient;
  userId: string;
  businessId: string;
  fact: string;
  now?: Date;
}): Promise<AboutYouChangeResult> {
  const stored = await storedVoice(input.supabase, input.userId, input.businessId);
  if (!stored.ok) return stored;
  const appended = appendFact(stored.settings.aboutYou, input.fact);
  if (!appended.ok) return { ok: false, status: 409, error: appended.error };
  if (appended.appended) {
    const written = await writeVoice(input.supabase, input.userId, input.businessId, stored.settings, { aboutYou: appended.aboutYou }, input.now ?? new Date());
    if (!written.ok) return written;
  }
  return { ok: true, aboutYou: appended.aboutYou, fact: appended.fact, changed: appended.appended };
}

/**
 * The undo: removes that exact sentence from About you, if it is there.
 * With `ifAboutYouIs` (what the add answered), it is refused when About you
 * has changed since, so an undo never takes out a sentence the owner has
 * edited around in the meantime.
 */
export async function removeAboutYouFact(input: {
  supabase: SupabaseClient;
  userId: string;
  businessId: string;
  fact: string;
  ifAboutYouIs?: string;
  now?: Date;
}): Promise<AboutYouChangeResult> {
  const stored = await storedVoice(input.supabase, input.userId, input.businessId);
  if (!stored.ok) return stored;
  if (input.ifAboutYouIs !== undefined && input.ifAboutYouIs !== stored.settings.aboutYou) {
    return {
      ok: false,
      status: 409,
      error: "About you has changed since this was added, so it was left as it is. Edit it in Settings → Voice.",
    };
  }
  const removed = removeFact(stored.settings.aboutYou, input.fact);
  if (removed.removed) {
    const written = await writeVoice(input.supabase, input.userId, input.businessId, stored.settings, { aboutYou: removed.aboutYou }, input.now ?? new Date());
    if (!written.ok) return written;
  }
  return { ok: true, aboutYou: removed.aboutYou, fact: factLine(input.fact), changed: removed.removed };
}

export type ConfirmAboutYouFactResult =
  | {
      ok: true;
      /** The sentence of About you, exactly as written there: never changed by a confirmation. */
      fact: string;
      /** The day it now counts as confirmed; null after an undo that left it unconfirmed. */
      confirmedOn: string | null;
      /** The day it was confirmed before this call; null when never. What an undo sends back. */
      previousConfirmedOn: string | null;
      changed: boolean;
    }
  | { ok: false; status: 404 | 409 | 500; error: string };

/**
 * "Still true": records that one sentence of About you is still true today
 * (`confirmFact`), in `confirmedFacts`; About you is not written. Today's
 * card and `confirm_about_you_fact` call it. With `undo`, the confirmation
 * goes back to `previousConfirmedOn` (removed when null): the screen's Undo
 * and the tool's.
 */
export async function confirmAboutYouFact(input: {
  supabase: SupabaseClient;
  userId: string;
  businessId: string;
  sentence: string;
  undo?: { previousConfirmedOn: string | null };
  now?: Date;
}): Promise<ConfirmAboutYouFactResult> {
  const stored = await storedVoice(input.supabase, input.userId, input.businessId);
  if (!stored.ok) return stored;
  const now = input.now ?? new Date();
  const { aboutYou, confirmedFacts } = stored.settings;
  const before = confirmationOf(input.sentence, confirmedFacts);
  if (input.undo) {
    const undone = unconfirmFact(aboutYou, confirmedFacts, input.sentence, input.undo.previousConfirmedOn);
    if (undone.changed) {
      const written = await writeVoice(input.supabase, input.userId, input.businessId, stored.settings, { confirmedFacts: undone.confirmedFacts }, now);
      if (!written.ok) return written;
    }
    const sentence = sentenceOf(aboutYou, input.sentence) ?? input.sentence.trim();
    return { ok: true, fact: sentence, confirmedOn: confirmationOf(sentence, undone.confirmedFacts), previousConfirmedOn: before, changed: undone.changed };
  }
  const confirmed = confirmFact(aboutYou, confirmedFacts, input.sentence, now);
  if (!confirmed.ok) return { ok: false, status: 409, error: confirmed.error };
  if (confirmed.changed) {
    const written = await writeVoice(input.supabase, input.userId, input.businessId, stored.settings, { confirmedFacts: confirmed.confirmedFacts }, now);
    if (!written.ok) return written;
  }
  return {
    ok: true,
    fact: confirmed.sentence,
    confirmedOn: confirmed.confirmedOn,
    previousConfirmedOn: confirmed.previousConfirmedOn,
    changed: confirmed.changed,
  };
}
