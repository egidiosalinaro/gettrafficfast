import type { RecentFacts } from "@/lib/voice/fact-rules";
import { quoteShort } from "@/lib/voice/staleness";
import { factsUsed } from "./fact-fit";

/**
 * "Repeats a recent fact": the gate's half of lib/placements/recent-facts.ts,
 * kept apart and pure so the gate (lib/placements/audit.ts) reads it without
 * the loader's imports. The case, 12 November 2026: 5 of the last 17 drafts
 * said "position 30-40".
 */

/** A fact in this many of the recent replies is one too many. */
export const REPEAT_MIN = 2;

export interface FactRepeat {
  sentence: string;
  /** What the draft says of it. */
  quote: string;
  /** In how many of the recent replies the sentence already is. */
  count: number;
  /** One sentence the person, or a rewrite, can act on. */
  detail: string;
}

/**
 * The About you sentences a draft uses that REPEAT_MIN or more of the recent
 * replies already used. Empty when none, and when nothing was read.
 */
export function repeatedFacts(
  body: string,
  aboutYou: string,
  recent: RecentFacts,
  options: { now?: Date; post?: string } = {}
): FactRepeat[] {
  if (recent.replies === 0 || recent.facts.length === 0) return [];
  const key = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();
  return factsUsed(body, aboutYou, options).flatMap((use) => {
    const past = recent.facts.find((fact) => fact.sentence === use.sentence);
    if (!past || past.count < REPEAT_MIN) return [];
    const sameWords = past.quotes.length > 0 && past.quotes.every((quote) => key(quote) === key(use.quote));
    const where = `${past.count} of your last ${recent.replies} replies`;
    const detail = sameWords
      ? `"${use.quote}" is in ${where}. Say something else, or nothing about yourself.`
      : `"${use.quote}" repeats a fact already in ${where} ("${quoteShort(use.sentence)}"). Say something else, or nothing about yourself.`;
    return [{ sentence: use.sentence, quote: use.quote, count: past.count, detail }];
  });
}
