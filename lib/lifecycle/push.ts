import { formatDay, roundPosition } from "@/lib/format";
import { keywordTokens, wordSimilarity } from "@/lib/keywords/duplicates";

/**
 * Push page 3 (docs/LIFECYCLE.md, "Push page 3"), the pure half.
 *
 * An article that Google shows on pages 2 to 4 (average position 11 to 40)
 * is not failing: it is on the normal curve. What moves it, in an SEO
 * expert's words to the owner on 2026-11-15, is "internal links from your
 * best pages + tighter titles". This file decides, from stored Search
 * Console numbers only:
 *
 * - which articles are candidates this week (`selectPushCandidates`);
 * - which search an article is stuck on (`chooseMainQuery`);
 * - which of the site's pages link to it (`chooseSourcePages`);
 * - whether a proposed title and description are acceptable
 *   (`checkMetaTitle`, `checkMetaDescription`);
 * - the windows a push is measured over, and the line Growth prints.
 *
 * No I/O, no model, no clock but the one passed in.
 */

/** Google's pages 2 to 4: an average position in this band is a candidate. */
export const PUSH_MIN_POSITION = 11;
export const PUSH_MAX_POSITION = 40;
/** The baseline window, and the window the candidate rule reads. */
export const PUSH_WINDOW_DAYS = 28;
/**
 * Under this many impressions in 28 days, an average position is a handful
 * of searches: not evidence enough to change a page for.
 */
export const PUSH_MIN_IMPRESSIONS = 50;
/** An article pushed (or skipped, or proposed) less than this long ago is not looked at again. */
export const PUSH_COOLDOWN_DAYS = 28;
/** An article whose document changed less than this long ago has no clean baseline. */
export const PUSH_QUIET_DAYS = 14;
/** At most this many pushes per site per weekly sweep. */
export const PUSHES_PER_SITE_PER_WEEK = 3;
/** The main query needs at least this many impressions over the window to be "clear". */
export const MIN_MAIN_QUERY_IMPRESSIONS = 10;
/** Pages that get a link to the pushed article. */
export const PUSH_SOURCES_MAX = 3;
/** Under this word similarity, a page that shares no graph node is not close enough to link from. */
export const MIN_SOURCE_SIMILARITY = 0.15;
/** After-values are computed at these offsets from the day the push went live. */
export const PUSH_MEASURE_DAYS = [14, 28] as const;

const DAY_MS = 86_400_000;

export const dayOf = (iso: string): string => iso.slice(0, 10);
export function addDays(day: string, days: number): string {
  return new Date(new Date(`${day}T00:00:00Z`).getTime() + days * DAY_MS).toISOString().slice(0, 10);
}
const daysBetween = (from: string, to: string): number =>
  Math.round((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / DAY_MS);

// ── Windows ────────────────────────────────────────────────────────────────

export interface MetricDay {
  capturedOn: string;
  impressions: number;
  clicks: number;
  /** Google's average for that day; meaningless without impressions. */
  position: number | null;
}

export interface WindowStats {
  start: string;
  end: string;
  days: number;
  /** Impression-weighted, one decimal; null with no impression in the window. */
  position: number | null;
  impressions: number;
  clicks: number;
}

/**
 * Search Console numbers for `start..end` (inclusive): clicks and
 * impressions summed, the position weighted by impressions as Search
 * Console averages it. A day with no row inside the ingested range is a real
 * zero; a window with no impression has no position (null), never 0.
 */
export function windowStats(points: readonly MetricDay[], start: string, end: string): WindowStats {
  let impressions = 0;
  let clicks = 0;
  let weighted = 0;
  for (const point of points) {
    if (point.capturedOn < start || point.capturedOn > end) continue;
    impressions += point.impressions;
    clicks += point.clicks;
    if (point.position !== null && point.impressions > 0) weighted += point.position * point.impressions;
  }
  return {
    start,
    end,
    days: daysBetween(start, end) + 1,
    position: impressions > 0 ? roundPosition(weighted / impressions) : null,
    impressions,
    clicks,
  };
}

/** The 28 days ending on the newest settled day (the connection's watermark). */
export function baselineWindow(watermark: string): { start: string; end: string } {
  return { start: addDays(watermark, -(PUSH_WINDOW_DAYS - 1)), end: watermark };
}

// ── Candidates ─────────────────────────────────────────────────────────────

export interface PushCandidateInput {
  articleId: string;
  /** Live address; an article without one is not a candidate. */
  publishedUrl: string | null;
  /** Search Console days of this article. */
  metrics: readonly MetricDay[];
  /** When its last push row was written (any status), or null. */
  lastPushAt: string | null;
  /** When its document last changed: a refresh, an archived version, its first publication. */
  lastEditedAt: string | null;
  /** A refresh or a push job is queued or running for it. */
  busy?: boolean;
}

export type PushExclusion =
  | "not_live"
  | "no_impressions"
  | "too_few_impressions"
  | "outside_band"
  | "pushed_recently"
  | "edited_recently"
  | "busy"
  | "over_weekly_cap";

export const PUSH_EXCLUSION_TEXT: Record<PushExclusion, string> = {
  not_live: "not live on the site",
  no_impressions: "no Search Console impressions in 28 days",
  too_few_impressions: `fewer than ${PUSH_MIN_IMPRESSIONS} impressions in 28 days`,
  outside_band: `average position outside ${PUSH_MIN_POSITION} to ${PUSH_MAX_POSITION}`,
  pushed_recently: `pushed less than ${PUSH_COOLDOWN_DAYS} days ago`,
  edited_recently: `changed less than ${PUSH_QUIET_DAYS} days ago`,
  busy: "a refresh or a push is already running",
  over_weekly_cap: `the site's ${PUSHES_PER_SITE_PER_WEEK} pushes this week are taken`,
};

export interface PushCandidate {
  articleId: string;
  before: WindowStats;
}

/**
 * Whether one article may be pushed now, and its baseline. `ignoreBand`
 * (an on-demand push) skips the position band and the minimum impressions:
 * a person asking for one article decides that; the rules that keep the
 * measurement clean (live, some impressions, not pushed or changed lately,
 * nothing running) still hold.
 */
export function pushEligibility(
  input: PushCandidateInput,
  context: { watermark: string; now: Date; ignoreBand?: boolean }
): { ok: true; before: WindowStats } | { ok: false; reason: PushExclusion } {
  if (!input.publishedUrl) return { ok: false, reason: "not_live" };
  if (input.busy) return { ok: false, reason: "busy" };
  const nowMs = context.now.getTime();
  if (input.lastPushAt && nowMs - new Date(input.lastPushAt).getTime() < PUSH_COOLDOWN_DAYS * DAY_MS) {
    return { ok: false, reason: "pushed_recently" };
  }
  if (input.lastEditedAt && nowMs - new Date(input.lastEditedAt).getTime() < PUSH_QUIET_DAYS * DAY_MS) {
    return { ok: false, reason: "edited_recently" };
  }
  const window = baselineWindow(context.watermark);
  const before = windowStats(input.metrics, window.start, window.end);
  if (before.impressions === 0 || before.position === null) return { ok: false, reason: "no_impressions" };
  if (!context.ignoreBand) {
    if (before.impressions < PUSH_MIN_IMPRESSIONS) return { ok: false, reason: "too_few_impressions" };
    if (before.position < PUSH_MIN_POSITION || before.position > PUSH_MAX_POSITION) {
      return { ok: false, reason: "outside_band" };
    }
  }
  return { ok: true, before };
}

/**
 * This week's candidates for one site: eligible articles, the most
 * impressions first (the most searches to win), then the better position;
 * at most `cap`. Everything left out is returned with its reason.
 */
export function selectPushCandidates(params: {
  articles: readonly PushCandidateInput[];
  watermark: string;
  now: Date;
  cap?: number;
}): { candidates: PushCandidate[]; excluded: Array<{ articleId: string; reason: PushExclusion }> } {
  const cap = Math.max(0, Math.min(params.cap ?? PUSHES_PER_SITE_PER_WEEK, PUSHES_PER_SITE_PER_WEEK));
  const eligible: PushCandidate[] = [];
  const excluded: Array<{ articleId: string; reason: PushExclusion }> = [];
  for (const article of params.articles) {
    const verdict = pushEligibility(article, { watermark: params.watermark, now: params.now });
    if (verdict.ok) eligible.push({ articleId: article.articleId, before: verdict.before });
    else excluded.push({ articleId: article.articleId, reason: verdict.reason });
  }
  eligible.sort(
    (a, b) =>
      b.before.impressions - a.before.impressions ||
      (a.before.position ?? Infinity) - (b.before.position ?? Infinity) ||
      a.articleId.localeCompare(b.articleId)
  );
  for (const late of eligible.slice(cap)) excluded.push({ articleId: late.articleId, reason: "over_weekly_cap" });
  return { candidates: eligible.slice(0, cap), excluded };
}

// ── The main query ─────────────────────────────────────────────────────────

export interface QueryRow {
  query: string;
  impressions: number;
  clicks: number;
  position: number | null;
}

export type MainQueryChoice =
  | { ok: true; query: string; impressions: number; clicks: number; position: number | null }
  | { ok: false; reason: string };

/**
 * The search the article is pushed for: the query with the most impressions
 * for that page over the window, ties broken by clicks. "No clear query" is
 * a skip with its reason: no query rows, a top query under
 * `MIN_MAIN_QUERY_IMPRESSIONS`, or two queries tied on both.
 */
export function chooseMainQuery(rows: readonly QueryRow[]): MainQueryChoice {
  const usable = rows.filter((row) => row.query.trim().length >= 2 && row.impressions > 0);
  if (usable.length === 0) return { ok: false, reason: "Search Console reports no query for this page yet" };
  const sorted = [...usable].sort((a, b) => b.impressions - a.impressions || b.clicks - a.clicks);
  const [top, second] = sorted;
  if (top.impressions < MIN_MAIN_QUERY_IMPRESSIONS) {
    return { ok: false, reason: `no query reached ${MIN_MAIN_QUERY_IMPRESSIONS} impressions in 28 days` };
  }
  if (second && second.impressions === top.impressions && second.clicks === top.clicks) {
    return { ok: false, reason: `two queries tie ("${top.query}", "${second.query}")` };
  }
  return {
    ok: true,
    query: top.query.trim(),
    impressions: top.impressions,
    clicks: top.clicks,
    position: top.position === null ? null : roundPosition(top.position),
  };
}

// ── Source pages ───────────────────────────────────────────────────────────

export interface SourcePageInput {
  articleId: string;
  title: string;
  keyword: string;
  publishedUrl: string;
  /** Search Console over the same 28 days. */
  clicks: number;
  impressions: number;
  /** Shared graph nodes with the pushed article (`findRelatedArticles`); 0 when none. */
  graphScore: number;
  /** The page already links to the pushed article (body or Read next). */
  linksToTarget: boolean;
  busy?: boolean;
}

export interface ChosenSource extends SourcePageInput {
  closeness: number;
}

/**
 * The site's best pages that are close to the pushed article: live, other
 * than it, not already linking to it, seen on Google in the window
 * (impressions > 0), and related, through the knowledge graph or by words
 * (keyword and title against the article's keyword, title and main query,
 * Jaccard ≥ 0.15, the Read next rule's tokens). The most clicks first, then
 * impressions, then closeness. At most `PUSH_SOURCES_MAX`.
 */
export function chooseSourcePages(params: {
  target: { articleId: string; title: string; keyword: string; mainQuery: string };
  pages: readonly SourcePageInput[];
  max?: number;
}): ChosenSource[] {
  const max = Math.min(params.max ?? PUSH_SOURCES_MAX, PUSH_SOURCES_MAX);
  const mine = keywordTokens(`${params.target.keyword} ${params.target.title} ${params.target.mainQuery}`);
  const seen = new Set<string>();
  const chosen: ChosenSource[] = [];
  for (const page of params.pages) {
    if (page.articleId === params.target.articleId || seen.has(page.articleId)) continue;
    seen.add(page.articleId);
    if (!page.publishedUrl || page.linksToTarget || page.busy || page.impressions <= 0) continue;
    const words = wordSimilarity(mine, keywordTokens(`${page.keyword} ${page.title}`)).jaccard;
    if (page.graphScore <= 0 && words < MIN_SOURCE_SIMILARITY) continue;
    chosen.push({ ...page, closeness: page.graphScore + words });
  }
  return chosen
    .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions || b.closeness - a.closeness)
    .slice(0, max);
}

/**
 * Whether an anchor is the main query or a natural variant of it: at least
 * half of the query's content words (stemmed) are in the anchor, and the
 * anchor is 2 to 10 words.
 */
export function anchorFitsQuery(anchor: string, query: string): boolean {
  const words = anchor.trim().split(/\s+/).filter(Boolean).length;
  if (words < 2 || words > 10) return false;
  const wanted = keywordTokens(query);
  if (wanted.length === 0) return false;
  const have = new Set(keywordTokens(anchor));
  const shared = wanted.filter((token) => have.has(token)).length;
  return shared * 2 >= wanted.length;
}

// ── Title and description ─────────────────────────────────────────────────

export const META_TITLE_MIN = 20;
export const META_TITLE_MAX = 60;
export const META_DESCRIPTION_MIN = 70;
export const META_DESCRIPTION_MAX = 155;

/** Words that promise more than an article delivers. */
const CLICKBAIT = /\b(?:shocking|you won'?t believe|secret|insane|mind[- ]blowing|jaw[- ]dropping|guaranteed|miracle|hack(?:s)? nobody)\b/i;

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();
const fold = (text: string) => collapse(text).toLowerCase();

/** Figures a text states (digits only). */
function figures(text: string): string[] {
  return [...text.matchAll(/\d+(?:[.,]\d+)*/g)].map((m) => m[0]);
}

export type MetaCheck = { ok: true; text: string } | { ok: false; reason: string };

function checkMeta(
  kind: "title" | "description",
  proposed: string | null | undefined,
  context: { mainQuery: string; articleText: string; current: string | null; min: number; max: number }
): MetaCheck {
  const text = collapse(proposed ?? "");
  if (!text) return { ok: false, reason: `no ${kind} proposed` };
  if (/[<>]/.test(text)) return { ok: false, reason: `the ${kind} holds markup` };
  if (text.length < context.min) return { ok: false, reason: `the ${kind} is shorter than ${context.min} characters` };
  if (text.length > context.max) return { ok: false, reason: `the ${kind} is longer than ${context.max} characters` };
  if (!fold(text).includes(fold(context.mainQuery))) return { ok: false, reason: `the ${kind} does not contain the main query` };
  if (CLICKBAIT.test(text) || text.includes("!")) return { ok: false, reason: `the ${kind} reads as clickbait` };
  // No new claims: a figure the article never states cannot be promised.
  const known = new Set(figures(`${context.articleText} ${context.current ?? ""}`));
  const invented = figures(text).filter((figure) => !known.has(figure) && !/^20\d\d$/.test(figure));
  if (invented.length > 0) return { ok: false, reason: `the ${kind} states a figure the article does not (${invented[0]})` };
  if (context.current && fold(context.current) === fold(text)) return { ok: false, reason: `the ${kind} is unchanged` };
  return { ok: true, text };
}

/** A meta title for search results: 20 to 60 characters, the main query in it, no clickbait, no figure the article lacks. */
export function checkMetaTitle(proposed: string | null | undefined, context: { mainQuery: string; articleText: string; current: string | null }): MetaCheck {
  return checkMeta("title", proposed, { ...context, min: META_TITLE_MIN, max: META_TITLE_MAX });
}

/** A meta description: 70 to 155 characters, the main query in it, the same rules. */
export function checkMetaDescription(
  proposed: string | null | undefined,
  context: { mainQuery: string; articleText: string; current: string | null }
): MetaCheck {
  return checkMeta("description", proposed, { ...context, min: META_DESCRIPTION_MIN, max: META_DESCRIPTION_MAX });
}

// ── Measuring ──────────────────────────────────────────────────────────────

/**
 * The window measured `days` after a push went live: the `days` days after
 * the day it was applied. Due only once Search Console's data covers its
 * last day (the watermark); before that it is not measured, never guessed.
 */
export function afterWindow(appliedAt: string, days: number): { start: string; end: string } {
  const applied = dayOf(appliedAt);
  return { start: addDays(applied, 1), end: addDays(applied, days) };
}

export function measurementDue(appliedAt: string | null, days: number, watermark: string | null): boolean {
  if (!appliedAt || !watermark) return false;
  return afterWindow(appliedAt, days).end <= watermark;
}

export interface PushSummaryInput {
  status: string;
  createdAt: string;
  appliedAt: string | null;
  beforePosition: number | null;
  after14: { position: number | null } | null;
  after28: { position: number | null } | null;
}

/**
 * The line Growth's By article prints under an article:
 * "Pushed Nov 16: 37 → 29", "Pushed Nov 16: no change yet",
 * "Pushed Nov 16: not measured yet", "Proposed Nov 16: not applied yet".
 * Positions are whole places; the newest after-value is the one compared.
 * Null for a push that changed nothing (skipped, failed, dismissed).
 */
export function pushLine(push: PushSummaryInput, now: Date = new Date()): string | null {
  if (push.status === "proposed") return `Proposed ${formatDay(dayOf(push.createdAt), { now })}: not applied yet`;
  if (push.status !== "applied" || !push.appliedAt) return null;
  const head = `Pushed ${formatDay(dayOf(push.appliedAt), { now })}`;
  const after = push.after28 ?? push.after14;
  if (!after || push.beforePosition === null) return `${head}: not measured yet`;
  if (after.position === null) return `${head}: no impressions since`;
  const before = Math.round(push.beforePosition);
  const current = Math.round(after.position);
  if (before === current) return `${head}: no change yet`;
  return `${head}: ${before} → ${current}`;
}
