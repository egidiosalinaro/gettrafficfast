"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronDown, ExternalLink } from "lucide-react";
import { ArticleResults } from "@/components/results/article-results";
import { TrafficChart } from "@/components/results/traffic-chart";
import { PeriodSwitch } from "@/components/growth/period-switch";
import { PlacesLine } from "@/components/visibility/places-line";
import { NotMeasured } from "@/components/visibility/primitives";
import { engineLabel } from "@/lib/domain/operating-loop";
import { formatCount, formatDay, formatPosition, formatRate, positionChange, rateIsPercent } from "@/lib/format";
import type { GrowthDays } from "@/lib/growth/period";
import { GROWTH_AI_PATH, GROWTH_PATH, HOW_WE_MEASURE_HREF, growthHref } from "@/lib/growth/routes";
import type { AiGrowth, GoogleGrowth, GrowthSummary } from "@/lib/growth/schema";
import type { ResultsView } from "@/lib/lifecycle/load-results";
import { coverageLine, offLine, statNumber, type ReplyStats } from "@/lib/placements/reply-stats";
import { cn, pluralize } from "@/lib/utils";

/**
 * Growth, drawn from what GET /api/growth returns: three blocks that each
 * answer "am I growing?" over the period against the one before (Replies on
 * X, Google, AI answers), then the articles behind Google.
 *
 * Every number is honest or it is words: a number nobody measured reads
 * "not measured" (or why: "not connected", "no data yet"), never 0; a change
 * with nothing to compare reads "no comparison yet", never an arrow from
 * zero; AI answers are counted per engine, a count under 10 asks, never a
 * rate across engines. Explanations stay one short line per block; the rest
 * is on /docs ("How we measure").
 */

type Tone = "up" | "down" | "flat" | "none";

interface DeltaView {
  tone: Tone;
  text: string;
}

const TONE: Record<Tone, string> = {
  up: "text-emerald-600 dark:text-emerald-400",
  down: "text-red-600 dark:text-red-400",
  flat: "text-muted-foreground",
  none: "font-normal text-muted-foreground",
};

/** A count's change: "↑ 6", "↓ 1.2K", "no change", or why there is none. */
export function countDelta(change: number | null, none: string): DeltaView {
  if (change === null) return { tone: "none", text: none };
  if (change === 0) return { tone: "flat", text: "no change" };
  return change > 0 ? { tone: "up", text: `↑ ${statNumber(change)}` } : { tone: "down", text: `↓ ${statNumber(-change)}` };
}

/** A position's change, positive up the page: "↑ 3.1 places". */
export function positionDelta(delta: number | null, none: string): DeltaView {
  const change = positionChange(delta);
  if (change.direction === "none") return { tone: "none", text: none };
  if (change.direction === "unchanged") return { tone: "flat", text: "no change" };
  const unit = change.amount === "1" ? "place" : "places";
  return { tone: change.direction, text: `${change.direction === "up" ? "↑" : "↓"} ${change.amount} ${unit}` };
}

function Tile({ label, value, delta }: { label: string; value: React.ReactNode; delta: DeltaView | null }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-xl bg-background px-3 py-2.5">
      <span className="truncate text-xs text-muted-foreground">{label}</span>
      <span className="truncate text-[22px] font-bold leading-tight tabular-nums">{value}</span>
      {delta && <span className={cn("text-xs font-semibold leading-snug tabular-nums", TONE[delta.tone])}>{delta.text}</span>}
    </div>
  );
}

function Block({
  id,
  title,
  aside,
  children,
}: {
  id: string;
  title: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={`${id}-title`} className="flex min-w-0 flex-col gap-3 rounded-2xl border border-border bg-card p-4" data-block={id}>
      <div className="flex items-baseline justify-between gap-2">
        <h2 id={`${id}-title`} className="text-base font-semibold">
          {title}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="text-xs leading-snug text-muted-foreground">{children}</p>;
}

const ASIDE_LINK = "inline-flex min-h-11 items-center text-[13px] text-muted-foreground hover:text-foreground md:min-h-8";

// ── Replies on X ────────────────────────────────────────────────────────────

export function RepliesBlock({ stats, days }: { stats: ReplyStats | null; days: GrowthDays }) {
  const aside = (
    <Link href="/today?view=posted" className={ASIDE_LINK}>
      All replies
    </Link>
  );
  if (!stats) {
    return (
      <Block id="replies" title="Replies on X" aside={aside}>
        <Note>The replies posted on X could not be read right now.</Note>
      </Block>
    );
  }
  const { week, previousWeek, change, followers } = stats;
  const off = offLine(stats.status);
  const before = previousWeek.posted === 0 ? "none before" : "no comparison yet";
  const read = !off && stats.measured;
  const unread = <NotMeasured label={off ? "not read" : "not measured"} />;
  const best = read ? stats.top[0] : undefined;

  return (
    <Block id="replies" title="Replies on X" aside={aside}>
      <div className="grid grid-cols-2 gap-2">
        <Tile label="Replies posted" value={formatCount(week.posted)} delta={countDelta(week.posted - previousWeek.posted, before)} />
        <Tile
          label="Views"
          value={read && week.views !== null ? statNumber(week.views) : unread}
          delta={read ? countDelta(change.views, before) : null}
        />
        <Tile
          label="Likes"
          value={read && week.likes !== null ? statNumber(week.likes) : unread}
          delta={read ? countDelta(change.likes, before) : null}
        />
        <Tile
          label="Followers"
          value={
            !off && followers.followers !== null ? (
              statNumber(followers.followers)
            ) : (
              <NotMeasured label={off ? "not read" : followers.day ? "X returned no numbers" : "not measured yet"} />
            )
          }
          delta={!off && followers.followers !== null ? countDelta(followers.change, "no comparison yet") : null}
        />
      </div>
      {off ? (
        <Note>
          {off}
          {stats.status === "off_site" && (
            <>
              {" "}
              <Link href="/settings/integrations" className="inline-flex min-h-11 items-center font-medium text-foreground underline underline-offset-2 md:min-h-0">
                Open Connections
              </Link>
            </>
          )}
        </Note>
      ) : !stats.measured ? (
        <Note>The numbers of your replies could not be read right now.</Note>
      ) : (
        <Note>
          {week.posted === 0
            ? coverageLine(week, days)
            : `Views so far on the replies posted in these ${days} days, as X shows them. ${coverageLine(week, days)}.`}
        </Note>
      )}
      {best && (
        <a
          href={best.publishedUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex min-h-11 items-center gap-3 rounded-xl border border-border px-3 py-2.5 hover:bg-muted/40"
        >
          <span className="min-w-0 flex-1">
            <span className="block text-xs text-muted-foreground">
              Best reply
              {best.views !== null && ` · ${statNumber(best.views)} ${best.views === 1 ? "view" : "views"}`}
              {best.likes !== null && ` · ${statNumber(best.likes)} ${best.likes === 1 ? "like" : "likes"}`}
            </span>
            <span className="block truncate text-sm">{best.text ?? "Your reply (its text is not on record)"}</span>
          </span>
          <ExternalLink className="h-4 w-4 shrink-0 text-muted-foreground" aria-label="Open on X" />
        </a>
      )}
    </Block>
  );
}

// ── Google ──────────────────────────────────────────────────────────────────

function googleNote(google: GoogleGrowth, days: GrowthDays): string {
  const { current, previous } = google;
  if (!current) {
    if (google.connection.syncing) return "Pulling your data from Search Console. The first pull reads about 90 days.";
    if (!google.connection.siteUrl) return "Connected, but no property is chosen yet.";
    return "No Search Console data for your published articles yet.";
  }
  const range = `${formatDay(current.from)} to ${formatDay(current.to)}`;
  if (previous) return `From Search Console, ${range}, against the ${days} days before.`;
  return `From Search Console, ${range}. No comparison yet: the data starts ${formatDay(google.coveredFrom)}.`;
}

export function GoogleBlock({ google, days }: { google: GoogleGrowth; days: GrowthDays }) {
  const aside = (
    <a href="#by-article" className={ASIDE_LINK}>
      By article
    </a>
  );
  if (google.connection.status === "absent") {
    return (
      <Block id="google" title="Google" aside={aside}>
        <Note>Connect Google Search Console to see impressions, clicks and positions. Read-only.</Note>
        <Link
          href="/settings/integrations/search-console"
          className="inline-flex min-h-11 items-center justify-center rounded-xl border border-border text-sm font-semibold hover:bg-muted/40"
        >
          Connect Search Console
        </Link>
      </Block>
    );
  }
  const { current, previous, change, pages } = google;
  const none = current && !previous ? "no comparison yet" : "";
  const missing = <NotMeasured label={google.connection.syncing ? "syncing" : "no data yet"} />;

  return (
    <Block id="google" title="Google" aside={aside}>
      {google.connection.status === "error" && (
        <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          The Search Console connection stopped working.{" "}
          <Link href="/settings/integrations/search-console" className="inline-flex min-h-11 items-center font-medium underline underline-offset-2 md:min-h-0">
            Reconnect it
          </Link>
        </p>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Tile label="Impressions" value={current ? statNumber(current.impressions) : missing} delta={current ? countDelta(change.impressions, none) : null} />
        <Tile label="Clicks" value={current ? statNumber(current.clicks) : missing} delta={current ? countDelta(change.clicks, none) : null} />
        <Tile
          label="Average position"
          value={
            !current ? (
              missing
            ) : current.averagePosition === null ? (
              <NotMeasured label="no impressions" />
            ) : (
              formatPosition(current.averagePosition)
            )
          }
          delta={current?.averagePosition != null ? positionDelta(change.averagePosition, none) : null}
        />
        <Tile
          label="Pages on Google"
          value={
            !pages ? (
              <NotMeasured label="not read" />
            ) : pages.checked === 0 ? (
              <NotMeasured label="not checked yet" />
            ) : (
              `${formatCount(pages.indexed)} of ${formatCount(pages.total)}`
            )
          }
          delta={
            pages && pages.checked > 0
              ? { tone: "none", text: pages.checked < pages.total ? `${formatCount(pages.total - pages.checked)} not checked yet` : "latest check only" }
              : null
          }
        />
      </div>
      <Note>{googleNote(google, days)}</Note>
      {pages && pages.notIndexedRows.length > 0 && (
        <details className="group rounded-xl border border-border">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-3 text-sm font-medium">
            Not on Google · {formatCount(pages.notIndexed)}
            <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden />
          </summary>
          <ul className="divide-y divide-border border-t border-border">
            {pages.notIndexedRows.map((row) => (
              <li key={row.url} className="px-3 py-2 text-xs">
                <a href={row.url} target="_blank" rel="noopener noreferrer" className="flex min-h-11 items-center truncate text-sm hover:underline md:min-h-0">
                  {shortUrl(row.url)}
                </a>
                <span className="text-muted-foreground">
                  {row.coverageState ?? "Google gave no reason"} · checked {formatDay(row.checkedAt)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </Block>
  );
}

// ── AI answers ──────────────────────────────────────────────────────────────

function engineValue(engine: AiGrowth["engines"][number], days: GrowthDays) {
  const { asks, cited } = engine.current;
  const shown = formatRate(cited, asks);
  if (shown === null) return <NotMeasured label={`not asked in these ${days} days`} />;
  return (
    <>
      <strong className="font-bold">{shown}</strong>{" "}
      <span className="text-muted-foreground">{rateIsPercent(asks) ? `· ${formatCount(cited)} of ${pluralize(asks, "ask")}` : asks === 1 ? "ask cited you" : "asks cited you"}</span>
    </>
  );
}

function engineBefore(engine: AiGrowth["engines"][number], days: GrowthDays): string {
  const prev = formatRate(engine.previous.cited, engine.previous.asks);
  const parts = [prev === null ? `not asked the ${days} days before` : `${days} days before: ${prev}`];
  if (engine.unreadable > 0) parts.push(`${formatCount(engine.unreadable)} not readable`);
  return parts.join(" · ");
}

export function AiBlock({ ai, days }: { ai: AiGrowth; days: GrowthDays }) {
  const counted = ai.engines.filter((e) => e.current.asks > 0);
  const tooFew = counted.some((e) => !rateIsPercent(e.current.asks));
  const last = counted.length === 0 && ai.lastAskedAt ? `Last asked ${formatDay(ai.lastAskedAt)}. ` : "";
  return (
    <Block id="ai" title="AI answers" aside={<span className="text-xs text-muted-foreground">sampled</span>}>
      {ai.engines.length === 0 ? (
        <Note>No answer engine has been asked about your site yet.</Note>
      ) : (
        <ul className="flex flex-col">
          {ai.engines.map((engine) => (
            <li key={engine.engine} className="flex min-h-11 items-center justify-between gap-3 border-t border-border py-2 first:border-t-0">
              <span className="text-sm">{engineLabel(engine.engine)}</span>
              <span className="min-w-0 text-right">
                <span className="block text-sm tabular-nums">{engineValue(engine, days)}</span>
                <span className="block text-xs text-muted-foreground">{engineBefore(engine, days)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      <Note>
        {last}
        {tooFew ? "Too few asks for a percent yet. " : ""}Sampled from your articles&apos; keywords and the questions you chose: we look for your site in the sources of each answer.
      </Note>
      <PlacesLine
        className="rounded-xl bg-background px-3 py-2.5 text-[13px] leading-snug"
        placesFromSources={ai.placesFromSources}
        count={ai.places?.open ?? null}
      />
      <Link
        href={growthHref(GROWTH_AI_PATH, days)}
        className="inline-flex min-h-11 items-center justify-center rounded-xl border border-border text-sm font-semibold hover:bg-muted/40"
      >
        See the answers
      </Link>
    </Block>
  );
}

// ── By article ──────────────────────────────────────────────────────────────

const FIRST_ARTICLES = 5;

/** "gettrafficfa.st/blog/post": an address as a person reads it. */
export function shortUrl(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, "");
}

/**
 * The articles Google shows first: by impressions over 28 days, then the
 * ones that hold a position, then the rest in the order they came (newest
 * first). An article nobody measured is never above one that was.
 */
export function articlesByReach<T extends Pick<ResultsView["articles"][number], "traffic" | "rank">>(articles: readonly T[]): T[] {
  return articles
    .map((article, index) => ({ article, index }))
    .sort(
      (a, b) =>
        (b.article.traffic.impressions ?? -1) - (a.article.traffic.impressions ?? -1) ||
        Number(b.article.rank.current !== null) - Number(a.article.rank.current !== null) ||
        a.index - b.index
    )
    .map(({ article }) => article);
}

export function ByArticle({ results }: { results: ResultsView }) {
  const [all, setAll] = useState(false);
  const articles = articlesByReach(results.articles);
  const shown = all ? articles : articles.slice(0, FIRST_ARTICLES);
  return (
    <section id="by-article" aria-labelledby="by-article-title" className="scroll-mt-20 space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="by-article-title" className="text-base font-semibold">
          By article
        </h2>
        {articles.length > 0 && (
          <span className="text-xs text-muted-foreground">{pluralize(articles.length, "published article")}</span>
        )}
      </div>
      {articles.length === 0 ? (
        <Note>Nothing published yet. Once articles go live, each one shows its position, clicks and AI answers here.</Note>
      ) : (
        <>
          <ArticleResults articles={shown} connection={results.searchConsole.status} />
          {articles.length > FIRST_ARTICLES && (
            <button
              type="button"
              onClick={() => setAll((v) => !v)}
              className="inline-flex min-h-11 w-full items-center justify-center rounded-xl border border-border text-sm font-medium hover:bg-muted/40"
            >
              {all ? "Show fewer" : `Show all ${pluralize(articles.length, "article")}`}
            </button>
          )}
        </>
      )}
      {results.traffic.days.length > 0 && (
        <details className="group rounded-xl border border-border bg-card">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-3 text-sm font-medium">
            Clicks and impressions by day, last {results.traffic.windowDays} days
            <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden />
          </summary>
          <div className="border-t border-border p-3">
            <TrafficChart days={results.traffic.days} />
          </div>
        </details>
      )}
    </section>
  );
}

// ── The page ────────────────────────────────────────────────────────────────

export function GrowthHeader({ days }: { days: GrowthDays }) {
  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-3xl font-bold tracking-tight">Growth</h1>
        <PeriodSwitch days={days} path={GROWTH_PATH} />
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        {days === 7 ? "This week against the week before." : "These 28 days against the 28 before."}
      </p>
    </div>
  );
}

export function GrowthView({ growth, results }: { growth: GrowthSummary; results: ResultsView | null }) {
  const days = growth.days;
  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <GrowthHeader days={days} />
      <div className="grid gap-4 lg:grid-cols-3">
        <RepliesBlock stats={growth.replies} days={days} />
        <GoogleBlock google={growth.google} days={days} />
        <AiBlock ai={growth.ai} days={days} />
      </div>
      {results && <ByArticle results={results} />}
      <div className="flex justify-center">
        <Link href={HOW_WE_MEASURE_HREF} className="inline-flex min-h-11 items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground">
          How we measure
          <ExternalLink className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </div>
    </div>
  );
}
