import { aboutYouFacts, datesIn, factSentences, quoteShort, type FactConfirmations } from "@/lib/voice/staleness";
import { contentTokens } from "./rules";

/**
 * A fact from About you is used only where it fits the post.
 *
 * About you (Settings → Voice) lists the only first-hand facts a draft may
 * state. On 10 November 2026, on the GetTrafficFast site, it held
 * "Co-founded Postwren, email marketing for Shopify stores: 12 paying stores
 * in October 2026.", and the reply to a post about a hackathon judged by
 * paying customers opened "12 paying stores for my own thing felt like real
 * validation". True to the list and wrong for the post: the account is
 * GetTrafficFast's and the fact is about another product, "stores" means
 * nothing to a reader who has never heard of it, and the figure was a month
 * old. The claims check passed it, because the number was recorded.
 *
 * This is the part of that check code can decide. It reads the numbers a
 * draft carries, finds the About you sentence each comes from (the same
 * number counting the same thing), and asks three questions of it:
 *
 * 1. Is the sentence about another product or business than this site, on a
 *    post that is not about that? (`other_product`)
 * 2. Does the post or the rest of the reply say what the number counts, so a
 *    reader can place it? (`no_subject`)
 * 3. Is the sentence dated more than `STALE_AFTER_DAYS` ago, and the number
 *    stated with no word of when? (`stale_as_current`)
 *
 * Pure and deterministic. It reads numbers only: a first-hand claim with no
 * figure in it ("I co-founded an email tool") is left to the prompt, since
 * matching prose to prose by keywords would refuse honest replies. A figure
 * the draft spells differently from About you ("seven shops" for "7 paying
 * stores") is not recognised either.
 */

export type FactProblemKind = "other_product" | "no_subject" | "stale_as_current";

export interface FactProblem {
  kind: FactProblemKind;
  /** The figure as the draft writes it: "12 paying stores". */
  quote: string;
  /** The About you sentence it comes from. */
  sentence: string;
  /** One sentence a person, or a rewrite, can act on. */
  detail: string;
}

export interface FactFitInput {
  body: string;
  aboutYou: string;
  thread: { title: string; excerpt: string | null };
  /** The site this reply is written for. */
  businessName: string;
  /** Every name the site goes by: its name, its brand names, its domains. */
  ownNames: string[];
  /** What the site can speak to; a capitalised topic ("SEO") is not another product. */
  expertise?: string[];
  /** The clock for staleness. Absent: the dated-fact question is not asked. */
  now?: Date;
  /** "Still true" confirmations: a fact confirmed within 30 days is not stale. */
  confirmations?: FactConfirmations;
}

interface Figure {
  /** The number, normalised: "7", "1200", "40%", "3k". */
  key: string;
  /** True when the number alone identifies it: three digits or more and not a round hundred. */
  distinctive: boolean;
  /** The content words right after it: what it counts. */
  unit: Set<string>;
  /** The number and what it counts, as written. */
  quote: string;
  start: number;
  end: number;
}

const WORD_NUMBERS: Record<string, string> = {
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  ten: "10",
  eleven: "11",
  twelve: "12",
};

const NUMBER = /(?<![\p{L}\p{N}.,])(\d[\d,.]*\d|\d)(\s?%|\+|[kKmMxX](?![\p{L}\p{N}]))?/gu;
const WORD_NUMBER = new RegExp(String.raw`(?<![\p{L}\p{N}])(${Object.keys(WORD_NUMBERS).join("|")})(?![\p{L}\p{N}])`, "giu");

/** How many words after a number say what it counts. */
const UNIT_WORDS = 3;

/** Words that sit in a fact without being its subject. */
const FILLER = new Set([
  "founded",
  "cofounded",
  "founder",
  "started",
  "built",
  "launched",
  "run",
  "running",
  "currently",
  "far",
  "day",
  "days",
  "week",
  "weeks",
  "month",
  "months",
  "year",
  "years",
  "early",
  "late",
  "mid",
  "last",
  "ago",
  "today",
]);

/** contentTokens adds a crude stem beside each plural; one word is counted once. */
function stems(text: string): Set<string> {
  const tokens = contentTokens(text);
  const out = new Set<string>();
  for (const token of tokens) {
    if (/^\d+$/.test(token)) continue;
    if (token.endsWith("s") && token.length > 4 && tokens.has(token.slice(0, -1))) continue;
    out.add(token);
  }
  return out;
}

function shared(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter((token) => b.has(token));
}

/** The words after a number, up to the next punctuation: what it counts. */
function unitAfter(text: string, from: number): { words: string[]; end: number } {
  const tail = text.slice(from);
  const clause = tail.match(/^[^.!?;:,()\n\u0000]*/)?.[0] ?? "";
  const found: Array<{ word: string; end: number }> = [];
  const word = /[\p{L}][\p{L}'’-]*/gu;
  let match: RegExpExecArray | null;
  while (found.length < UNIT_WORDS && (match = word.exec(clause))) {
    found.push({ word: match[0], end: from + match.index + match[0].length });
  }
  // "12 paying stores for": the quote stops on the last word that means something.
  while (found.length > 0 && contentTokens(found[found.length - 1].word).size === 0) found.pop();
  return { words: found.map((item) => item.word), end: found[found.length - 1]?.end ?? from };
}

/** Every number in a text, digits or one to twelve in words, with what it counts. */
function figuresIn(text: string, options: { words: boolean; zero?: boolean }): Figure[] {
  const figures: Figure[] = [];
  const add = (start: number, numberEnd: number, key: string, distinctive: boolean) => {
    const unit = unitAfter(text, numberEnd);
    figures.push({
      key,
      distinctive,
      unit: stems(unit.words.join(" ")),
      quote: text.slice(start, Math.max(unit.end, numberEnd)).replace(/\s+/g, " ").trim(),
      start,
      end: Math.max(unit.end, numberEnd),
    });
  };
  for (const match of text.matchAll(NUMBER)) {
    const digits = match[1].replace(/,/g, "").replace(/\.$/, "");
    const sign = (match[2] ?? "").trim().toLowerCase();
    const suffix = sign === "+" ? "" : sign;
    const plain = digits.replace(/\D/g, "");
    add(match.index, match.index + match[0].length, `${digits}${suffix}`, plain.length >= 3 && !plain.endsWith("00"));
  }
  if (options.words) {
    for (const match of text.matchAll(WORD_NUMBER)) {
      add(match.index, match.index + match[0].length, WORD_NUMBERS[match[1].toLowerCase()], false);
    }
  }
  if (options.zero) {
    for (const match of text.matchAll(/(?<![\p{L}\p{N}])zero(?![\p{L}\p{N}])/giu)) {
      add(match.index, match.index + match[0].length, "0", false);
    }
  }
  return figures;
}

/** A text with the given spans blanked, same length. */
function blank(text: string, spans: Array<{ start: number; end: number }>): string {
  let out = text;
  for (const span of spans) out = `${out.slice(0, span.start)}${"\u0000".repeat(span.end - span.start)}${out.slice(span.end)}`;
  return out;
}

const norm = (name: string) => name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** Capitalised words that open a sentence and are nobody's product. */
const NOT_A_VENTURE = new Set(["i", "we", "it", "my", "our", "the", "a", "an", "this", "that", "they", "he", "she", "you"]);

const OWNERSHIP = String.raw`(?:co-?found(?:ed|er of|ing)|found(?:ed|er of|ing)|built|building|run|running|ran|launch(?:ed|ing)|start(?:ed|ing)|creat(?:ed|or of|ing)|made|mak(?:er of|ing)|work(?:s|ing|ed)? (?:on|at|for)|own(?:er of|s)?|behind|ceo of|cto of)`;
const OWNED = new RegExp(String.raw`(?<![\p{L}\p{N}])${OWNERSHIP}\s+(?:the\s+|my\s+|our\s+)?(\S+(?:\s+\S+){0,2})`, "giu");
const SUBJECT = /^(\S+)\s+(?:has|had|is at|hit|reached|got|gets|makes|made|grew|serves|sends|went)\b/u;

/** The leading capitalised words of a phrase, as one name: "Postwren," → "Postwren". */
function leadingName(phrase: string): string | null {
  const parts: string[] = [];
  for (const raw of phrase.split(/\s+/)) {
    const word = raw.replace(/['’]s\b.*$/u, "").replace(/[^\p{L}\p{N}.-]+$/u, "").replace(/\.$/, "");
    if (!/^\p{Lu}/u.test(word)) break;
    parts.push(word);
    if (raw !== word) break; // punctuation or a possessive ends the name
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * The product or business a sentence says the writer owns, builds or works
 * on, when it is not this site: "Co-founded Postwren, …", "I run Acme",
 * "Postwren has 12 paying stores". Read from a capitalised name after a word
 * of ownership, so a place ("I live in Lisbon"), a platform merely used
 * ("on Google") and a lowercase name are not one. An acronym ("SEO") and a
 * topic the site speaks to are not products.
 */
export function otherVenture(sentence: string, ownNames: string[], expertise: string[] = []): string | null {
  const own = ownNames.map(norm).filter((name) => name.length >= 3);
  const topics = new Set(expertise.map(norm));
  const candidates: string[] = [];
  for (const match of sentence.matchAll(OWNED)) {
    const name = leadingName(match[1]);
    if (name) candidates.push(name);
  }
  const subject = sentence.match(SUBJECT)?.[1];
  if (subject) {
    const name = leadingName(subject);
    if (name && !NOT_A_VENTURE.has(name.toLowerCase())) candidates.push(name);
  }
  for (const name of candidates) {
    const key = norm(name);
    if (key.length < 3) continue;
    if (name === name.toUpperCase()) continue; // SEO, AI, B2B
    if (topics.has(key)) continue;
    if (own.some((mine) => mine === key || mine.includes(key) || key.includes(mine))) continue;
    return name;
  }
  return null;
}

/** A word of when: the fact's own month or year, or any plain marker of the past. */
function saysWhen(sentence: string, dateIso: string): boolean {
  const date = new Date(`${dateIso}T00:00:00Z`);
  const month = date.toLocaleString("en-US", { month: "long", timeZone: "UTC" }).toLowerCase();
  const lower = sentence.toLowerCase();
  if (new RegExp(String.raw`\b(?:${month}|${month.slice(0, 3)})\b`).test(lower)) return true;
  if (lower.includes(String(date.getUTCFullYear()))) return true;
  return /\b(last (week|month|quarter|year|spring|summer|fall|autumn|winter)|ago|back (in|then|when)|at the time|at that point|by then|as of|used to|a (week|month|year) (back|earlier))\b/.test(lower);
}

function draftSentences(body: string): Array<{ text: string; start: number; end: number }> {
  const out: Array<{ text: string; start: number; end: number }> = [];
  const pattern = /[^.!?\n]+[.!?]*/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body))) out.push({ text: match[0], start: match.index, end: match.index + match[0].length });
  return out;
}

/**
 * The About you facts a draft uses where they do not fit, one problem per
 * figure, the most serious first. Empty when every number the draft takes
 * from About you fits, and when it takes none.
 */
export function factProblems(input: FactFitInput): FactProblem[] {
  const aboutYou = input.aboutYou.trim();
  if (!aboutYou || !input.body.trim()) return [];
  const clock = input.now ?? new Date();
  const facts = input.now ? aboutYouFacts(aboutYou, input.now, { confirmations: input.confirmations }) : [];
  const postTokens = stems(`${input.thread.title} ${input.thread.excerpt ?? ""}`);
  const used = figuresIn(input.body, { words: true });
  const problems: FactProblem[] = [];
  const seen = new Set<string>();

  for (const sentence of factSentences(aboutYou)) {
    // A date is not a figure: "October 2026" is neither 2026 of something nor 20.
    const undated = blank(sentence, datesIn(sentence, clock));
    const recorded = figuresIn(undated, { words: false });
    if (recorded.length === 0) continue;
    const sentenceTokens = stems(undated);
    const venture = otherVenture(sentence, input.ownNames, input.expertise);

    for (const fact of recorded) {
      const use = used.find(
        (figure) =>
          // The same number counting the same thing; a number like 342 is
          // the fact on its own, a 7 or a 100 is not.
          figure.key === fact.key && (shared(figure.unit, fact.unit).length > 0 || fact.distinctive)
      );
      if (!use || seen.has(`${use.start}`)) continue;
      seen.add(`${use.start}`);
      const quote = use.quote;

      // 1. Another product's fact, on a post that is not about it. The post
      // is about it when it names it, or shares two of the fact's own words.
      if (venture) {
        const ventureTokens = stems(venture);
        const aboutIt = shared(ventureTokens, postTokens).length > 0 || shared(sentenceTokens, postTokens).length >= 2;
        if (!aboutIt) {
          problems.push({
            kind: "other_product",
            quote,
            sentence,
            detail: `Uses a fact about another product: "${quote}" is about ${venture} in About you, this reply is written for ${input.businessName || "this site"}, and the post is not about ${venture}. Leave the number out and put no other number in its place.`,
          });
          continue;
        }
      }

      // 2. A number nobody can place: nothing in the post, or in the rest of
      // the reply, says what it counts. Judged only when the sentence has a
      // subject beyond the figure itself.
      const subject = new Set([...sentenceTokens].filter((token) => !fact.unit.has(token) && !FILLER.has(token)));
      if (subject.size > 0) {
        const rest = stems(`${input.body.slice(0, use.start)} ${input.body.slice(use.end)}`);
        if (shared(subject, postTokens).length === 0 && shared(subject, rest).length === 0) {
          problems.push({
            kind: "no_subject",
            quote,
            sentence,
            detail: `Uses a number the reader cannot place: "${quote}" comes from About you ("${quoteShort(sentence)}"), and neither the post nor the reply says what it counts. Say what it is in plain words, or leave the number out.`,
          });
          continue;
        }
      }

      // 3. A dated fact, past the threshold, stated with no word of when.
      const dated = facts.find((entry) => entry.sentence === sentence);
      if (dated?.stale && dated.date) {
        const around = draftSentences(input.body).find((s) => use.start >= s.start && use.start < s.end)?.text ?? input.body;
        // Said once for a sentence, however many of its figures the draft took.
        // When it was true: its own date, or the day it was last confirmed.
        const when = saysWhen(around, dated.date.iso) || (dated.confirmedOn !== null && saysWhen(around, dated.confirmedOn));
        if (!when && !problems.some((p) => p.kind === "stale_as_current" && p.sentence === sentence)) {
          const month = new Date(`${dated.date.iso}T00:00:00Z`).toLocaleString("en-US", { month: "long", timeZone: "UTC" });
          problems.push({
            kind: "stale_as_current",
            quote,
            sentence,
            detail: `States a dated fact as current: "${quote}" is dated ${dated.date.label} in About you. Say when it was true ("in ${month} I had…"), or leave it out.`,
          });
        }
      }
    }
  }

  const order: Record<FactProblemKind, number> = { other_product: 0, no_subject: 1, stale_as_current: 2 };
  return problems.sort((a, b) => order[a.kind] - order[b.kind]);
}

/**
 * Which About you sentences a text uses: the tracing above, turned into a
 * list. The case, 12 November 2026: About you held one usable fact, the
 * owner's blog numbers, and 5 of the last 17 drafts said "position 30-40",
 * the last one under a post about being called a grifter. A fact used again
 * and again is caught by comparing the sentences each recent reply used
 * (lib/placements/recent-facts.ts); this says which ones a text uses.
 *
 * A sentence is used when the text carries, from it:
 *
 * - a number counting the same thing, as `factProblems` traces it (the same
 *   number with a word of what it counts in common, or a number distinctive
 *   on its own like 342), or the same number after the same word
 *   ("position 30"), "zero" read as 0 ("zero clicks" for "0 clicks");
 * - the same range ("30-40", "30 to 40");
 * - a name it holds, a capitalised word that is not the first of the
 *   sentence and not a month ("Taipei", "Porto");
 * - two of its content words side by side ("ai pipeline", "self-taught",
 *   "full stack").
 *
 * A name or a pair of words the post itself uses is the text answering the
 * post, not the fact, so it is not counted when `post` is given. Pure and
 * deterministic; a fact written in other words ("seven shops") is missed,
 * which costs a repeat not caught, never an honest reply refused.
 */
export interface FactUse {
  /** The About you sentence. */
  sentence: string;
  /** What of it the text says, as the text writes it: "position 30-40", "342 impressions", "Taipei". */
  quote: string;
}

const RANGE = /(?<![\p{L}\p{N}.,])(\d[\d,.]*\d|\d)\s?(?:-|–|—|to)\s?(\d[\d,.]*\d|\d)(?![\p{L}\p{N}])/gu;

const MONTH_WORDS = new Set([
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
]);

/** The word right before a position, in the same clause, when it means something: "position" of "position 30-40". */
function wordBefore(text: string, at: number): string | null {
  const clause = text.slice(0, at).match(/[^.!?;:,()\n\u0000]*$/u)?.[0] ?? "";
  const word = clause.match(/([\p{L}][\p{L}'’-]*)\s*$/u)?.[1];
  return word && contentTokens(word).size > 0 && !FILLER.has(word.toLowerCase()) ? word : null;
}

/** Every range a text writes ("30-40", "30 to 40"), with the word before it when there is one. */
function rangesIn(text: string): Array<{ key: string; quote: string }> {
  const out: Array<{ key: string; quote: string }> = [];
  for (const match of text.matchAll(RANGE)) {
    const key = `${match[1].replace(/,/g, "")}-${match[2].replace(/,/g, "")}`;
    const before = wordBefore(text, match.index);
    out.push({ key, quote: (before ? `${before} ${match[0]}` : match[0]).replace(/\s+/g, " ").trim() });
  }
  return out;
}

/** A word that can make a phrase: a content word, not a number, a month or filler. */
function phraseWord(word: string): boolean {
  return !/^\d+$/.test(word) && !FILLER.has(word) && !MONTH_WORDS.has(word) && contentTokens(word).size > 0;
}

/** Content words side by side, inside one clause, lower case: "ai pipeline", "self taught". */
function pairsIn(text: string): Set<string> {
  const pairs = new Set<string>();
  for (const clause of text.toLowerCase().split(/[.!?;:,()\n\u0000"“”]+/u)) {
    const words = clause.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    for (let i = 0; i + 1 < words.length; i++) {
      if (phraseWord(words[i]) && phraseWord(words[i + 1])) pairs.add(`${words[i]} ${words[i + 1]}`);
    }
  }
  return pairs;
}

/** Capitalised words a sentence holds as names: not its first word, not after a stop or a colon, not a month. */
function namesIn(sentence: string): string[] {
  const names: string[] = [];
  const raws = sentence.split(/\s+/);
  raws.forEach((raw, index) => {
    if (index === 0 || /[.!?:]$/.test(raws[index - 1])) return;
    const word = raw.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
    if (!/^\p{Lu}\p{Ll}{3,}$/u.test(word) || MONTH_WORDS.has(word.toLowerCase())) return;
    names.push(word);
  });
  return names;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A whole word or phrase in a text, case aside, as the text writes it; null when it is not there. */
function written(text: string, pattern: string): string | null {
  return text.match(new RegExp(String.raw`(?<![\p{L}\p{N}])${pattern}(?![\p{L}\p{N}])`, "iu"))?.[0] ?? null;
}

/** The About you sentences a text uses, each once, in About you's order, with what of it the text says. */
export function factsUsed(text: string, aboutYou: string, options: { now?: Date; post?: string } = {}): FactUse[] {
  const about = aboutYou.trim();
  if (!about || !text.trim()) return [];
  const clock = options.now ?? new Date();
  const figures = figuresIn(text, { words: true, zero: true });
  const ranges = rangesIn(text);
  const pairs = pairsIn(text);
  const post = options.post ?? "";
  const postPairs = pairsIn(post);
  const postWords = contentTokens(post);
  const uses: FactUse[] = [];

  for (const sentence of factSentences(about)) {
    // A date is not a figure, and "Oct 26" is no range or pair either.
    const undated = blank(sentence, datesIn(sentence, clock));

    // A range first: "30-40" is one fact, not a 25 and a 35.
    const recordedRanges = new Set(rangesIn(undated).map((range) => range.key));
    let quote = ranges.find((range) => recordedRanges.has(range.key))?.quote ?? null;

    if (!quote) {
      for (const fact of figuresIn(undated, { words: false })) {
        const before = wordBefore(undated, fact.start)?.toLowerCase() ?? null;
        const use = figures.find(
          (figure) =>
            figure.key === fact.key &&
            (shared(figure.unit, fact.unit).length > 0 ||
              fact.distinctive ||
              (before !== null && wordBefore(text, figure.start)?.toLowerCase() === before))
        );
        if (!use) continue;
        const lead = use.unit.size === 0 ? wordBefore(text, use.start) : null;
        quote = lead ? `${lead} ${use.quote}` : use.quote;
        break;
      }
    }

    if (!quote) {
      for (const name of namesIn(undated)) {
        if (postWords.has(name.toLowerCase())) continue;
        quote = written(text, escapeRegExp(name));
        if (quote) break;
      }
    }

    if (!quote) {
      for (const pair of pairsIn(undated)) {
        if (!pairs.has(pair) || postPairs.has(pair)) continue;
        const [a, b] = pair.split(" ");
        quote = written(text, String.raw`${escapeRegExp(a)}[^\p{L}\p{N}]+${escapeRegExp(b)}`);
        if (quote) break;
      }
    }

    if (quote) uses.push({ sentence, quote });
  }
  return uses;
}
