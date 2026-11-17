"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { VisibilityOverview } from "@/lib/visibility/read";
import {
  formatRate,
  NotMeasured,
  StatTile,
  visibilityHint,
} from "@/components/visibility/primitives";
import { engineLabel } from "@/lib/domain/operating-loop";
import { GROWTH_AI_PATH, GROWTH_AI_SETTINGS_PATH } from "@/lib/growth/routes";
import { pluralize } from "@/lib/utils";

type Payload = ({ hasBusiness: true } & VisibilityOverview) | { hasBusiness: false };

/**
 * The overview's first row: visibility, the way the prompt screen computes
 * it. One tile per engine. No average, no zero standing in for "we have not
 * asked yet", and a count ("1 of 3") instead of a percent under
 * `MIN_PROBES_FOR_PERCENT` readable answers.
 */
export function VisibilityStrip() {
  const [data, setData] = useState<Payload | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/visibility", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        if (!cancelled && payload) setData(payload as Payload);
      })
      .catch(() => {
        /* Overview still works if this read fails. */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!data || !data.hasBusiness) return null;

  const engines = data.summary?.engines ?? [];

  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Visibility</h2>
          <p className="text-xs text-muted-foreground">
            Sampled on the prompts you configured. One rate per engine.
          </p>
        </div>
        <Link
          href={GROWTH_AI_PATH}
          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          Open prompts
          <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>

      {data.queries.enabled === 0 ? (
        <div className="rounded-lg border border-foreground/10 bg-muted/20 p-4 text-sm">
          <p className="font-medium">No prompts yet.</p>
          <p className="mt-1 text-muted-foreground">
            Add the questions a buyer would ask an assistant. Until then there
            is nothing to measure.
          </p>
          <Link
            href={GROWTH_AI_SETTINGS_PATH}
            className="mt-3 inline-flex items-center gap-1 text-sm font-medium underline underline-offset-4"
          >
            Add prompts
          </Link>
        </div>
      ) : engines.length === 0 ? (
        <div className="rounded-lg border border-foreground/10 bg-muted/20 p-4 text-sm">
          <p className="font-medium">
            {pluralize(data.queries.enabled, "prompt")}, not measured yet.
          </p>
          <p className="mt-1 text-muted-foreground">
            A run asks each prompt of each enabled engine. Nothing here is 0%
            before that happens.
          </p>
          <Link
            href={GROWTH_AI_PATH}
            className="mt-3 inline-flex items-center gap-1 text-sm font-medium underline underline-offset-4"
          >
            Run the prompts
          </Link>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {engines.map((engine) => (
            <StatTile
              key={engine.engine}
              label={`Visibility · ${engineLabel(engine.engine)}`}
              value={
                engine.rate === null ? (
                  <NotMeasured label={engine.pending > 0 ? "measuring…" : "no readable answers"} />
                ) : (
                  formatRate(engine.cited, engine.valid)
                )
              }
              hint={visibilityHint(engine)}
            />
          ))}
        </div>
      )}
    </section>
  );
}
