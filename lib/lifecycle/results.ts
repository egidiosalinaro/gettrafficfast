import { formatDay, roundPosition } from "@/lib/format";
import type { CitationPoint } from "./citations";
import type { RankPoint } from "./rank";

/**
 * Turning measurements into what a customer is shown.
 *
 * Every function here is pure, and every one of them has the same job: keep
 * "we have not measured this" distinguishable from "we measured it and the
 * answer is zero". That distinction is the whole reason the tables store
 * negatives and nulls, and it is exactly where a dashboard usually throws it
 * away by rendering a confident 0.
 *
 * Positions leave here rounded to one decimal (`roundPosition`), so the
 * screen, the REST API and MCP all read 51.8 and a change of 15, never 51.75
 * and 15.049999999999997.
 */

export interface RankSummary {
  /** Most recent measured position, one decimal, or null when it was measured as absent. */
  current: number | null;
  /** The oldest position inside the comparison window, for the trend. One decimal. */
  previous: number | null;
  /**
   * previous − current, one decimal: positive means improved (moved up the
   * page), 0 unchanged. Null when not comparable.
   */
  delta: number | null;
  /** Date of the last measurement, null when the article was never measured. */
  measuredOn: string | null;
  /** How many times we looked. Zero means "never looked", not "not ranking". */
  samples: number;
}

/** Default trend window. Rank moves on the scale of weeks, not days. */
export const TREND_WINDOW_DAYS = 28;

export function summarizeRank(
  points: RankPoint[],
  windowDays = TREND_WINDOW_DAYS
): RankSummary {
  if (points.length === 0) {
    return { current: null, previous: null, delta: null, measuredOn: null, samples: 0 };
  }

  const ordered = [...points].sort((a, b) => a.capturedOn.localeCompare(b.capturedOn));
  const last = ordered[ordered.length - 1];

  const cutoff = new Date(new Date(last.capturedOn).getTime() - windowDays * 86_400_000)
    .toISOString()
    .slice(0, 10);
  // The comparison point is the oldest measurement still inside the window.
  // Anything older describes a different article.
  const earlier = ordered.find((p) => p.capturedOn >= cutoff && p.capturedOn < last.capturedOn);

  const current = last.position === null ? null : roundPosition(last.position);
  const previous =
    earlier?.position === null || earlier?.position === undefined ? null : roundPosition(earlier.position);

  return {
    current,
    previous,
    // A move is only a move between two known positions. Appearing from
    // nowhere, or vanishing, is a state change and is shown as such. The
    // change is taken between the rounded positions, so it is the difference
    // of the two numbers a reader sees, and rounded again to drop float dust.
    delta: current !== null && previous !== null ? roundPosition(previous - current) : null,
    measuredOn: last.capturedOn,
    samples: ordered.length,
  };
}

export interface EngineRate {
  engine: string;
  rate: number;
  probes: number;
}

export interface CitationSummary {
  /** Share of probes that found a citation, or null when never probed. */
  rate: number | null;
  probes: number;
  cited: number;
  lastCheckedOn: string | null;
  /** Per engine, because engines disagree and averaging them means nothing. */
  byEngine: EngineRate[];
}

export function summarizeCitations(points: CitationPoint[]): CitationSummary {
  if (points.length === 0) {
    return { rate: null, probes: 0, cited: 0, lastCheckedOn: null, byEngine: [] };
  }

  const engines = new Map<string, { cited: number; probes: number }>();
  let cited = 0;
  let lastCheckedOn = points[0].checkedOn;

  for (const point of points) {
    const bucket = engines.get(point.engine) ?? { cited: 0, probes: 0 };
    bucket.probes += 1;
    if (point.cited) {
      bucket.cited += 1;
      cited += 1;
    }
    engines.set(point.engine, bucket);
    if (point.checkedOn > lastCheckedOn) lastCheckedOn = point.checkedOn;
  }

  return {
    rate: cited / points.length,
    probes: points.length,
    cited,
    lastCheckedOn,
    byEngine: [...engines.entries()]
      .map(([engine, b]) => ({ engine, rate: b.cited / b.probes, probes: b.probes }))
      .sort((a, b) => a.engine.localeCompare(b.engine)),
  };
}

export interface TrafficPoint {
  capturedOn: string;
  impressions: number;
  clicks: number;
}

export interface TrafficSummary {
  /** Null when Search Console is not connected, never 0: they differ. */
  impressions: number | null;
  clicks: number | null;
  windowDays: number;
}

/**
 * Real traffic over the window. This is the only counted, non-sampled number
 * in the product, which is exactly why an absent connection must read as
 * "not connected" rather than as a zero that looks like failure.
 */
export function summarizeTraffic(
  points: TrafficPoint[],
  windowDays = TREND_WINDOW_DAYS,
  today = new Date()
): TrafficSummary {
  if (points.length === 0) {
    return { impressions: null, clicks: null, windowDays };
  }
  const cutoff = new Date(today.getTime() - windowDays * 86_400_000).toISOString().slice(0, 10);
  const inWindow = points.filter((p) => p.capturedOn >= cutoff);
  return {
    impressions: inWindow.reduce((sum, p) => sum + p.impressions, 0),
    clicks: inWindow.reduce((sum, p) => sum + p.clicks, 0),
    windowDays,
  };
}

export interface DailyTrafficPoint {
  day: string;
  clicks: number;
  impressions: number;
}

export interface TrafficSeries {
  days: DailyTrafficPoint[];
  /** Last day actually ingested. The series never extends past it. */
  settledThrough: string | null;
  windowDays: number;
}

/**
 * The per-day series behind the traffic chart, aggregated across articles.
 *
 * Two different kinds of absence meet here and must not be confused. A day
 * missing INSIDE the ingested range is a real zero: Search Console omits days
 * with nothing to report, so the gap is filled with 0. A day AFTER the last
 * ingested one is not zero, it is not settled yet, so the series simply stops
 * there instead of drawing a cliff that does not exist.
 */
export function summarizeDailyTraffic(
  points: TrafficPoint[],
  windowDays = TREND_WINDOW_DAYS,
  today = new Date()
): TrafficSeries {
  if (points.length === 0) {
    return { days: [], settledThrough: null, windowDays };
  }

  const byDay = new Map<string, { clicks: number; impressions: number }>();
  let settledThrough = points[0].capturedOn;
  for (const point of points) {
    const bucket = byDay.get(point.capturedOn) ?? { clicks: 0, impressions: 0 };
    bucket.clicks += point.clicks;
    bucket.impressions += point.impressions;
    byDay.set(point.capturedOn, bucket);
    if (point.capturedOn > settledThrough) settledThrough = point.capturedOn;
  }

  const cutoff = new Date(today.getTime() - windowDays * 86_400_000)
    .toISOString()
    .slice(0, 10);

  const days: DailyTrafficPoint[] = [];
  const end = new Date(`${settledThrough}T00:00:00Z`).getTime();
  for (let t = new Date(`${cutoff}T00:00:00Z`).getTime(); t <= end; t += 86_400_000) {
    const day = new Date(t).toISOString().slice(0, 10);
    const bucket = byDay.get(day);
    days.push({ day, clicks: bucket?.clicks ?? 0, impressions: bucket?.impressions ?? 0 });
  }

  return { days, settledThrough, windowDays };
}

/**
 * The Search Console connection as the results view needs it: never connected,
 * connected (with or without a completed pull), syncing the first window, or
 * broken. Never the credential.
 */
export interface SearchConsoleStatus {
  status: "absent" | "connected" | "error";
  siteUrl: string | null;
  /** Newest day fetched. Google has not settled the days after it. */
  lastSyncedOn: string | null;
  /** When the pull last finished. Null until one has. */
  pulledAt: string | null;
  /**
   * The stored day is behind the newest day Google has settled, so opening
   * the page should pull. A current watermark is not stale.
   */
  stale: boolean;
  lastError: string | null;
  /** True while a first ingest job is queued or running. */
  syncing: boolean;
}

/**
 * Copy for the Results empty traffic panel. Never tells a connected customer
 * to wait until 07:00: the first pull starts when a property is selected.
 * Days read as days ("Aug 26"), never as ISO.
 */
export function describeSearchConsoleTrafficEmpty(
  connection: SearchConsoleStatus,
  now: Date = new Date()
): string | null {
  if (connection.status === "absent") return null;
  if (connection.status === "error") return null;
  if (!connection.siteUrl) {
    return "Connected, but no property is selected yet. Choose one to start the sync.";
  }
  if (connection.syncing) {
    return "Pulling traffic from Search Console. The first sync reads about 90 days of history.";
  }
  if (!connection.lastSyncedOn) {
    return "Waiting for the first Search Console pull. It starts as soon as a published article has a live URL, and reads about 90 days of history.";
  }
  const when = pulledOnPhrase(connection.pulledAt, now);
  return `Data through ${formatDay(connection.lastSyncedOn, { now })}${when ? `, ${when}` : ""}. No clicks or impressions matched your published articles in this window. Google settles the newest days over about three days, so the latest days always arrive a little late.`;
}

/** "pulled today" when the pull's calendar day is today's, in UTC, like the watermark. */
export function pulledOnPhrase(pulledAt: string | null | undefined, now: Date): string | null {
  if (!pulledAt) return null;
  const day = pulledAt.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const today = now.toISOString().slice(0, 10);
  if (day === today) return "pulled today";
  const yesterday = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
  if (day === yesterday) return "pulled yesterday";
  return `pulled ${formatDay(day, { now })}`;
}

/**
 * The line next to the property. `through` is the newest day in the data
 * (`YYYY-MM-DD`), not the moment we asked Google. Those are different, and
 * saying "last synced" for the data day reads as a pull that never happened.
 */
export function searchConsoleCaption(input: {
  siteLabel: string | null;
  through: string | null;
  pulledAt: string | null;
  syncing: boolean;
  now?: Date;
}): string | null {
  const site = input.siteLabel;
  if (input.syncing) return [site, "syncing…"].filter(Boolean).join(" · ") || null;
  if (!input.through) return site;
  const now = input.now ?? new Date();
  const pulled = pulledOnPhrase(input.pulledAt, now);
  return [site, `data through ${formatDay(input.through, { now })}`, pulled].filter(Boolean).join(" · ");
}

/**
 * Which series the position comes from when both exist.
 *
 * Search Console reports the average position Google actually served; our SERP
 * snapshot is one scrape on one day from one location. When we have the former
 * we use it, and we never interleave the two: a series that alternates between
 * a measured average and a single scrape describes neither.
 */
export function pickRankSeries(bySource: {
  searchConsole: RankPoint[];
  serp: RankPoint[];
}): { points: RankPoint[]; source: "search_console" | "serp" | null } {
  if (bySource.searchConsole.length > 0) {
    return { points: bySource.searchConsole, source: "search_console" };
  }
  if (bySource.serp.length > 0) return { points: bySource.serp, source: "serp" };
  return { points: [], source: null };
}

export type RankSource = "search_console" | "serp";

export interface ArticleResult {
  articleId: string;
  keyword: string;
  publishedUrl: string | null;
  rank: RankSummary;
  /** Where the position came from, so the UI can say so. */
  rankSource: RankSource | null;
  traffic: TrafficSummary;
  citations: CitationSummary;
  /**
   * The newest Push page 3 that changed something, as Growth prints it
   * ("Pushed Nov 16: 37 → 29", "not measured yet"); absent or null when
   * the article was never pushed (docs/LIFECYCLE.md, "Push page 3").
   */
  push?: { line: string; status: string } | null;
}

/** Where a position came from, in words: never the `gsc` identifier. */
export const RANK_SOURCE_LABEL: Record<RankSource, string> = {
  search_console: "Search Console",
  serp: "SERP snapshot",
};

const POSITIONS_FROM: Record<RankSource, string> = {
  search_console: "Positions are Google's average from Search Console",
  serp: "Positions are from our own SERP snapshot, one results page read on one day",
};

export interface RankSources {
  /** The source the measured rows share, said once under the list. Null when nothing was measured. */
  primary: RankSource | null;
  /** Measured articles whose position comes from the other source: only these rows carry a marker. */
  exceptions: string[];
  /** The one sentence under the list, or null when no article has a rank measurement. */
  note: string | null;
}

/**
 * Saying where positions come from once, not on every row.
 *
 * When every measured article has the same source, the note says it and no
 * row carries a label. When they mix, the source most rows share is the
 * note's, and only the other rows are marked. A tie goes to Search Console:
 * Google's own average is the better measurement of the two.
 */
export function describeRankSources(
  articles: ReadonlyArray<Pick<ArticleResult, "articleId" | "rankSource">>
): RankSources {
  const searchConsole = articles.filter((a) => a.rankSource === "search_console").length;
  const serp = articles.filter((a) => a.rankSource === "serp").length;
  if (searchConsole + serp === 0) return { primary: null, exceptions: [], note: null };

  const primary: RankSource = searchConsole >= serp ? "search_console" : "serp";
  const other: RankSource = primary === "search_console" ? "serp" : "search_console";
  const exceptions = articles.filter((a) => a.rankSource === other).map((a) => a.articleId);
  return {
    primary,
    exceptions,
    note:
      exceptions.length === 0
        ? `${POSITIONS_FROM[primary]}.`
        : `${POSITIONS_FROM[primary]}, except where a row says ${RANK_SOURCE_LABEL[other]}.`,
  };
}

export interface ResultsTotals {
  published: number;
  /** Articles with at least one rank measurement. The denominator of the rest. */
  rankMeasured: number;
  /** Currently holding a position at all. */
  ranking: number;
  topTen: number;
  /** Average of current positions among those that rank, one decimal, or null. */
  averagePosition: number | null;
  citationProbes: number;
  /** Overall citation rate, or null when nothing was probed. */
  citationRate: number | null;
  /** Real traffic across every article, null when Search Console is absent. */
  impressions: number | null;
  clicks: number | null;
}

/**
 * The headline numbers. Note what is deliberately absent: there is no
 * "average position" when nothing ranks, and no citation rate when nothing was
 * probed. A dashboard that renders 0 in those cases tells the customer they
 * are failing, when the truth is that we have not looked yet.
 */
export function summarizeTotals(articles: ArticleResult[]): ResultsTotals {
  const ranking = articles.filter((a) => a.rank.current !== null);
  const probes = articles.reduce((sum, a) => sum + a.citations.probes, 0);
  const cited = articles.reduce((sum, a) => sum + a.citations.cited, 0);

  const withTraffic = articles.filter((a) => a.traffic.impressions !== null);

  return {
    published: articles.length,
    impressions:
      withTraffic.length === 0
        ? null
        : withTraffic.reduce((sum, a) => sum + (a.traffic.impressions as number), 0),
    clicks:
      withTraffic.length === 0
        ? null
        : withTraffic.reduce((sum, a) => sum + (a.traffic.clicks as number), 0),
    rankMeasured: articles.filter((a) => a.rank.samples > 0).length,
    ranking: ranking.length,
    topTen: ranking.filter((a) => (a.rank.current as number) <= 10).length,
    averagePosition:
      ranking.length === 0
        ? null
        : roundPosition(ranking.reduce((sum, a) => sum + (a.rank.current as number), 0) / ranking.length),
    citationProbes: probes,
    citationRate: probes === 0 ? null : cited / probes,
  };
}
