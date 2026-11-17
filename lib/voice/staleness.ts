/**
 * Which facts in About you have gone stale.
 *
 * About you (Settings → Voice) is the list of the only first-hand facts a
 * draft may state. On 10 November 2026 it held "12 paying stores in October
 * 2026", and a reply stated the figure as if it were current; it was not
 * true any more. A fact that carries a date is true as of that date, so a
 * dated sentence older than `STALE_AFTER_DAYS` is flagged: Settings asks
 * "still true?", and a draft is told to state it as of its date.
 *
 * Pure: no I/O, no clock other than the `now` passed in. Days are counted in
 * UTC. Nothing here rewrites the owner's text.
 *
 * "Still true" (Today, since 2026-11-14) is a confirmation stored apart from
 * the text (`confirmedFacts` in the voice settings, keyed by `factKey`): a
 * fact is as old as the later of its own date and the day the person last
 * said it is still true. The words stay exactly as the person wrote them,
 * because the drafter reads them. A confirmation is for those words, so an
 * edit to the sentence drops it (`liveConfirmations`).
 *
 * What is read as a date, and what is not:
 *
 * - ISO ("2026-10-27"), month day year ("Oct 27 2026", "October 27th, 2026"),
 *   day month year ("27 October 2026"): that day.
 * - Month and year ("October 2026", "in Oct 2026"), a part of a month ("late
 *   September", "mid-October 2026") and "the week of Oct 26": a period. A
 *   period is dated by its FIRST day, the oldest the fact can be. The cost
 *   of asking "still true?" once too often is one quiet line; the cost of
 *   not asking is a stale number posted as current.
 * - A date with no year ("Oct 26", "26 October", "in October", "since late
 *   September") is the most recent past occurrence: this year's when that is
 *   today or earlier, else last year's. A fact is recorded after it
 *   happened, so the text is never read as a date still to come.
 * - "Oct 26" is the 26th, not the year 2026: a year is four digits.
 * - Not read, so never flagged: a slashed date ("03/04/2026" is March or
 *   April, depending on who wrote it), a date that does not exist ("Feb 30
 *   2026"), a bare year ("since 2019": a lasting fact, not a reading), a
 *   month with no word that makes it a date ("May" the verb), and anything
 *   relative ("last month" is relative to a day nobody recorded). A date
 *   that cannot be read with certainty is not guessed.
 */

/** A dated fact older than this many days is asked about. */
export const STALE_AFTER_DAYS = 30;

const DAY_MS = 86_400_000;

const MONTHS: ReadonlyArray<{ name: string; forms: string }> = [
  { name: "January", forms: "january|jan" },
  { name: "February", forms: "february|feb" },
  { name: "March", forms: "march|mar" },
  { name: "April", forms: "april|apr" },
  { name: "May", forms: "may" },
  { name: "June", forms: "june|jun" },
  { name: "July", forms: "july|jul" },
  { name: "August", forms: "august|aug" },
  { name: "September", forms: "september|sept|sep" },
  { name: "October", forms: "october|oct" },
  { name: "November", forms: "november|nov" },
  { name: "December", forms: "december|dec" },
];

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Every month form, longest first, with the full stop an abbreviation may carry. */
const MONTH = `(?:${MONTHS.map((m) => m.forms).join("|")})\\.?`;
const DAY = String.raw`(\d{1,2})(?:st|nd|rd|th)?`;
const YEAR = String.raw`((?:19|20)\d{2})`;

function monthIndex(word: string): number {
  const clean = word.toLowerCase().replace(/\.$/, "");
  return MONTHS.findIndex((m) => m.forms.split("|").includes(clean));
}

/** "May" and "may": only the capitalised one is the month when nothing else says so. */
function plainMay(word: string): boolean {
  return word.replace(/\.$/, "") === "may";
}

export type DatePrecision = "day" | "week" | "part" | "month";

export interface FactDate {
  /** The first day the text names, `YYYY-MM-DD` (UTC). */
  iso: string;
  precision: DatePrecision;
  /** As Settings prints it: "Oct 26, 2026", "October 2026", "late September 2026", "the week of Oct 26, 2026". */
  label: string;
  /** True when the text gave no year and the most recent past occurrence was taken. */
  yearAssumed: boolean;
  /** The words in the sentence that were read as this date. */
  text: string;
  /** Where those words sit in the sentence. */
  start: number;
  end: number;
}

export interface AboutYouFact {
  /** One sentence of About you, as written. */
  sentence: string;
  /** Its most recent date, or null when it carries none that can be read with certainty. */
  date: FactDate | null;
  /** The day (`YYYY-MM-DD`) the person last confirmed these words are still true; null when never. */
  confirmedOn: string | null;
  /**
   * Whole days from the later of that date and `confirmedOn` to `now`; null
   * with no date. Negative for a date still to come.
   */
  ageDays: number | null;
  /** True when the date is more than the threshold old. Never true without a date. */
  stale: boolean;
}

export interface StaleFact {
  sentence: string;
  /** The sentence's own date, `YYYY-MM-DD`: what a draft states the fact as of. */
  date: string;
  dateLabel: string;
  precision: DatePrecision;
  yearAssumed: boolean;
  /** The day it was last confirmed as still true (more than the threshold ago); null when never. */
  confirmedOn: string | null;
  /** Whole days since the later of `date` and `confirmedOn`. */
  ageDays: number;
  /** "15 days ago", "last month", "2 months ago". */
  age: string;
  /**
   * The line Settings shows: 'Dated Oct 26, 2026 (15 days ago): still true?',
   * or 'Dated October 2026, confirmed Nov 14, 2026 (31 days ago): still true?'.
   */
  line: string;
}

/**
 * "Still true" confirmations: a fact's key (`factKey`) to the day, as
 * `YYYY-MM-DD`, the person last said it is still true. Stored in the voice
 * settings (`confirmedFacts`), never in the text.
 */
export type FactConfirmations = Readonly<Record<string, string>>;

/**
 * Which fact a confirmation is for: the sentence's words, the spacing
 * collapsed, case and end punctuation ignored. Change a word, a number or a
 * date and it is another fact, which nobody has confirmed.
 */
export function factKey(sentence: string): string {
  return sentence.replace(/\s+/g, " ").trim().replace(/[.!?;]+$/, "").trimEnd().toLowerCase();
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The confirmation of these words, if there is one that reads as a day. */
export function confirmationOf(sentence: string, confirmations: FactConfirmations): string | null {
  const key = factKey(sentence);
  const stored = Object.hasOwn(confirmations, key) ? confirmations[key] : undefined;
  return stored && ISO_DAY.test(stored) && !Number.isNaN(Date.parse(stored)) ? stored : null;
}

/** Only the confirmations of sentences About you still has: a removed or edited fact takes its own with it. */
export function liveConfirmations(aboutYou: string, confirmations: FactConfirmations): Record<string, string> {
  const keys = new Set(factSentences(aboutYou).map(factKey));
  return Object.fromEntries(Object.entries(confirmations).filter(([key]) => keys.has(key)));
}

function utcDay(year: number, month: number, day: number): number | null {
  const at = Date.UTC(year, month, day);
  const date = new Date(at);
  // Date.UTC rolls "Feb 30" into March: a date that does not exist is not a date.
  return date.getUTCFullYear() === year && date.getUTCMonth() === month && date.getUTCDate() === day ? at : null;
}

function today(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

/** The most recent occurrence of a month and day on or before `now`; null when there is none in eight years. */
function mostRecent(month: number, day: number, now: Date): number | null {
  const limit = today(now);
  for (let year = now.getUTCFullYear(); year > now.getUTCFullYear() - 8; year--) {
    const at = utcDay(year, month, day);
    if (at !== null && at <= limit) return at;
  }
  return null;
}

function isoOf(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

function dayLabel(at: number): string {
  const date = new Date(at);
  return `${SHORT_MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

/** "Nov 14, 2026" for a `YYYY-MM-DD`: how a confirmation is printed. */
export function confirmationLabel(iso: string): string {
  return dayLabel(Date.parse(`${iso}T00:00:00Z`));
}

function monthLabel(at: number): string {
  const date = new Date(at);
  return `${MONTHS[date.getUTCMonth()].name} ${date.getUTCFullYear()}`;
}

const PART_START: Record<string, number> = { early: 1, mid: 11, late: 21 };

type Found = Omit<FactDate, "start" | "end" | "text">;

interface Reader {
  pattern: RegExp;
  read(match: RegExpExecArray, now: Date): Found | null;
}

const day = (at: number | null, yearAssumed: boolean): Found | null =>
  at === null ? null : { iso: isoOf(at), precision: "day", label: dayLabel(at), yearAssumed };

/**
 * The forms, most specific first. What one reads is taken out of the text
 * before the next looks, so "October 27, 2026" is never also "October 27"
 * and "October 2026" is never "October 20".
 */
const READERS: Reader[] = [
  {
    // 2026-10-27
    pattern: /(?<![\d/-])((?:19|20)\d{2})-(\d{2})-(\d{2})(?![\d/-])/g,
    read: (m) => day(utcDay(Number(m[1]), Number(m[2]) - 1, Number(m[3])), false),
  },
  {
    // the week of Oct 26, the week of October 26 2026
    pattern: new RegExp(String.raw`\b(?:the )?week of (${MONTH}) ${DAY}(?!\d)(?:,? ${YEAR})?(?!\d)`, "gi"),
    read: (m, now) => {
      const month = monthIndex(m[1]);
      const at = m[3] ? utcDay(Number(m[3]), month, Number(m[2])) : mostRecent(month, Number(m[2]), now);
      return at === null ? null : { iso: isoOf(at), precision: "week", label: `the week of ${dayLabel(at)}`, yearAssumed: !m[3] };
    },
  },
  {
    // Oct 27 2026, October 27th, 2026
    pattern: new RegExp(String.raw`\b(${MONTH}) ${DAY},? ${YEAR}(?!\d)`, "gi"),
    read: (m) => day(utcDay(Number(m[3]), monthIndex(m[1]), Number(m[2])), false),
  },
  {
    // 27 Oct 2026, 27th of October 2026
    pattern: new RegExp(String.raw`(?<![\d.,/])${DAY} (?:of )?(${MONTH}),? ${YEAR}(?!\d)`, "gi"),
    read: (m) => day(utcDay(Number(m[3]), monthIndex(m[2]), Number(m[1])), false),
  },
  {
    // late September 2026, mid-October 2026, October 2026
    pattern: new RegExp(String.raw`\b(?:(early|mid|late)[ -])?(${MONTH}),? ${YEAR}(?!\d)`, "gi"),
    read: (m) => {
      const at = utcDay(Number(m[3]), monthIndex(m[2]), m[1] ? PART_START[m[1].toLowerCase()] : 1);
      if (at === null) return null;
      return m[1]
        ? { iso: isoOf(at), precision: "part", label: `${m[1].toLowerCase()} ${monthLabel(at)}`, yearAssumed: false }
        : { iso: isoOf(at), precision: "month", label: monthLabel(at), yearAssumed: false };
    },
  },
  {
    // Oct 26, October 26th: the day, in its most recent year.
    pattern: new RegExp(String.raw`\b(${MONTH}) ${DAY}(?![\d%+]|\.\d|,\d)`, "gi"),
    read: (m, now) => (plainMay(m[1]) ? null : day(mostRecent(monthIndex(m[1]), Number(m[2]), now), true)),
  },
  {
    // 26 October, the 26th of October
    pattern: new RegExp(String.raw`(?<![\d.,/])${DAY} (?:of )?(${MONTH})(?![\p{L}\d])`, "giu"),
    read: (m, now) => (plainMay(m[2]) ? null : day(mostRecent(monthIndex(m[2]), Number(m[1]), now), true)),
  },
  {
    // since late September, in early March
    pattern: new RegExp(String.raw`\b(early|mid|late)[ -](${MONTH})(?![\p{L}\d])`, "giu"),
    read: (m, now) => {
      const at = mostRecent(monthIndex(m[2]), PART_START[m[1].toLowerCase()], now);
      return at === null ? null : { iso: isoOf(at), precision: "part", label: `${m[1].toLowerCase()} ${monthLabel(at)}`, yearAssumed: true };
    },
  },
  {
    // in October, since September: a month alone is a date only after a word
    // that makes it one. "by" and "until" are left out: they name a goal.
    pattern: new RegExp(
      String.raw`\b(?:in|since|during|from|through|throughout|(?:as|end|start|beginning) of|last|this)\s+(${MONTH})(?![\p{L}\d])`,
      "giu"
    ),
    read: (m, now) => {
      if (plainMay(m[1])) return null;
      const at = mostRecent(monthIndex(m[1]), 1, now);
      return at === null ? null : { iso: isoOf(at), precision: "month", label: monthLabel(at), yearAssumed: true };
    },
  },
];

/** Every date a sentence carries that can be read with certainty, in the order they are written. */
export function datesIn(sentence: string, now: Date): FactDate[] {
  let rest = sentence;
  const found: FactDate[] = [];
  for (const reader of READERS) {
    const pattern = new RegExp(reader.pattern.source, reader.pattern.flags);
    let match: RegExpExecArray | null;
    const taken: Array<[number, number]> = [];
    while ((match = pattern.exec(rest))) {
      const date = reader.read(match, now);
      if (date) {
        found.push({ ...date, text: match[0], start: match.index, end: match.index + match[0].length });
        taken.push([match.index, match.index + match[0].length]);
      }
    }
    // Same length, so an index into `rest` stays an index into the sentence.
    for (const [from, to] of taken) rest = `${rest.slice(0, from)}${"\u0000".repeat(to - from)}${rest.slice(to)}`;
  }
  return found.sort((a, b) => a.start - b.start);
}

const ABBREVIATED_MONTH = new RegExp(String.raw`\b(?:${MONTHS.map((m) => m.forms).join("|")})\.$`, "i");

/**
 * About you as sentences: split on a full stop, a question or exclamation
 * mark, a semicolon or a line break. A colon keeps its two halves together,
 * because "Co-founded X, a tool for Y: 12 paying stores" is one fact. "Oct.
 * 26" is not the end of a sentence.
 */
export function factSentences(aboutYou: string): string[] {
  const parts = aboutYou
    .split(/\n+|(?<=[.!?;])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const sentences: string[] = [];
  for (const part of parts) {
    const last = sentences[sentences.length - 1];
    if (last !== undefined && ABBREVIATED_MONTH.test(last) && /^\d/.test(part)) {
      sentences[sentences.length - 1] = `${last} ${part}`;
    } else {
      sentences.push(part);
    }
  }
  return sentences;
}

function monthsBetween(from: number, to: number): number {
  const a = new Date(from);
  const b = new Date(to);
  return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
}

/** How long ago, in the unit the date was given in: days for a day (and a confirmation, which is a day), months for a month. */
function ageText(date: FactDate, ageDays: number, now: Date, confirmed: boolean): string {
  if (confirmed || date.precision === "day" || date.precision === "week") return ageDays === 1 ? "1 day ago" : `${ageDays} days ago`;
  const months = monthsBetween(Date.parse(date.iso), today(now));
  return months <= 0 ? "this month" : months === 1 ? "last month" : `${months} months ago`;
}

export interface StalenessOptions {
  /** "Still true" confirmations (`confirmedFacts`); none when absent. */
  confirmations?: FactConfirmations;
  staleAfterDays?: number;
}

/**
 * Every sentence of About you with its most recent date, its age, and
 * whether it is stale. The age runs from the later of the sentence's own
 * date and the day the person confirmed those words are still true. A
 * sentence with no date is never stale, confirmed or not.
 */
export function aboutYouFacts(aboutYou: string, now: Date, options: StalenessOptions = {}): AboutYouFact[] {
  const staleAfterDays = options.staleAfterDays ?? STALE_AFTER_DAYS;
  const confirmations = options.confirmations ?? {};
  return factSentences(aboutYou).map((sentence) => {
    const confirmedOn = confirmationOf(sentence, confirmations);
    const dates = datesIn(sentence, now);
    if (dates.length === 0) return { sentence, date: null, confirmedOn, ageDays: null, stale: false };
    const date = dates.reduce((latest, candidate) => (candidate.iso > latest.iso ? candidate : latest));
    const asOf = confirmedOn && confirmedOn > date.iso ? confirmedOn : date.iso;
    const ageDays = Math.round((today(now) - Date.parse(asOf)) / DAY_MS);
    return { sentence, date, confirmedOn, ageDays, stale: ageDays > staleAfterDays };
  });
}

/** The sentence, short enough to quote on one line of a phone. */
export function quoteShort(sentence: string, max = 60): string {
  const clean = sentence.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

/** The stale sentences of About you, as Settings, the API and a draft are told them. */
export function staleFacts(aboutYou: string, now: Date, options: StalenessOptions = {}): StaleFact[] {
  const stale: StaleFact[] = [];
  for (const fact of aboutYouFacts(aboutYou, now, options)) {
    if (!fact.stale || !fact.date || fact.ageDays === null) continue;
    // A confirmation counts only when it is later than the text's own date.
    const confirmedOn = fact.confirmedOn && fact.confirmedOn > fact.date.iso ? fact.confirmedOn : null;
    const age = ageText(fact.date, fact.ageDays, now, confirmedOn !== null);
    stale.push({
      sentence: fact.sentence,
      date: fact.date.iso,
      dateLabel: fact.date.label,
      precision: fact.date.precision,
      yearAssumed: fact.date.yearAssumed,
      confirmedOn,
      ageDays: fact.ageDays,
      age,
      line: confirmedOn
        ? `Dated ${fact.date.label}, confirmed ${confirmationLabel(confirmedOn)} (${age}): still true?`
        : `Dated ${fact.date.label} (${age}): still true?`,
    });
  }
  return stale;
}
