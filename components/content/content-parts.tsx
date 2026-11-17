import Link from "next/link";
import { ChevronRight, ExternalLink, Loader2, X } from "lucide-react";
import { InlineConfirm } from "@/components/ui/inline-confirm";
import { TOPIC_INTENT_LABEL } from "@/lib/keywords/intent";
import { threadHost } from "@/lib/keywords/questions";
import { TOPIC_SOURCE_LABEL } from "@/lib/keywords/source";
import { CONTENT_PATHS } from "@/lib/content-paths";
import { contentStatusLabel, type ContentArticle, type ContentDay, type ContentStatus, type ContentTopic } from "@/lib/calendar/content-plan";
import type { ContentView } from "@/lib/calendar/content";
import { cn, pluralize } from "@/lib/utils";

/**
 * The pieces of the Content screen (`/content`), stateless: the container
 * (content-screen.tsx) reads GET /api/content and passes the view and the
 * handlers. Rendered on their own in tests.
 *
 * Phone first: one column, rows of 56px, every control 44px. From `lg` the
 * day (today, the week) sits beside the plan (next topics, all articles).
 */

/** Where a held article is dealt with: Today lists it under "Also today". */
export const TODAY_PATH = "/today";
export const AUTOPILOT_SETTINGS_PATH = "/settings/automation";

const SECTION_HEADING = "text-xs font-semibold uppercase tracking-wide text-muted-foreground";
const CARD = "rounded-xl border bg-card";

/** The colour a status is said in; muted for everything that needs nobody. */
export function statusTone(status: ContentStatus): string {
  switch (status) {
    case "published":
      return "text-emerald-700 dark:text-emerald-400";
    case "waiting":
      return "text-amber-700 dark:text-amber-400";
    case "skipped":
      return "text-red-700 dark:text-red-400";
    default:
      return "text-muted-foreground";
  }
}

/** Today's status as a sentence: what is happening, and why it waits when it does. */
export function todayLine(article: ContentArticle): string {
  switch (article.status) {
    case "published":
      return "Published";
    case "scheduled":
      return "Scheduled";
    case "writing":
      return "Writing now";
    case "written":
      return "Written, not on your site yet";
    case "waiting":
      return `Waiting for you: ${article.reasons[0]}`;
    case "skipped":
      return "Skipped: writing failed";
    default:
      return contentStatusLabel(article.status, article.articleStatus);
  }
}

export function ContentHeader({ view }: { view: Pick<ContentView, "autopilot" | "site"> }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-3xl font-bold">Content</h1>
        {view.autopilot && (
          <p className="mt-1 text-sm text-muted-foreground break-words">
            One article a day{view.site.host ? ` for ${view.site.host}` : ""}.
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

export function TodayCard({
  article,
  opening,
  onOpen,
}: {
  article: ContentArticle | null;
  /** The article being fetched for the modal. */
  opening: string | null;
  onOpen: (articleId: string) => void;
}) {
  return (
    <section aria-labelledby="content-today" className={cn(CARD, "flex flex-col gap-1 p-4")}>
      <h2 id="content-today" className="text-xs font-semibold text-muted-foreground">
        Today
      </h2>
      {article ? (
        <>
          <button
            type="button"
            onClick={() => onOpen(article.id)}
            className="flex min-h-11 items-center gap-2 text-left text-base font-semibold leading-snug hover:underline"
          >
            <span className="break-words">{article.title ?? "Untitled article"}</span>
            {opening === article.id && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" aria-label="Opening" />}
          </button>
          <p className={cn("text-sm line-clamp-3", statusTone(article.status))}>{todayLine(article)}</p>
          {article.status === "waiting" && (
            <Link href={TODAY_PATH} className="inline-flex min-h-11 w-fit items-center gap-1 text-sm font-semibold hover:underline">
              Fix it in Today
              <ChevronRight className="h-4 w-4" aria-hidden />
            </Link>
          )}
          {article.status === "published" && article.publishedUrl && (
            <a
              href={article.publishedUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-11 w-fit items-center gap-1 text-sm font-semibold hover:underline"
            >
              Open on your site
              <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            </a>
          )}
        </>
      ) : (
        <p className="py-2 text-sm text-muted-foreground">Nothing is scheduled today.</p>
      )}
    </section>
  );
}

function WeekRow({ day, opening, onOpen }: { day: ContentDay; opening: string | null; onOpen: (articleId: string) => void }) {
  const weekday = (
    <span className={cn("w-9 shrink-0 text-xs font-semibold", day.isToday ? "text-foreground" : "text-muted-foreground")}>
      {day.weekday}
    </span>
  );
  const article = day.article;
  if (!article) {
    return (
      <div className="flex min-h-14 items-center gap-3 px-3.5 py-2" aria-current={day.isToday ? "date" : undefined}>
        {weekday}
        <span className="flex-1 text-sm text-muted-foreground">No article</span>
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onOpen(article.id)}
      aria-current={day.isToday ? "date" : undefined}
      className={cn(
        "flex min-h-14 w-full items-center gap-3 px-3.5 py-2 text-left transition-colors hover:bg-muted/40",
        day.isToday && "bg-muted/30"
      )}
    >
      {weekday}
      <span className="min-w-0 flex-1 truncate text-sm">{article.title ?? "Untitled article"}</span>
      {opening === article.id ? (
        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" aria-label="Opening" />
      ) : (
        <span className={cn("shrink-0 text-xs", statusTone(article.status))}>
          {contentStatusLabel(article.status, article.articleStatus)}
        </span>
      )}
    </button>
  );
}

export function WeekList({ week, opening, onOpen }: { week: ContentDay[]; opening: string | null; onOpen: (articleId: string) => void }) {
  return (
    <section aria-labelledby="content-week" className="flex flex-col gap-2">
      <h2 id="content-week" className={SECTION_HEADING}>
        This week
      </h2>
      <ul className={cn(CARD, "overflow-hidden")}>
        {week.map((day) => (
          <li key={day.day} className="border-t first:border-t-0">
            <WeekRow day={day} opening={opening} onOpen={onOpen} />
          </li>
        ))}
      </ul>
    </section>
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

/** The links under the topics: only what has something in it. */
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
    <div className="flex flex-col gap-2">
      {rows.map((row) => (
        <Link
          key={row.href}
          href={row.href}
          className={cn("flex min-h-11 items-center justify-between gap-3 rounded-lg border px-3.5 text-sm hover:opacity-90", row.tone)}
        >
          <span>{row.text}</span>
          <ChevronRight className="h-4 w-4 shrink-0" aria-hidden />
        </Link>
      ))}
    </div>
  );
}

export function AllArticlesLink({ total }: { total: number }) {
  return (
    <Link
      href={CONTENT_PATHS.articles}
      className="flex min-h-[52px] items-center justify-between gap-3 rounded-xl border px-3.5 hover:bg-muted/40"
    >
      <span className="text-sm font-semibold">All articles · {total}</span>
      <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden />
    </Link>
  );
}
