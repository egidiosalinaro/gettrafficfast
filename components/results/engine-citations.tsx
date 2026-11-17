import type { ArticleResult } from "@/lib/lifecycle/results";
import { formatRate, NotMeasured, rateIsPercent } from "@/components/visibility/primitives";
import { citationRatesByEngine, engineLabel } from "@/lib/domain/operating-loop";

/**
 * One line per engine, visible in the cell rather than in a hover title, so
 * a phone shows the same numbers a mouse would. From `MIN_PROBES_FOR_PERCENT`
 * probes up an engine reads "20% (2/10)"; below it, the count alone,
 * "0 of 3", because a percent over a handful of probes reads like a verdict.
 */
export function EngineCitationsCell({ citations }: { citations: ArticleResult["citations"] }) {
  const rates = citationRatesByEngine([{ citations }]);
  if (rates.length === 0) return <NotMeasured label="not probed yet" />;
  return (
    <ul className="space-y-0.5">
      {rates.map((rate) => (
        <li key={rate.engine} className="whitespace-nowrap text-xs">
          <span className="text-muted-foreground">{engineLabel(rate.engine)}</span>{" "}
          {rate.rate === null ? (
            <NotMeasured />
          ) : (
            <>
              <span className="text-sm font-medium tabular-nums">{formatRate(rate.cited, rate.probes)}</span>
              {rateIsPercent(rate.probes) && (
                <>
                  {" "}
                  <span className="text-muted-foreground tabular-nums">
                    ({rate.cited}/{rate.probes})
                  </span>
                </>
              )}
            </>
          )}
        </li>
      ))}
    </ul>
  );
}
