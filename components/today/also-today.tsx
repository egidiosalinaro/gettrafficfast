"use client";

import { useState } from "react";
import Link from "next/link";
import { UI_LOCALE } from "@/lib/format";
import type { AlsoTodayItem } from "@/lib/today/also-today";
import { BusyLabel, Problem } from "@/components/placements/ui";
import { PasteLinkButton } from "@/components/placements/posted-item";
import { answeredLine } from "@/components/placements/today-sheet";
import { postedPhrase } from "@/components/placements/reply-logic";

/**
 * "Also today" (2026-11-14): what needs a gesture today besides the
 * replies, one card each, with the action it already had (lib/today/
 * also-today.ts). An article opens where its actions live; a stale fact is
 * "Still true" here or "Update it" in Settings → Voice; a reply whose link
 * GTF stopped looking for has Paste link; a failed article can be ignored
 * here (it stays on the Content board). No card starts anything paid.
 * With nothing to show, nothing is rendered: no heading, no empty box.
 */

/** The primary action of a card: one per card, 44px on a phone. */
const CARD_PRIMARY =
  "relative inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-50";
/** The secondary one beside it. */
const CARD_SECONDARY =
  "inline-flex min-h-11 items-center justify-center rounded-lg border border-border px-4 text-sm font-medium text-foreground hover:bg-muted/60";

/** "Nov 12" for a `YYYY-MM-DD` day, read as that calendar day wherever the reader is. */
export function scheduledDay(date: string): string {
  const at = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(at.getTime()) ? at.toLocaleDateString(UI_LOCALE, { month: "short", day: "numeric", timeZone: "UTC" }) : date;
}

/** The small line over an article's card. */
export function articleLabel(item: Extract<AlsoTodayItem, { kind: "article_held" | "article_failed" }>): string {
  const which = item.isToday ? "Today's article" : `The article for ${scheduledDay(item.scheduledDate)}`;
  return item.kind === "article_held" ? `${which} is waiting for you` : `${which} failed`;
}

/** "Add 2 links and a new title, for “x growth tools”": what a push asks the person to do. */
export function pushSummary(item: Extract<AlsoTodayItem, { kind: "article_push" }>): string {
  const parts = [
    item.links > 0 ? `${item.links} link${item.links === 1 ? "" : "s"} from your best pages` : null,
    item.newTitle ? "a new search title" : null,
  ].filter(Boolean);
  return `Add ${parts.join(" and ")}, for “${item.mainQuery}”.`;
}

export interface AlsoTodayProps {
  items: AlsoTodayItem[];
  now: number;
  /** Rows whose request is running: their Paste link waits. */
  busyIds: ReadonlySet<string>;
  /** "Still true": null once recorded, else the sentence to show. */
  onConfirmFact: (sentence: string) => Promise<string | null>;
  /** Saves a posted reply's link: null once saved, else the server's sentence. */
  onSaveLink: (targetId: string, url: string) => Promise<string | null>;
  /** Ignore failed articles on Today (all of them when no ids): null once done, else the sentence to show. */
  onDismissFailed: (articleIds?: string[]) => Promise<string | null>;
}

export function AlsoToday({ items, now, busyIds, onConfirmFact, onSaveLink, onDismissFailed }: AlsoTodayProps) {
  const [busyAll, setBusyAll] = useState(false);
  const [problemAll, setProblemAll] = useState<string | null>(null);
  if (items.length === 0) return null;
  const failed = items.filter((item) => item.kind === "article_failed").length;
  const dismissAll = async () => {
    setBusyAll(true);
    setProblemAll(null);
    try {
      setProblemAll(await onDismissFailed());
    } finally {
      setBusyAll(false);
    }
  };
  return (
    <section aria-labelledby="also-today" className="space-y-3">
      <div className="flex items-center justify-between gap-3 pt-1">
        <h2 id="also-today" className="text-[13px] font-semibold uppercase tracking-wider text-muted-foreground">
          Also today
        </h2>
        {/* One gesture for a pile of old failures, instead of one per card. */}
        {failed >= 2 && (
          <button
            type="button"
            onClick={() => void dismissAll()}
            disabled={busyAll}
            aria-busy={busyAll || undefined}
            className="min-h-11 rounded-lg px-3 text-sm font-medium text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:opacity-50"
          >
            <BusyLabel busy={busyAll}>{`Ignore all ${failed} failed`}</BusyLabel>
          </button>
        )}
      </div>
      {problemAll && <Problem>{problemAll}</Problem>}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {items.map((item) => (
          <AlsoTodayCard
            key={item.id}
            item={item}
            now={now}
            busyIds={busyIds}
            onConfirmFact={onConfirmFact}
            onSaveLink={onSaveLink}
            onDismissFailed={onDismissFailed}
          />
        ))}
      </div>
    </section>
  );
}

function AlsoTodayCard({
  item,
  now,
  busyIds,
  onConfirmFact,
  onSaveLink,
  onDismissFailed,
}: Omit<AlsoTodayProps, "items"> & { item: AlsoTodayItem }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  if (item.kind === "fact_stale") {
    const confirm = async () => {
      setBusy(true);
      setProblem(null);
      try {
        setProblem(await onConfirmFact(item.sentence));
      } finally {
        setBusy(false);
      }
    };
    return (
      <article data-also={item.kind} className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4">
        <span className="text-xs font-semibold text-muted-foreground">Still true?</span>
        <span className="text-[15px] leading-snug">
          {/* The sentence says its own date; the age is what tells it is time to ask. Once confirmed, the age runs from the confirmation. */}
          &ldquo;{item.quote}&rdquo;
          <span className="text-muted-foreground">
            , {item.confirmedOn ? "confirmed" : "dated"} {item.age}
          </span>
        </span>
        <div className="mt-0.5 flex gap-2">
          <button type="button" onClick={() => void confirm()} disabled={busy} aria-busy={busy || undefined} className={CARD_PRIMARY}>
            <BusyLabel busy={busy}>Still true</BusyLabel>
          </button>
          <Link href={item.href} className={CARD_SECONDARY}>
            Update it
          </Link>
        </div>
        {problem && <Problem>{problem}</Problem>}
      </article>
    );
  }

  if (item.kind === "reply_link") {
    return (
      <article data-also={item.kind} className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4">
        <span className="text-xs font-semibold text-muted-foreground">Paste the link of your reply</span>
        {item.text && <span className="truncate text-[15px] leading-snug">&ldquo;{item.text}&rdquo;</span>}
        <span className="text-[13px] leading-snug text-muted-foreground">
          {answeredLine(item)} · {postedPhrase(item.publishedAt, null, now)}
        </span>
        <span className="text-[13px] leading-snug text-muted-foreground">{item.line}</span>
        <div className="mt-0.5 flex gap-2">
          <PasteLinkButton
            target={item}
            busy={busyIds.has(item.targetId)}
            primary
            onSave={(url) => onSaveLink(item.targetId, url)}
            onProblem={setProblem}
          />
        </div>
        {problem && <Problem>{problem}</Problem>}
      </article>
    );
  }

  if (item.kind === "article_push") {
    return (
      <article data-also={item.kind} className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4">
        <span className="text-xs font-semibold text-muted-foreground">Push this article</span>
        <span className="text-[15px] font-semibold leading-snug">{item.title}</span>
        <span className="text-sm leading-snug text-muted-foreground">{pushSummary(item)}</span>
        <div className="mt-0.5 flex gap-2">
          <Link href={item.href} className={CARD_PRIMARY}>
            See what to change
          </Link>
        </div>
      </article>
    );
  }

  const dismiss = async () => {
    setBusy(true);
    setProblem(null);
    try {
      setProblem(await onDismissFailed([item.articleId]));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article
      data-also={item.kind}
      className="flex flex-col gap-2 rounded-xl border border-amber-400/50 bg-amber-400/10 p-4"
    >
      <span className="text-xs font-semibold text-amber-700 dark:text-amber-300">{articleLabel(item)}</span>
      <span className="text-[15px] font-semibold leading-snug">{item.title}</span>
      {item.reason && (
        <span className="text-sm leading-snug text-muted-foreground">
          {item.reason}
          {item.moreReasons > 0 && ` (+${item.moreReasons} more)`}
        </span>
      )}
      <div className="mt-0.5 flex gap-2">
        <Link href={item.href} className={CARD_PRIMARY}>
          Open the article
        </Link>
        {item.kind === "article_failed" && (
          // Ignore: off Today only; the article stays failed on the Content board.
          <button type="button" onClick={() => void dismiss()} disabled={busy} aria-busy={busy || undefined} className={CARD_SECONDARY}>
            <BusyLabel busy={busy}>Ignore</BusyLabel>
          </button>
        )}
      </div>
      {problem && <Problem>{problem}</Problem>}
    </article>
  );
}
