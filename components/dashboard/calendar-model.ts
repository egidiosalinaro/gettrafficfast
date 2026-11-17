import type { Article } from "./article-card";
import { formatDay, parseDay } from "@/components/visibility/primitives";

/**
 * What the Articles board shows, as pure functions of the articles and today,
 * so the month range and the phone list are tested without a browser.
 *
 * The board is the production board, not an archive: everything still to be
 * written or published, plus what went live recently. Older published work is
 * on Results, where it is measured.
 */

/** Published articles stay on the board this long after their day. */
export const PUBLISHED_LOOKBACK_DAYS = 30;

/** Local calendar day, "YYYY-MM-DD". */
export function dayKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The article's day as "YYYY-MM-DD", or null when it has none. */
export function articleDay(article: Pick<Article, "scheduledDate">): string | null {
  const raw = article.scheduledDate;
  if (!raw) return null;
  if (typeof raw === "string" && /^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const date = parseDay(raw);
  return date ? dayKey(date) : null;
}

function daysBefore(today: Date, days: number): string {
  return dayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - days));
}

export interface MonthRef {
  year: number;
  /** 0 to 11. */
  month: number;
}

/**
 * A month drawn as a grid, or a run of consecutive months with nothing in
 * them, drawn as one line. Empty months are not drawn as empty grids: six
 * blank months read as a schedule that does not exist.
 */
export type MonthBlock =
  | ({ kind: "month"; count: number; current: boolean } & MonthRef)
  | { kind: "empty"; from: MonthRef; to: MonthRef };

function monthOf(day: string): MonthRef {
  return { year: Number(day.slice(0, 4)), month: Number(day.slice(5, 7)) - 1 };
}

function monthIndex(ref: MonthRef): number {
  return ref.year * 12 + ref.month;
}

/**
 * The months the grid draws. It starts at the earliest of the oldest article
 * not yet published and the oldest published in the last
 * `PUBLISHED_LOOKBACK_DAYS`, and never after this month; it ends at the last
 * article, and never before this month. A month with articles is a grid; the
 * current month is always a grid, so today is visible and a card has
 * somewhere to be dropped; every other empty month collapses.
 */
export function calendarMonths(
  articles: readonly Article[],
  today: Date,
  lookbackDays = PUBLISHED_LOOKBACK_DAYS
): MonthBlock[] {
  const todayDay = dayKey(today);
  const cutoff = daysBefore(today, lookbackDays);

  let start = todayDay;
  for (const article of articles) {
    const day = articleDay(article);
    if (!day) continue;
    const inRange = article.status !== "published" || day >= cutoff;
    if (inRange && day < start) start = day;
  }

  const counts = new Map<number, number>();
  let end = todayDay;
  for (const article of articles) {
    const day = articleDay(article);
    if (!day || day.slice(0, 7) < start.slice(0, 7)) continue;
    const index = monthIndex(monthOf(day));
    counts.set(index, (counts.get(index) ?? 0) + 1);
    if (day > end) end = day;
  }

  const current = monthIndex(monthOf(todayDay));
  const blocks: MonthBlock[] = [];
  for (let index = monthIndex(monthOf(start)); index <= monthIndex(monthOf(end)); index++) {
    const ref = { year: Math.floor(index / 12), month: index % 12 };
    const count = counts.get(index) ?? 0;
    if (count > 0 || index === current) {
      blocks.push({ kind: "month", ...ref, count, current: index === current });
      continue;
    }
    const last = blocks[blocks.length - 1];
    if (last?.kind === "empty") last.to = ref;
    else blocks.push({ kind: "empty", from: ref, to: ref });
  }
  return blocks;
}

export interface DayGroup {
  /** "YYYY-MM-DD", or "" for articles with no day. */
  day: string;
  articles: Article[];
}

export interface CalendarListSections {
  /** Not published yet, oldest day first: what needs doing, in order. */
  upcoming: DayGroup[];
  /** Published in the last `PUBLISHED_LOOKBACK_DAYS`, newest first. */
  published: DayGroup[];
}

function groupByDay(articles: Article[]): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const article of articles) {
    const day = articleDay(article) ?? "";
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.articles.push(article);
    else groups.push({ day, articles: [article] });
  }
  return groups;
}

/**
 * The phone view: a list grouped by day instead of a seven-column grid,
 * upcoming work first, then what went live recently.
 */
export function calendarList(
  articles: readonly Article[],
  today: Date,
  lookbackDays = PUBLISHED_LOOKBACK_DAYS
): CalendarListSections {
  const cutoff = daysBefore(today, lookbackDays);
  // Undated rows sort last, whatever the direction.
  const ascending = (a: Article, b: Article) =>
    (articleDay(a) ?? "9999").localeCompare(articleDay(b) ?? "9999");

  const upcoming = articles.filter((a) => a.status !== "published").sort(ascending);
  const published = articles
    .filter((a) => {
      if (a.status !== "published") return false;
      const day = articleDay(a);
      return day !== null && day >= cutoff;
    })
    .sort((a, b) => ascending(b, a));

  return { upcoming: groupByDay(upcoming), published: groupByDay(published) };
}

/** "Today", "Tomorrow", "Yesterday", else "Tue, Nov 10". */
export function dayHeading(day: string, today: Date, locale?: string): string {
  if (!day) return "No date";
  if (day === dayKey(today)) return "Today";
  if (day === daysBefore(today, -1)) return "Tomorrow";
  if (day === daysBefore(today, 1)) return "Yesterday";
  return formatDay(day, { weekday: true, now: today, locale });
}

/**
 * The date as it applies to this article. A published article's day is the
 * day it went out ("Published Nov 2"); one published ahead of its slot says
 * so instead of claiming a future date. Everything else is still scheduled.
 */
export function articleDateLine(
  article: Pick<Article, "scheduledDate" | "status">,
  today: Date,
  locale?: string
): string {
  const day = articleDay(article);
  if (!day) return article.status === "published" ? "Published" : "Not scheduled";
  const when = formatDay(day, { now: today, locale });
  if (article.status === "published") {
    return day > dayKey(today) ? `Published early, was scheduled for ${when}` : `Published ${when}`;
  }
  return `Scheduled for ${when}`;
}
