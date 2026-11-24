import Link from "next/link";
import { ChevronRight, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InlineConfirm } from "@/components/ui/inline-confirm";
import { TOPIC_INTENT_LABEL } from "@/lib/keywords/intent";
import { threadHost } from "@/lib/keywords/questions";
import { TOPIC_SOURCE_LABEL } from "@/lib/keywords/source";
import { CONTENT_PATHS } from "@/lib/content-paths";
import type { ContentTopic } from "@/lib/calendar/content-plan";
import type { ContentView } from "@/lib/calendar/content";
import { cn, pluralize } from "@/lib/utils";

/**
 * The pieces of the Content screen (`/content`) around the calendar,
 * stateless: the container (content-screen.tsx) reads GET /api/content and
 * passes the view and the handlers. Rendered on their own in tests.
 *
 * Phone first: one column, rows of 56px, every control 44px. The header
 * (Autopilot, the links to the topics) sits above the calendar; the topics
 * Autopilot picks next sit under it.
 */

export const AUTOPILOT_SETTINGS_PATH = "/settings/automation";

export const SECTION_HEADING = "text-xs font-semibold uppercase tracking-wide text-muted-foreground";
const CARD = "rounded-xl border bg-card";
const CHIP = "inline-flex min-h-11 max-w-full items-center gap-1.5 rounded-lg border px-3 text-sm hover:opacity-90 md:min-h-9";

/**
 * The title, and once GET /api/content has answered, the Autopilot state:
 * what its last run did, and why it did less when it did (amber). `null`
 * while it loads: the title alone, so the calendar under it never waits.
 */
export function ContentHeader({
  view,
}: {
  view: (Pick<ContentView, "autopilot" | "site"> & Partial<Pick<ContentView, "autopilotRun">>) | null;
}) {
  if (!view) return <h1 className="text-3xl font-bold">Content</h1>;
  const run = view.autopilotRun ?? null;
  const attention = run?.state === "stalled" || run?.state === "skipped";
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-3xl font-bold">Content</h1>
        {view.autopilot && (
          <p className="mt-1 text-sm text-muted-foreground break-words">
            One article a day{view.site.host ? ` for ${view.site.host}` : ""}.
          </p>
        )}
        {run && (
          <p
            role={attention ? "status" : undefined}
            data-testid="autopilot-run"
            className={cn(
              "mt-1 text-sm break-words",
              attention ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"
            )}
          >
            {attention ? "Autopilot: " : ""}
            {run.message}
          </p>
        )}
      </div>
      <Link
        href={AUTOPILOT_SETTINGS_PATH}
        className="inline-flex min-h-11 shrink-0 items-center gap-2 text-sm text-muted-foreground hover:text-foreground md:min-h-8"
      >
        <span
          aria-hidden
          className={cn("h-2 w-2 rounded-full", view.autopilot ? "bg-emerald-500" : "bg-muted-foreground/40")}
        />
        {view.autopilot ? "Autopilot on" : "Autopilot off"}
      </Link>
    </div>
  );
}

/**
 * Everything above the calendar: the title, the Autopilot state and the
 * links to the topics; while GET /api/content has not answered, the title
 * alone, and if it failed, a way to read it again.
 */
export function ContentTop({
  view,
  failed,
  onRetry,
}: {
  view: ContentView | null;
  failed: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <ContentHeader view={view} />
      {view ? (
        <TopicLinks view={view} />
      ) : (
        failed && (
          <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
            <p>The Autopilot state and the topics could not be loaded.</p>
            <Button variant="outline" className="h-11 md:h-9" onClick={onRetry}>
              Try again
            </Button>
          </div>
        )
      )}
    </div>
  );
}

/** Where a topic came from, in words: a question names the site it was asked on. */
export function topicSourceLine(topic: Pick<ContentTopic, "source" | "sourceUrl">): string {
  if (topic.source === "question") {
    const host = topic.sourceUrl ? threadHost(topic.sourceUrl) : null;
    return host ? `${TOPIC_SOURCE_LABEL.question} · ${host}` : TOPIC_SOURCE_LABEL.question;
  }
  return TOPIC_SOURCE_LABEL[topic.source];
}

export function TopicRow({ topic, onRemove }: { topic: ContentTopic; onRemove: (topicId: string) => void }) {
  return (
    <div className="flex min-h-14 items-center gap-2 py-1.5 pl-3.5 pr-1.5">
      <div className="min-w-0 flex-1">
        <p className="break-words text-sm leading-snug">{topic.keyword}</p>
        <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
          <span>{topicSourceLine(topic)}</span>
          {topic.intent && (
            <span className="rounded border px-1 py-px text-[11px] leading-none" title="The kind of search this topic answers">
              {TOPIC_INTENT_LABEL[topic.intent]}
            </span>
          )}
        </p>
      </div>
      <InlineConfirm
        question="Remove this topic?"
        confirmLabel="Remove"
        onConfirm={() => onRemove(topic.id)}
        className="shrink-0 text-right"
        buttonClassName="inline-flex min-h-11 min-w-11 items-center justify-center px-1 text-xs hover:underline"
        trigger={(ask) => (
          <button
            type="button"
            onClick={ask}
            aria-label={`Remove ${topic.keyword}`}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      />
    </div>
  );
}

export function NextTopicsList({
  topics,
  total,
  onRemove,
}: {
  topics: ContentTopic[];
  total: number;
  onRemove: (topicId: string) => void;
}) {
  return (
    <ul className={cn(CARD, "overflow-hidden")}>
      {topics.length === 0 ? (
        <li className="px-3.5 py-4 text-sm text-muted-foreground">No topics to write about yet.</li>
      ) : (
        topics.map((topic) => (
          <li key={topic.id} className="border-t first:border-t-0">
            <TopicRow topic={topic} onRemove={onRemove} />
          </li>
        ))
      )}
      <li className="border-t">
        <Link
          href={CONTENT_PATHS.topics}
          className="flex min-h-12 items-center justify-between gap-3 px-3.5 text-sm font-medium hover:bg-muted/40"
        >
          <span>All topics{total > topics.length ? ` · ${total} to pick from` : ""}</span>
          <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden />
        </Link>
      </li>
    </ul>
  );
}

/**
 * The way to the topics, above the calendar: every topic, then the two
 * sections of the topics view worth a look, only when they have something
 * in them. Chips that wrap, 44px tall on a phone.
 */
export function TopicLinks({ view }: { view: Pick<ContentView, "topicsTotal" | "overlapGroups" | "questionsWaiting"> }) {
  return (
    <nav aria-label="Topics" className="flex flex-wrap gap-2">
      <Link href={CONTENT_PATHS.topics} className={cn(CHIP, "bg-card font-semibold")}>
        <span>Next topics{view.topicsTotal > 0 ? ` · ${view.topicsTotal} to pick from` : ""}</span>
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      </Link>
      <TopicNotices view={view} />
    </nav>
  );
}

/** The links beside "Next topics": only what has something in it. */
export function TopicNotices({ view }: { view: Pick<ContentView, "overlapGroups" | "questionsWaiting"> }) {
  const rows: Array<{ href: string; text: string; tone: string }> = [];
  if (view.overlapGroups > 0) {
    rows.push({
      href: CONTENT_PATHS.overlapping,
      text: `${pluralize(view.overlapGroups, "group of topics overlaps", "groups of topics overlap")}`,
      tone: "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200",
    });
  }
  if (view.questionsWaiting !== null && view.questionsWaiting > 0) {
    rows.push({
      href: CONTENT_PATHS.questions,
      text: `Questions people ask · ${view.questionsWaiting}`,
      tone: "bg-card",
    });
  }
  if (rows.length === 0) return null;
  return (
    <>
      {rows.map((row) => (
        <Link key={row.href} href={row.href} className={cn(CHIP, row.tone)}>
          <span className="min-w-0 break-words">{row.text}</span>
          <ChevronRight className="h-4 w-4 shrink-0" aria-hidden />
        </Link>
      ))}
    </>
  );
}
