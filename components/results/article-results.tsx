import { ArrowDown, ArrowUp, ExternalLink, Minus, TrendingUp } from "lucide-react";
import {
  describeRankSources,
  RANK_SOURCE_LABEL,
  TREND_WINDOW_DAYS,
  type ArticleResult,
  type SearchConsoleStatus,
} from "@/lib/lifecycle/results";
import { formatCount, formatPosition, positionChange } from "@/lib/format";
import { pluralize } from "@/lib/utils";
import { EngineCitationsCell } from "@/components/results/engine-citations";
import { formatDay, NotMeasured } from "@/components/visibility/primitives";

/**
 * The published articles on the Results screen: a card per article below
 * `md`, the table from `md` up. Same data and the same honesty rules in both:
 * a position never measured is "not measured yet", one measured as absent is
 * "not ranking", a citation rate is one per engine, and a date never checked
 * is "never".
 *
 * Positions and changes go through one formatter (`formatPosition`,
 * `positionChange` in lib/format.ts): "51.8", "↑ 15", never 51.75 or
 * 15.049999999999997. Where positions come from is said once, under the
 * list; only a row from the other source carries a marker.
 */

type Connection = SearchConsoleStatus["status"];

/** Positive delta means the article moved UP the results page. */
export function RankTrend({ delta }: { delta: number | null }) {
  const change = positionChange(delta);
  if (change.direction === "none") {
    return <Minus className="h-3.5 w-3.5 text-muted-foreground/50" aria-label="no trend" />;
  }
  if (change.direction === "unchanged") {
    return <Minus className="h-3.5 w-3.5 text-muted-foreground" aria-label="unchanged" />;
  }
  const up = change.direction === "up";
  const Icon = up ? ArrowUp : ArrowDown;
  return (
    <span
      className={
        up
          ? "inline-flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400"
          : "inline-flex items-center gap-0.5 text-red-600 dark:text-red-400"
      }
      aria-label={`${up ? "up" : "down"} ${change.amount} in ${TREND_WINDOW_DAYS} days`}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
      <span className="text-xs tabular-nums">{change.amount}</span>
    </span>
  );
}

/** "SERP snapshot" beside a row whose position does not come from the source the note names. */
function SourceMarker({ article }: { article: ArticleResult }) {
  if (!article.rankSource) return null;
  return (
    <span className="whitespace-nowrap rounded border border-foreground/15 px-1 text-[11px] font-normal text-muted-foreground">
      {RANK_SOURCE_LABEL[article.rankSource]}
    </span>
  );
}

function Position({ article, marked }: { article: ArticleResult; marked: boolean }) {
  if (article.rank.samples === 0) return <NotMeasured />;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
      {article.rank.current === null ? (
        <span className="text-muted-foreground">not ranking</span>
      ) : (
        <span className="tabular-nums">{formatPosition(article.rank.current)}</span>
      )}
      {marked && <SourceMarker article={article} />}
    </span>
  );
}

function Clicks({ article, connection }: { article: ArticleResult; connection: Connection }) {
  if (article.traffic.clicks === null) {
    return <NotMeasured label={connection === "absent" ? "not connected" : "no data yet"} />;
  }
  return (
    <span className="tabular-nums" title={pluralize(article.traffic.impressions ?? 0, "impression")}>
      {formatCount(article.traffic.clicks)}
    </span>
  );
}

function LastChecked({ article }: { article: ArticleResult }) {
  const lastChecked = article.rank.measuredOn ?? article.citations.lastCheckedOn;
  return lastChecked ? <>{formatDay(lastChecked)}</> : <NotMeasured label="never" />;
}

/** "Pushed Nov 16: 37 → 29" under the keyword (Push page 3); nothing for an article never pushed. */
function PushLine({ article }: { article: ArticleResult }) {
  if (!article.push?.line) return null;
  return <span className="mt-0.5 block text-xs font-normal text-muted-foreground" data-testid="push-line">{article.push.line}</span>;
}

function OpenArticle({ url, className }: { url: string; className: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground ${className}`}
      aria-label="Open the published article"
    >
      <ExternalLink className="h-4 w-4" />
    </a>
  );
}

function Field({ label, children, wide = false }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className={wide ? "col-span-2 min-w-0" : "min-w-0"}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm">{children}</dd>
    </div>
  );
}

export function ArticleResults({
  articles,
  connection,
}: {
  articles: ArticleResult[];
  connection: Connection;
}) {
  const sources = describeRankSources(articles);
  const marked = new Set(sources.exceptions);

  return (
    <div className="space-y-2">
      <ul className="space-y-3 md:hidden" aria-label="Published articles">
        {articles.map((article) => (
          <li key={article.articleId} className="rounded-lg border border-foreground/10 bg-card p-3">
            <div className="flex items-start gap-2">
              <p className="min-w-0 flex-1 pt-0.5 text-sm font-medium [overflow-wrap:anywhere]">
                {article.keyword || "-"}
                <PushLine article={article} />
              </p>
              {article.publishedUrl && (
                <OpenArticle url={article.publishedUrl} className="-mr-2 -mt-2 h-11 w-11" />
              )}
            </div>
            <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-3">
              <Field label={`Position (${TREND_WINDOW_DAYS}d trend)`}>
                <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <Position article={article} marked={marked.has(article.articleId)} />
                  {article.rank.delta !== null && <RankTrend delta={article.rank.delta} />}
                </span>
              </Field>
              <Field label={`Clicks (${TREND_WINDOW_DAYS}d)`}>
                <Clicks article={article} connection={connection} />
              </Field>
              <Field label="AI citations">
                <EngineCitationsCell citations={article.citations} />
              </Field>
              <Field label="Last checked">
                <span className="text-muted-foreground">
                  <LastChecked article={article} />
                </span>
              </Field>
            </dl>
          </li>
        ))}
      </ul>

      <div className="hidden overflow-x-auto rounded-lg border border-foreground/10 md:block">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Keyword</th>
              <th className="px-3 py-2 text-left font-medium">Position</th>
              <th className="px-3 py-2 text-left font-medium">
                <span className="inline-flex items-center gap-1">
                  <TrendingUp className="h-3 w-3" /> {TREND_WINDOW_DAYS}d
                </span>
              </th>
              <th className="px-3 py-2 text-left font-medium">Clicks ({TREND_WINDOW_DAYS}d)</th>
              <th className="px-3 py-2 text-left font-medium">AI citations</th>
              <th className="px-3 py-2 text-left font-medium">Last checked</th>
              <th className="px-3 py-2">
                <span className="sr-only">Open</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {articles.map((article) => (
              <tr key={article.articleId} className="border-t border-foreground/10 align-middle">
                <td className="px-3 py-2 font-medium [overflow-wrap:anywhere]">
                  {article.keyword || "-"}
                  <PushLine article={article} />
                </td>
                <td className="px-3 py-2">
                  <Position article={article} marked={marked.has(article.articleId)} />
                </td>
                <td className="px-3 py-2">
                  <RankTrend delta={article.rank.delta} />
                </td>
                <td className="px-3 py-2">
                  <Clicks article={article} connection={connection} />
                </td>
                <td className="px-3 py-2">
                  <EngineCitationsCell citations={article.citations} />
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">
                  <LastChecked article={article} />
                </td>
                <td className="px-3 py-2 text-right">
                  {article.publishedUrl && <OpenArticle url={article.publishedUrl} className="h-8 w-8" />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {sources.note && <p className="text-xs text-muted-foreground">{sources.note}</p>}
    </div>
  );
}
