"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, ExternalLink, Loader2 } from "lucide-react";
import type { QueryDetail } from "@/lib/visibility/read";
import { GROWTH_AI_PATH, GROWTH_AI_SETTINGS_PATH } from "@/lib/growth/routes";
import { surfaceLabel } from "@/lib/placements/surfaces";
import { engineLabel } from "@/lib/domain/operating-loop";
import { pluralize } from "@/lib/utils";
import {
  formatRate,
  formatWhen,
  NotMeasured,
  OutcomeBadge,
  rateIsPercent,
  SamplingNotice,
  TOO_FEW_FOR_PERCENT,
} from "@/components/visibility/primitives";

/**
 * One query over time: every probe per engine, who kept being cited instead,
 * which sources recur, and what on-site content and off-site placements
 * relate to it. Rates stay per engine; a rate over nothing readable is null.
 */
export default function QueryDetailPage() {
  const params = useParams<{ id: string }>();
  const [detail, setDetail] = useState<QueryDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const response = await fetch(`/api/visibility/queries/${params.id}`, { cache: "no-store" });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error ?? "Could not load the prompt");
        setDetail(payload as QueryDetail);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load the prompt");
      } finally {
        setIsLoading(false);
      }
    };
    load();
  }, [params.id]);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading...
      </div>
    );
  }
  if (error || !detail) {
    return (
      <div className="space-y-2">
        <Link href={GROWTH_AI_PATH} className="inline-flex min-h-11 items-center gap-1 text-sm text-muted-foreground hover:text-foreground md:min-h-0">
          <ArrowLeft className="h-4 w-4" /> AI answers
        </Link>
        <div className="text-sm text-red-600 dark:text-red-400">{error ?? "Prompt not found"}</div>
      </div>
    );
  }

  const { query, history, probes, competitors, sources, articles, placements } = detail;

  return (
    <div className="space-y-6">
      <div>
        <Link href={GROWTH_AI_PATH} className="inline-flex min-h-11 items-center gap-1 text-sm text-muted-foreground hover:text-foreground md:min-h-0">
          <ArrowLeft className="h-4 w-4" /> AI answers
        </Link>
        <h1 className="mt-2 text-xl font-semibold">&ldquo;{query.query}&rdquo;</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {query.cluster ? `Cluster: ${query.cluster}` : "No cluster"}
          {query.intent ? ` · intent: ${query.intent}` : ""}
          {!query.enabled && " · excluded from runs"}
          {" · "}
          <Link href={`${GROWTH_AI_SETTINGS_PATH}#prompts`} className="underline underline-offset-2">edit</Link>
        </p>
      </div>

      <SamplingNotice />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {history.length === 0 ? (
          <div className="rounded-lg border border-foreground/10 bg-muted/20 p-4 text-sm text-muted-foreground">
            Not probed yet. It will be asked on the next run.
          </div>
        ) : (
          history.map((h) => (
            <div key={h.engine} className="rounded-lg border border-foreground/10 bg-muted/20 p-4">
              <div className="text-xs font-medium text-muted-foreground">Cited by {engineLabel(h.engine)}</div>
              <div className="mt-1 text-2xl font-semibold tabular-nums">
                {h.rate === null ? <NotMeasured label="no readable answers" /> : formatRate(h.cited, h.valid)}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {h.valid === 0 || rateIsPercent(h.valid)
                  ? `${h.cited} of ${pluralize(h.valid, "readable answer")} · ${pluralize(h.points.length, "probe")} total`
                  : `${h.valid === 1 ? "readable answer" : "readable answers"} cited you · ${pluralize(h.points.length, "probe")} total. ${TOO_FEW_FOR_PERCENT}`}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-lg border border-foreground/10 p-4 lg:col-span-2">
          <h2 className="text-sm font-semibold">Probe history</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">Newest first. One row per engine per run.</p>
          {probes.length === 0 ? (
            <p className="mt-2 text-xs italic text-muted-foreground">no probes yet</p>
          ) : (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground">
                  <tr>
                    <th className="py-1 pr-3 text-left font-medium">When</th>
                    <th className="py-1 pr-3 text-left font-medium">Engine</th>
                    <th className="py-1 pr-3 text-left font-medium">Outcome</th>
                    <th className="py-1 pr-3 text-left font-medium">Position</th>
                    <th className="py-1 pr-3 text-left font-medium">Sources</th>
                    <th className="py-1 text-left font-medium">Excerpt</th>
                  </tr>
                </thead>
                <tbody>
                  {probes.map((p) => (
                    <tr key={p.id} className="border-t border-foreground/10 align-top">
                      <td className="py-2 pr-3 text-xs tabular-nums text-muted-foreground">{formatWhen(p.checkedAt)}</td>
                      <td className="py-2 pr-3 text-xs">{engineLabel(p.engine)}</td>
                      <td className="py-2 pr-3">
                        <OutcomeBadge status={p.status} />
                        {p.mentioned && <span className="ml-1 text-[11px] text-muted-foreground">named</span>}
                      </td>
                      <td className="py-2 pr-3 text-xs tabular-nums">{p.position ?? <span className="text-muted-foreground">none</span>}</td>
                      <td className="py-2 pr-3 text-xs tabular-nums">
                        {p.status === "cited" || p.status === "not_cited" ? p.sources.length : <span className="text-muted-foreground">n/a</span>}
                      </td>
                      <td className="py-2 text-xs text-muted-foreground">
                        {p.answerExcerpt ? (
                          <span title="Excerpt of the answer, not the full response">
                            {p.answerExcerpt.length > 160 ? `${p.answerExcerpt.slice(0, 160)}…` : p.answerExcerpt}
                          </span>
                        ) : p.error ? (
                          <span className="text-red-700 dark:text-red-400">{p.error}</span>
                        ) : (
                          "none"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="space-y-4">
          <div className="rounded-lg border border-foreground/10 p-4">
            <h2 className="text-sm font-semibold">Recurring competitors</h2>
            {competitors.length === 0 ? (
              <p className="mt-2 text-xs italic text-muted-foreground">none recognised yet</p>
            ) : (
              <ul className="mt-2 space-y-1 text-sm">
                {competitors.map((c) => (
                  <li key={c.domain} className="flex items-baseline justify-between gap-2">
                    <span className="min-w-0 truncate">{c.name ?? c.domain}</span>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{c.count}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="rounded-lg border border-foreground/10 p-4">
            <h2 className="text-sm font-semibold">Recurring sources</h2>
            {sources.length === 0 ? (
              <p className="mt-2 text-xs italic text-muted-foreground">no sources returned yet</p>
            ) : (
              <ul className="mt-2 space-y-1 text-sm">
                {sources.map((s) => (
                  <li key={s.domain} className="flex items-baseline justify-between gap-2">
                    <span className="min-w-0 truncate">{s.domain}</span>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{s.count}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-foreground/10 p-4">
          <h2 className="text-sm font-semibold">Your content for this question</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Articles written for the matching keyword, and pages an engine actually cited.
          </p>
          {articles.length === 0 ? (
            <p className="mt-2 text-xs italic text-muted-foreground">
              Nothing on your site is tied to this question yet. An article for the keyword &ldquo;{query.query}&rdquo; would be.
            </p>
          ) : (
            <ul className="mt-2 space-y-1 text-sm">
              {articles.map((a) => (
                <li key={a.id} className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 truncate">
                    {a.title ?? a.keyword}
                    <span className="ml-1 text-xs text-muted-foreground">
                      ({a.via === "cited" ? "cited by an engine" : "keyword match"} · {a.status})
                    </span>
                  </span>
                  {a.publishedUrl && (
                    <a href={a.publishedUrl} target="_blank" rel="noopener noreferrer" className="shrink-0 text-muted-foreground hover:text-foreground" aria-label="Open article">
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="rounded-lg border border-foreground/10 p-4">
          <h2 className="text-sm font-semibold">Your replies for this question</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Replies you linked to this prompt when marking them posted.
          </p>
          {placements.length === 0 ? (
            <p className="mt-2 text-xs italic text-muted-foreground">
              none yet · <Link href="/today" className="underline underline-offset-2">open Today</Link>
            </p>
          ) : (
            <ul className="mt-2 space-y-1 text-sm">
              {placements.map((p) => (
                <li key={p.id} className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 truncate">
                    <span className="text-xs text-muted-foreground">{surfaceLabel(p.surface)}</span> {p.title}
                    <span className="ml-1 text-xs text-muted-foreground">({p.status}{p.publishedAt ? ` · ${formatWhen(p.publishedAt)}` : ""})</span>
                  </span>
                  <a href={p.publishedUrl ?? p.url} target="_blank" rel="noopener noreferrer" className="shrink-0 text-muted-foreground hover:text-foreground" aria-label="Open reply">
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
