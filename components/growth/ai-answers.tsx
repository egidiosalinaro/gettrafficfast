"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ChevronLeft, Loader2, Play, Settings2 } from "lucide-react";
import { PeriodSwitch } from "@/components/growth/period-switch";
import { shortUrl } from "@/components/growth/growth-view";
import { CITED_PLACES_HREF } from "@/components/visibility/places-line";
import { engineLabel } from "@/lib/domain/operating-loop";
import { formatCount, formatDay } from "@/lib/format";
import type { GrowthDays } from "@/lib/growth/period";
import type { AskSetup } from "@/lib/growth/read";
import { GROWTH_AI_PATH, GROWTH_AI_SETTINGS_PATH, GROWTH_PATH, growthHref, questionPath } from "@/lib/growth/routes";
import type { AiAnswersPage } from "@/lib/growth/schema";
import { cn, pluralize } from "@/lib/utils";

/**
 * `/growth/ai`: the evidence behind Growth's AI count. The owner asked "how
 * do we verify a citation?": here every ask of the period is one card, with
 * the question, the engine, the day, the verdict, the sources the engine
 * returned (numbered, the site's own marked "you", the ones now open in
 * Today marked), and the stored start of the answer behind "Read the
 * answer". An article check keeps only the verdict and the cited page, and
 * says so instead of showing an empty list.
 *
 * Below the list: the questions we ask (the prompt set), Run now and
 * Configure, as on the old Prompts page.
 */

type Answer = AiAnswersPage["answers"][number];

const FIRST_SOURCES = 5;
const POLL_MS = 5_000;

const BADGE: Record<Answer["status"], { label: string; className: string }> = {
  cited: { label: "Cited you", className: "bg-emerald-600 text-white dark:bg-emerald-400 dark:text-emerald-950" },
  not_cited: { label: "Not cited", className: "bg-muted text-foreground" },
  invalid: { label: "No readable answer", className: "border border-border text-muted-foreground" },
  error: { label: "Failed", className: "border border-border text-muted-foreground" },
};

/**
 * The sources a card shows before "All N sources": the first five, and any
 * later one that is the site's own or a place in Today, at its own number,
 * so the evidence that matters is never folded away. Up to one more than
 * five, all of them: a fold that hides a single line saves nothing.
 */
export function shownSources(sources: Answer["sources"], all: boolean): Answer["sources"] {
  if (all || sources.length <= FIRST_SOURCES + 1) return sources;
  return sources.filter((s, i) => i < FIRST_SOURCES || s.ours || s.inToday);
}

function askedOn(answer: Answer): string {
  return formatDay(answer.askedAt.slice(0, 10));
}

function SourceRow({ source }: { source: Answer["sources"][number] }) {
  const label = source.opensPage ? shortUrl(source.url) : (source.title ?? source.domain);
  const body = (
    <>
      <span className="w-4 shrink-0 text-right tabular-nums text-muted-foreground">{source.position}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {source.ours && <span className="shrink-0 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">you</span>}
      {source.inToday && <span className="shrink-0 text-[11px] font-semibold text-amber-600 dark:text-amber-400">in Today</span>}
    </>
  );
  // A row that opens the page is a 44px target; one that cannot (the
  // engine's redirect) is a line of text and stays compact.
  const className = cn(
    "flex items-center gap-2 rounded-lg px-2.5 text-[13px]",
    source.opensPage ? "min-h-11 md:min-h-9" : "min-h-8 py-1",
    source.ours && "bg-emerald-500/10"
  );
  return (
    <li>
      {source.opensPage ? (
        <a href={source.url} target="_blank" rel="noopener noreferrer" className={cn(className, "hover:bg-muted/40")}>
          {body}
        </a>
      ) : (
        <span className={className} title="The engine gave a redirect for this source, not the page: it names the site.">
          {body}
        </span>
      )}
    </li>
  );
}

export function AnswerCard({ answer }: { answer: Answer }) {
  const [open, setOpen] = useState(false);
  const [allSources, setAllSources] = useState(false);
  const badge = BADGE[answer.status];
  const sources = shownSources(answer.sources, allSources);
  const folded = answer.sources.length - sources.length;

  return (
    <article className="flex flex-col gap-2.5 rounded-2xl border border-border bg-card p-4" data-answer={answer.id}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          {engineLabel(answer.engine)} · {askedOn(answer)}
          {answer.kind === "article" && " · article check"}
        </span>
        <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold", badge.className)}>{badge.label}</span>
      </div>
      <p className="text-[15px] font-semibold leading-snug">“{answer.question}”</p>

      {answer.kind === "prompt" && answer.counted && answer.sources.length === 0 && (
        <p className="text-xs text-muted-foreground">The engine returned no sources for this answer.</p>
      )}
      {answer.sources.length > 0 && (
        <ol className="flex flex-col gap-0.5" aria-label="Sources the engine returned">
          {sources.map((source) => (
            <SourceRow key={`${source.position}-${source.url}`} source={source} />
          ))}
        </ol>
      )}
      {(folded > 0 || allSources) && (
        <button
          type="button"
          onClick={() => setAllSources((v) => !v)}
          className="inline-flex min-h-11 items-center self-start text-xs font-medium text-muted-foreground hover:text-foreground md:min-h-8"
        >
          {allSources ? "Fewer sources" : `All ${formatCount(answer.sources.length)} sources`}
        </button>
      )}

      {answer.kind === "article" &&
        (answer.citedUrl ? (
          <p className="flex min-w-0 items-center gap-2 rounded-lg bg-emerald-500/10 px-2.5 py-2 text-[13px]">
            <span className="min-w-0 flex-1 truncate">{shortUrl(answer.citedUrl)}</span>
            <span className="shrink-0 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">you</span>
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">The weekly article check keeps the verdict, not the sources.</p>
        ))}
      {!answer.counted && (
        <p className="text-xs text-muted-foreground">
          {answer.status === "error" ? "The call failed" : "The engine gave nothing readable"}: not counted.
          {answer.error ? ` ${answer.error}` : ""}
        </p>
      )}

      {answer.placesInToday > 0 && (
        <p className="text-[13px] leading-snug">
          {answer.placesInToday === 1 ? "1 of these pages is a place" : `${formatCount(answer.placesInToday)} of these pages are places`} to reply in
          Today.{" "}
          <Link href={CITED_PLACES_HREF} className="inline-flex min-h-11 items-center font-medium underline underline-offset-2 md:min-h-0">
            Open {answer.placesInToday === 1 ? "it" : "them"}
          </Link>
        </p>
      )}

      {(answer.excerpt || answer.promptId) && (
        <div className="flex flex-wrap items-center gap-x-4">
          {answer.excerpt && (
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
              className="inline-flex min-h-11 items-center text-[13px] font-semibold md:min-h-9"
            >
              {open ? "Hide the answer" : "Read the answer"}
            </button>
          )}
          {answer.promptId && (
            <Link
              href={questionPath(answer.promptId)}
              className="inline-flex min-h-11 items-center text-[13px] text-muted-foreground hover:text-foreground md:min-h-9"
            >
              This question over time
            </Link>
          )}
        </div>
      )}
      {open && answer.excerpt && (
        <div className="rounded-lg bg-background px-3 py-2.5">
          <p className="whitespace-pre-wrap text-[13px] leading-relaxed">{answer.excerpt}</p>
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            The start of the answer, as stored ({pluralize(answer.excerpt.length, "character")}), not the whole response.
          </p>
        </div>
      )}
    </article>
  );
}

function EngineChips({ page, days }: { page: AiAnswersPage; days: GrowthDays }) {
  const chips: Array<{ engine: string | null; label: string }> = [
    { engine: null, label: "All engines" },
    ...page.engines.map((engine) => ({ engine, label: engineLabel(engine) })),
  ];
  if (page.engine && !page.engines.includes(page.engine)) chips.push({ engine: page.engine, label: engineLabel(page.engine) });
  return (
    <nav aria-label="Engine" className="flex flex-wrap gap-1.5">
      {chips.map((chip) => {
        const active = chip.engine === page.engine;
        return (
          <Link
            key={chip.engine ?? "all"}
            href={growthHref(GROWTH_AI_PATH, days, { engine: chip.engine })}
            replace
            scroll={false}
            aria-current={active ? "true" : undefined}
            className={cn(
              "inline-flex min-h-11 items-center rounded-full px-3.5 text-[13px] md:min-h-9",
              active ? "bg-foreground font-semibold text-background" : "border border-border font-medium hover:bg-muted/40"
            )}
          >
            {chip.label}
          </Link>
        );
      })}
    </nav>
  );
}

export interface AnswersViewProps {
  page: AiAnswersPage;
  setup: AskSetup;
  days: GrowthDays;
  /** Answers loaded past the first page. */
  more?: AiAnswersPage["answers"];
  loadingMore?: boolean;
  onMore?: () => void;
  starting?: boolean;
  onRun?: () => void;
  error?: string | null;
}

/** What Run now asks: "Asks Gemini 30 of your 35 questions once." (the per-run cap holds). */
export function askLine(setup: AskSetup): string {
  const engines = setup.activeEngines.map(engineLabel).join(" and ");
  const { enabled, perRun } = setup.prompts;
  const what = perRun < enabled ? `${formatCount(perRun)} of your ${formatCount(enabled)} questions` : `your ${pluralize(enabled, "question")}`;
  return `Asks ${engines} ${what} once.`;
}

export function AnswersView({ page, setup, days, more = [], loadingMore, onMore, starting, onRun, error }: AnswersViewProps) {
  const answers = [...page.answers, ...more];
  const shownAll = page.offset + answers.length >= page.total;
  const running = setup.latestRun?.status === "running";
  const cannotRun =
    setup.activeEngines.length === 0 ? "No answer engine is on for this site." : setup.prompts.enabled === 0 ? "Add a question first." : null;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Link
        href={growthHref(GROWTH_PATH, days)}
        className="-ml-1 inline-flex min-h-11 items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="h-[18px] w-[18px]" aria-hidden /> Growth
      </Link>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[28px] font-bold leading-tight tracking-tight">AI answers</h1>
          <p className="mt-1 text-sm leading-snug text-muted-foreground">
            What the engines answered in the last {days} days, and the sites they cited. Each one is a sample, not a verdict.
          </p>
        </div>
        <PeriodSwitch days={days} path={GROWTH_AI_PATH} extra={{ engine: page.engine }} />
      </div>

      {(page.engines.length > 1 || page.engine) && <EngineChips page={page} days={days} />}

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      {answers.length === 0 ? (
        <div className="rounded-2xl border border-border bg-card p-4 text-sm">
          <p className="font-medium">
            No answers in the last {days} days{page.engine ? ` from ${engineLabel(page.engine)}` : ""}.
          </p>
          <p className="mt-1 text-muted-foreground">
            Nothing was asked in this period, so nothing is counted: not measured, not 0.
            {days === 7 && (
              <>
                {" "}
                <Link
                  href={growthHref(GROWTH_AI_PATH, 28, { engine: page.engine })}
                  className="inline-flex min-h-11 items-center font-medium text-foreground underline underline-offset-2 md:min-h-0"
                >
                  See 28 days
                </Link>
              </>
            )}
          </p>
        </div>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {pluralize(page.total, "answer")}, newest first. Sampled: one question asked once, not every AI answer.
          </p>
          <div className="space-y-3">
            {answers.map((answer) => (
              <AnswerCard key={answer.id} answer={answer} />
            ))}
          </div>
          {!shownAll && onMore && (
            <button
              type="button"
              onClick={onMore}
              disabled={loadingMore}
              className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-border text-sm font-medium hover:bg-muted/40 disabled:opacity-60"
            >
              {loadingMore && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
              Show more
            </button>
          )}
        </>
      )}

      <Link
        href={`${GROWTH_AI_SETTINGS_PATH}#prompts`}
        className="flex min-h-[52px] items-center justify-between rounded-xl border border-border bg-card px-4 hover:bg-muted/40"
      >
        <span className="text-sm font-semibold">Questions we ask · {formatCount(setup.prompts.enabled)}</span>
        <span className="text-[13px] text-muted-foreground">Edit</span>
      </Link>

      {setup.latestRun?.status === "failed" && setup.latestRun.error && (
        <p className="rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
          The last run failed: {setup.latestRun.error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onRun}
          disabled={!onRun || starting || running || cannotRun !== null}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-50"
        >
          {starting || running ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />}
          {running ? "Asking…" : "Run now"}
        </button>
        <Link
          href={GROWTH_AI_SETTINGS_PATH}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-border px-4 text-sm font-medium hover:bg-muted/40"
        >
          <Settings2 className="h-4 w-4" aria-hidden /> Configure
        </Link>
        <span className="text-xs text-muted-foreground">
          {cannotRun ??
            (running
              ? `Asking ${pluralize(setup.latestRun?.plannedProbes ?? 0, "question")} now. Answers appear here as they come.`
              : askLine(setup))}
        </span>
      </div>
    </div>
  );
}

type Payload = { hasBusiness: false } | { hasBusiness: true; answers: AiAnswersPage; setup: AskSetup };

/** The screen: reads GET /api/growth/answers for the period and engine, pages, and runs. */
export function AiAnswersScreen({ days, engine }: { days: GrowthDays; engine: string | null }) {
  const [data, setData] = useState<Payload | null>(null);
  const [more, setMore] = useState<AiAnswersPage["answers"]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const url = useCallback(
    (offset: number) => {
      const query = new URLSearchParams({ days: String(days), offset: String(offset) });
      if (engine) query.set("engine", engine);
      return `/api/growth/answers?${query.toString()}`;
    },
    [days, engine]
  );

  const load = useCallback(async () => {
    const response = await fetch(url(0), { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? "Could not load the answers");
    setData(payload as Payload);
    setMore([]);
  }, [url]);

  useEffect(() => {
    let cancelled = false;
    fetch(url(0), { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error ?? "Could not load the answers");
        if (!cancelled) setData(payload as Payload);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load the answers");
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  const running = data?.hasBusiness ? data.setup.latestRun?.status === "running" : false;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      load().catch(() => undefined);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [running, load]);

  if (!data) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        {error ?? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading the answers...
          </>
        )}
      </p>
    );
  }
  if (!data.hasBusiness) {
    return (
      <p className="text-sm text-muted-foreground">
        Set up your site first.{" "}
        <Link href="/settings/business" className="underline underline-offset-2">
          Settings, Business
        </Link>
      </p>
    );
  }

  const page = data.answers;
  const onMore = async () => {
    setLoadingMore(true);
    try {
      const response = await fetch(url(page.offset + page.answers.length + more.length), { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Could not load more");
      if (payload.hasBusiness) setMore((current) => [...current, ...(payload.answers as AiAnswersPage).answers]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load more");
    } finally {
      setLoadingMore(false);
    }
  };
  const onRun = async () => {
    setStarting(true);
    setError(null);
    try {
      const response = await fetch("/api/visibility/run", { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Could not start the run");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the run");
    } finally {
      setStarting(false);
    }
  };

  return (
    <AnswersView
      page={page}
      setup={data.setup}
      days={days}
      more={more}
      loadingMore={loadingMore}
      onMore={onMore}
      starting={starting}
      onRun={onRun}
      error={error}
    />
  );
}
