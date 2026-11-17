/**
 * How dates and numbers read on screen.
 *
 * The product is in English, so every date and number is formatted in one
 * fixed locale, never the browser's: with the device's own locale an Italian
 * phone printed "lun 2 nov" and "1.234" inside an English interface. Pure,
 * so the lifecycle copy and the components share one formatter.
 */

/** The one locale the interface is written in. */
export const UI_LOCALE = "en-US";

/**
 * A calendar day as a person reads it: "Nov 2", with the year only when it
 * is not this year ("Dec 30, 2025"), and "Mon, Nov 2" with the weekday.
 *
 * A bare `YYYY-MM-DD` is a day, not an instant: it is read as that local day,
 * so no timezone can move it to the day before.
 */
export interface DayFormat {
  /** Prefix the short weekday: "Mon, Nov 2". */
  weekday?: boolean;
  /** "auto" (default) shows the year only when it differs from `now`'s. */
  year?: "auto" | "always" | "never";
  /** BCP 47 tag; defaults to `UI_LOCALE`. */
  locale?: string;
  now?: Date;
}

export function parseDay(value: string | Date | null | undefined): Date | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (!value) return null;
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (day) return new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function formatDay(value: string | Date | null | undefined, options: DayFormat = {}): string {
  const date = parseDay(value);
  if (!date) return "—";
  const now = options.now ?? new Date();
  const year = options.year ?? "auto";
  const withYear = year === "always" || (year === "auto" && date.getFullYear() !== now.getFullYear());
  return new Intl.DateTimeFormat(options.locale ?? UI_LOCALE, {
    ...(options.weekday ? { weekday: "short" as const } : {}),
    day: "numeric",
    month: "short",
    ...(withYear ? { year: "numeric" as const } : {}),
  }).format(date);
}

/** A count with thousands separators: "1,234". */
export function formatCount(value: number): string {
  return value.toLocaleString(UI_LOCALE);
}

/**
 * A Google position, or a change in one, to the one decimal it is worth.
 *
 * Search Console reports an average position per day ("51.75"), and the
 * difference of two of them is a float ("15.049999999999997"). Neither
 * precision means anything to a reader or to an agent. Half away from zero,
 * so a climb and a slip of the same size round the same way, and never -0.
 */
export function roundPosition(value: number): number {
  const rounded = (Math.sign(value) * Math.round(Math.abs(value) * 10)) / 10;
  return rounded === 0 ? 0 : rounded;
}

/** A position as it reads: "10", "51.8", never "51.75" or "10.0". */
export function formatPosition(position: number): string {
  return roundPosition(position).toLocaleString(UI_LOCALE, { maximumFractionDigits: 1 });
}

/**
 * A change in position as the screens draw it. Positive is up the page.
 * Null is no change at all (one side was never measured, or not ranking);
 * a change that rounds to 0 is "unchanged", not an arrow over "0".
 */
export type PositionChange =
  | { direction: "none" }
  | { direction: "unchanged" }
  | { direction: "up" | "down"; amount: string };

export function positionChange(delta: number | null | undefined): PositionChange {
  if (delta === null || delta === undefined || !Number.isFinite(delta)) return { direction: "none" };
  const rounded = roundPosition(delta);
  if (rounded === 0) return { direction: "unchanged" };
  return { direction: rounded > 0 ? "up" : "down", amount: formatPosition(Math.abs(rounded)) };
}

/**
 * Below this many probes on one engine, a citation or visibility rate is
 * shown as a count ("0 of 3"), not as a percent. Answer engines are not
 * deterministic, and "0%" over three probes reads like a verdict when it is
 * mostly noise. The threshold is on the rate's own denominator: probes for
 * an article's citations, readable answers for AI Visibility. Only what is
 * shown changes: the stored rate and the API's numbers stay as they are.
 */
export const MIN_PROBES_FOR_PERCENT = 10;

/** Whether a rate over this many probes is shown as a percent. */
export function rateIsPercent(probes: number): boolean {
  return probes >= MIN_PROBES_FOR_PERCENT;
}

/**
 * A sampled rate as the screens show it, one engine at a time: null over no
 * probes (the caller says "not measured", never 0), "0 of 3" (cited of
 * probes) below `MIN_PROBES_FOR_PERCENT`, "20%" from it. A rate that is not
 * zero never rounds to "0%" (cited once in 300 is "<1%"), and one that is not
 * every probe never rounds to "100%".
 */
export function formatRate(cited: number, probes: number): string | null {
  if (!(probes > 0)) return null;
  if (!rateIsPercent(probes)) return `${formatCount(cited)} of ${formatCount(probes)}`;
  const percent = Math.round((cited / probes) * 100);
  if (percent === 0 && cited > 0) return "<1%";
  if (percent === 100 && cited < probes) return ">99%";
  return `${percent}%`;
}
