/**
 * The date a search engine shows beside a result, read honestly.
 *
 * An engine prints either a calendar day ("Jun 6, 2025", "6 giu 2025",
 * "06.06.2025") or a distance ("4 months ago", "vor 4 Monaten"). A distance
 * is not an instant: "4 months ago" means at least four months and less than
 * five. So the parser returns the LATEST instant the page can have been
 * published at, and how wide the interval before it is. Whoever ages the
 * page from that value gets a lower bound on its age — a rule that rejects
 * "older than six months" can never fire on a page that is not — and
 * whoever shows the date knows not to print a day the engine never gave.
 *
 * Languages: the ones the SERP provider searches in (en, it, es, fr, de).
 * Anything else stays null: an unknown date is unknown, never "today".
 */

/** How wide the interval before `at` is; `day` for a calendar date. */
export type DatePrecision = "day" | "week" | "month" | "year";

export interface EngineDate {
  /** ISO instant: the day itself for a calendar date, the latest possible moment for a distance. */
  at: string;
  precision: DatePrecision;
}

const MONTHS: Record<string, number> = {};
const MONTH_NAMES: Array<[string, number]> = [
  // en
  ["january", 1], ["february", 2], ["march", 3], ["april", 4], ["may", 5], ["june", 6],
  ["july", 7], ["august", 8], ["september", 9], ["october", 10], ["november", 11], ["december", 12],
  ["sept", 9],
  // it
  ["gennaio", 1], ["febbraio", 2], ["marzo", 3], ["aprile", 4], ["maggio", 5], ["giugno", 6],
  ["luglio", 7], ["agosto", 8], ["settembre", 9], ["ottobre", 10], ["novembre", 11], ["dicembre", 12],
  ["gen", 1], ["feb", 2], ["mar", 3], ["apr", 4], ["mag", 5], ["giu", 6], ["lug", 7], ["ago", 8], ["set", 9], ["ott", 10], ["nov", 11], ["dic", 12],
  // es
  ["enero", 1], ["febrero", 2], ["abril", 4], ["mayo", 5], ["junio", 6], ["julio", 7],
  ["septiembre", 9], ["setiembre", 9], ["octubre", 10], ["noviembre", 11], ["diciembre", 12],
  ["ene", 1], ["abr", 4], ["jun", 6], ["jul", 7], ["sep", 9], ["oct", 10],
  // fr
  ["janvier", 1], ["février", 2], ["fevrier", 2], ["mars", 3], ["avril", 4], ["mai", 5], ["juin", 6],
  ["juillet", 7], ["août", 8], ["aout", 8], ["septembre", 9], ["octobre", 10], ["novembre", 11], ["décembre", 12], ["decembre", 12],
  ["janv", 1], ["févr", 2], ["fevr", 2], ["avr", 4], ["juil", 7], ["déc", 12],
  // de
  ["januar", 1], ["februar", 2], ["märz", 3], ["maerz", 3], ["juni", 6], ["juli", 7],
  ["oktober", 10], ["dezember", 12],
  ["jan", 1], ["mär", 3], ["okt", 10], ["dez", 12],
  // en abbreviations last so they win nothing they should not
  ["aug", 8], ["dec", 12],
];
for (const [name, month] of MONTH_NAMES) MONTHS[name] = month;

function monthOf(word: string): number | null {
  const key = word.toLowerCase().replace(/\.$/, "");
  if (MONTHS[key]) return MONTHS[key];
  // A three-letter-or-longer prefix of a full name: "Sept", "settem".
  if (key.length >= 3) {
    const hits = new Set(
      Object.entries(MONTHS)
        .filter(([name]) => name.startsWith(key))
        .map(([, m]) => m)
    );
    if (hits.size === 1) return [...hits][0];
  }
  return null;
}

function calendarDay(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 2000 || year > 2100) return null;
  const at = new Date(Date.UTC(year, month - 1, day));
  if (at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) return null;
  return at.toISOString();
}

/** "Jun 6, 2025" · "6 Jun 2025" · "6 giu 2025" · "6. Juni 2025" · "06.06.2025" · "2025-06-06" */
function parseCalendar(text: string): string | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (iso) return calendarDay(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const dotted = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(text);
  if (dotted) return calendarDay(Number(dotted[3]), Number(dotted[2]), Number(dotted[1]));

  const monthFirst = /^([\p{L}.]+)\s+(\d{1,2}),?\s+(\d{4})$/u.exec(text);
  if (monthFirst) {
    const month = monthOf(monthFirst[1]);
    return month ? calendarDay(Number(monthFirst[3]), month, Number(monthFirst[2])) : null;
  }

  const dayFirst = /^(\d{1,2})\.?\s+(?:de\s+)?([\p{L}.]+)\.?\s+(?:de\s+)?(\d{4})$/u.exec(text);
  if (dayFirst) {
    const month = monthOf(dayFirst[2]);
    return month ? calendarDay(Number(dayFirst[3]), month, Number(dayFirst[1])) : null;
  }
  return null;
}

type Unit = "hour" | "day" | "week" | "month" | "year";

const UNIT_WORDS: Array<[RegExp, Unit]> = [
  [/^(hours?|hrs?|or[ae]|horas?|heures?|stunden?)$/i, "hour"],
  [/^(days?|giorn[oi]|d[ií]as?|jours?|tag(e|en)?)$/i, "day"],
  [/^(weeks?|wks?|settiman[ae]|semanas?|semaines?|wochen?)$/i, "week"],
  [/^(months?|mos?|mes[ei]|meses|mois|monat(e|en)?)$/i, "month"],
  [/^(years?|yrs?|ann[oi]|años?|anos?|ans?|années?|jahr(e|en)?)$/i, "year"],
];

/** "4 months ago" · "4 mesi fa" · "hace 4 meses" · "il y a 4 mois" · "vor 4 Monaten" */
function parseDistance(text: string): { amount: number; unit: Unit } | null {
  const lower = text.toLowerCase();
  if (/^(yesterday|ieri|ayer|hier|gestern)$/.test(lower)) return { amount: 1, unit: "day" };
  if (/^(today|oggi|hoy|aujourd'hui|heute)$/.test(lower)) return { amount: 0, unit: "day" };
  const match =
    /^(?:hace\s+|il y a\s+|vor\s+)?(\d{1,3}|an?|un[ao]?|une|ein(?:em|er)?)\s+([\p{L}]+)(?:\s+(?:ago|fa))?$/u.exec(lower);
  if (!match) return null;
  const amount = /^\d/.test(match[1]) ? Number(match[1]) : 1;
  const unit = UNIT_WORDS.find(([pattern]) => pattern.test(match[2]))?.[1];
  return unit ? { amount, unit } : null;
}

function minusUnits(now: Date, amount: number, unit: Unit): Date {
  const at = new Date(now.getTime());
  switch (unit) {
    case "hour":
      at.setUTCHours(at.getUTCHours() - amount);
      return at;
    case "day":
      at.setUTCDate(at.getUTCDate() - amount);
      return at;
    case "week":
      at.setUTCDate(at.getUTCDate() - amount * 7);
      return at;
    case "month":
      at.setUTCMonth(at.getUTCMonth() - amount);
      return at;
    case "year":
      at.setUTCFullYear(at.getUTCFullYear() - amount);
      return at;
  }
}

const PRECISION_OF_UNIT: Record<Unit, DatePrecision> = {
  hour: "day",
  day: "day",
  week: "week",
  month: "month",
  year: "year",
};

/**
 * The engine's date string, as the latest instant it allows and how much
 * earlier the page may really be. `now` is when the engine was asked: a
 * distance only means something relative to that moment.
 */
export function parseEngineDate(raw: string | null | undefined, now: Date): EngineDate | null {
  const text = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;

  const day = parseCalendar(text);
  if (day) return { at: day, precision: "day" };

  const distance = parseDistance(text);
  if (distance) {
    const at = minusUnits(now, distance.amount, distance.unit);
    if (!Number.isFinite(at.getTime())) return null;
    return { at: at.toISOString(), precision: PRECISION_OF_UNIT[distance.unit] };
  }
  return null;
}
