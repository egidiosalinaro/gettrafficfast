"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Article,
  ArticleStatus,
  FailedArticleCard,
  GeneratedArticleCard,
  NeedsReviewArticleCard,
  PublishedArticleCard,
  QueuedArticleCard,
} from "./article-card";
import { GenerationStatus } from "./generation-status";
import {
  articleDateLine,
  articleDay,
  calendarList,
  calendarMonths,
  dayHeading,
  dayKey,
  PUBLISHED_LOOKBACK_DAYS,
  type CalendarListSections,
  type MonthBlock,
  type MonthRef,
} from "./calendar-model";
import { cn, pluralize } from "@/lib/utils";

// Once an article has content or is live it stays put; only not-yet-written
// articles (queued / failed) can be dragged to reschedule.
const NON_DRAGGABLE: ArticleStatus[] = ["published", "generating", "generated"];

// Pixels the pointer must travel before a press turns into a drag (so clicking
// the view/remove buttons on a card still registers as a click).
const DRAG_THRESHOLD = 5;

/**
 * Drag-and-drop rescheduling exists only where the grid does, from `md` up.
 * Below it the board is a list, scrolling is the gesture, and nothing on the
 * page may claim the touch with `touch-action: none`.
 */
export const DRAG_MEDIA_QUERY = "(min-width: 768px)";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Monday first, in English, like the rest of the product. */
export const WEEKDAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function monthName({ year, month }: MonthRef): string {
  return `${MONTH_NAMES[month]} ${year}`;
}

interface CalendarProps {
  articles: Article[];
  onRemoveArticle?: (articleId: string) => void;
  onViewArticle?: (articleId: string) => void;
  onRequeueArticle?: (articleId: string) => void;
  onMoveArticle?: (articleId: string, targetDate: string) => void;
  onGenerateNow?: (articleId: string) => void;
}

interface DragSession {
  id: string;
  startX: number;
  startY: number;
  active: boolean;
}

interface DragState {
  id: string;
  x: number;
  y: number;
  valid: boolean;
}

interface RenderItem {
  article: Article;
  dateStr: string;
  ghost: boolean;
}

type CardRenderer = (article: Article, withActions: boolean, dateLine?: string) => React.ReactNode;

export function Calendar({
  articles,
  onRemoveArticle,
  onViewArticle,
  onRequeueArticle,
  onMoveArticle,
  onGenerateNow,
}: CalendarProps) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const [dragOverDate, setDragOverDate] = useState<string | null>(null);

  const sessionRef = useRef<DragSession | null>(null);
  // Keep the latest onMoveArticle without re-binding window listeners.
  const onMoveRef = useRef(onMoveArticle);
  useEffect(() => {
    onMoveRef.current = onMoveArticle;
  }, [onMoveArticle]);

  const today = new Date();
  const todayKey = dayKey(today);

  const targetDateAt = useCallback((x: number, y: number): string | null => {
    const el = document
      .elementFromPoint(x, y)
      ?.closest<HTMLElement>("[data-day-cell]");
    const date = el?.getAttribute("data-day-cell") ?? null;
    if (!date) return null;
    return date >= dayKey(new Date()) ? date : null;
  }, []);

  const handlePointerMove = useCallback(
    (e: PointerEvent) => {
      const session = sessionRef.current;
      if (!session) return;
      if (!session.active) {
        const dist = Math.hypot(e.clientX - session.startX, e.clientY - session.startY);
        if (dist < DRAG_THRESHOLD) return;
        session.active = true;
      }
      const date = targetDateAt(e.clientX, e.clientY);
      setDragOverDate(date);
      setDrag({ id: session.id, x: e.clientX, y: e.clientY, valid: date !== null });
    },
    [targetDateAt]
  );

  const handlePointerUp = useCallback(
    (e: PointerEvent) => {
      const session = sessionRef.current;
      window.removeEventListener("pointermove", handlePointerMove);
      // eslint-disable-next-line react-hooks/immutability -- the handler removes itself as a listener; flagged by eslint-plugin-react-hooks 7.1
      window.removeEventListener("pointerup", handlePointerUp);
      sessionRef.current = null;
      setDrag(null);
      setDragOverDate(null);
      if (!session || !session.active) return;
      const date = targetDateAt(e.clientX, e.clientY);
      // Dropped on empty space / an invalid day: the card simply snaps back.
      if (date && onMoveRef.current) onMoveRef.current(session.id, date);
    },
    [handlePointerMove, targetDateAt]
  );

  // Safety net: drop listeners if the component unmounts mid-drag.
  useEffect(() => {
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [handlePointerMove, handlePointerUp]);

  const startDrag = useCallback(
    (e: React.PointerEvent, article: Article) => {
      if (e.button !== 0) return;
      const draggable =
        !!onMoveArticle && !NON_DRAGGABLE.includes(article.status);
      if (!draggable) return;
      // The grid is hidden below md; this guards a window resized mid-press.
      if (typeof window.matchMedia === "function" && !window.matchMedia(DRAG_MEDIA_QUERY).matches) {
        return;
      }
      sessionRef.current = {
        id: article.id,
        startX: e.clientX,
        startY: e.clientY,
        active: false,
      };
      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
    },
    [onMoveArticle, handlePointerMove, handlePointerUp]
  );

  const cardFor = useCallback<CardRenderer>(
    (article, withActions, dateLine) => {
      const actions = withActions
        ? {
            onRemove: onRemoveArticle,
            onView: onViewArticle,
            onGenerateNow,
          }
        : {};
      switch (article.status) {
        case "published":
          return <PublishedArticleCard article={article} dateLine={dateLine} {...actions} />;
        case "generated":
          return <GeneratedArticleCard article={article} dateLine={dateLine} {...actions} />;
        case "needs_review":
          return <NeedsReviewArticleCard article={article} dateLine={dateLine} {...actions} />;
        case "failed":
          return (
            <FailedArticleCard
              article={article}
              dateLine={dateLine}
              {...actions}
              onRequeue={withActions ? onRequeueArticle : undefined}
            />
          );
        default:
          return (
            <QueuedArticleCard
              article={article}
              dateLine={dateLine}
              {...actions}
              onGenerateNow={withActions ? onGenerateNow : undefined}
            />
          );
      }
    },
    [onRemoveArticle, onViewArticle, onRequeueArticle, onGenerateNow]
  );

  const generatingCount = useMemo(
    () => articles.filter((a) => a.status === "generating").length,
    [articles]
  );

  // Earliest queued article: this is what the next cron run will actually
  // generate, so the countdown can point at the real next generation.
  const nextQueuedDate = useMemo(() => {
    const dates = articles
      .filter((a) => a.status === "queued")
      .map((a) => articleDay(a) ?? "")
      .filter(Boolean)
      .sort();
    return dates[0] ?? null;
  }, [articles]);

  const draggedArticle = drag ? articles.find((a) => a.id === drag.id) ?? null : null;

  // While dragging, hide the picked-up card from the grid (it floats under the
  // cursor) and, if it's over a day that already has an article, preview that
  // article moving as a ghost onto the day being dragged from (the swap).
  const renderItems = useMemo<RenderItem[]>(() => {
    const activeId = drag?.id ?? null;
    if (!activeId) {
      return articles.map((a) => ({
        article: a,
        dateStr: articleDay(a) ?? "",
        ghost: false,
      }));
    }
    const dragged = articles.find((a) => a.id === activeId) ?? null;
    const sourceDate = dragged ? articleDay(dragged) : null;
    const occupant =
      dragged && dragOverDate && dragOverDate !== sourceDate
        ? articles.find(
            (a) => articleDay(a) === dragOverDate && a.id !== activeId
          ) ?? null
        : null;

    const items: RenderItem[] = [];
    for (const a of articles) {
      if (a.id === activeId) continue; // floating with the cursor
      if (occupant && a.id === occupant.id && sourceDate) {
        items.push({ article: a, dateStr: sourceDate, ghost: true });
        continue;
      }
      items.push({ article: a, dateStr: articleDay(a) ?? "", ghost: false });
    }
    return items;
  }, [articles, drag, dragOverDate]);

  // Recomputed when the articles change or the day turns over.
  const blocks = useMemo(
    () => calendarMonths(articles, new Date(`${todayKey}T12:00:00`)),
    [articles, todayKey]
  );
  const sections = useMemo(
    () => calendarList(articles, new Date(`${todayKey}T12:00:00`)),
    [articles, todayKey]
  );

  const itemsByDate = useMemo(() => {
    const map = new Map<string, RenderItem[]>();
    for (const item of renderItems) {
      if (!item.dateStr) continue;
      const list = map.get(item.dateStr);
      if (list) list.push(item);
      else map.set(item.dateStr, [item]);
    }
    return map;
  }, [renderItems]);

  const status = (
    <GenerationStatus generatingCount={generatingCount} nextQueuedDate={nextQueuedDate} />
  );
  const firstGrid = blocks.findIndex((block) => block.kind === "month");

  return (
    <div>
      {/* Phones: a list grouped by day. No drag, nothing that blocks scrolling. */}
      <div className="md:hidden space-y-6" data-view="list">
        <div className="flex justify-end">{status}</div>
        <CalendarList sections={sections} today={today} renderCard={cardFor} />
      </div>

      {/* md and up: the month grid, where cards can be dragged to a new day. */}
      <div className="hidden md:block space-y-12" data-view="grid">
        {blocks.map((block, index) =>
          block.kind === "empty" ? (
            <EmptyMonths key={`empty-${block.from.year}-${block.from.month}`} block={block} />
          ) : (
            <MonthGrid
              key={`${block.year}-${block.month}`}
              month={block}
              todayKey={todayKey}
              itemsByDate={itemsByDate}
              dragOverDate={dragOverDate}
              isDragging={drag !== null}
              canDrag={(article) => !!onMoveArticle && !NON_DRAGGABLE.includes(article.status)}
              onCardPointerDown={startDrag}
              renderCard={cardFor}
              rightSlot={index === firstGrid ? status : undefined}
            />
          )
        )}
      </div>

      {/* The picked-up card, following the cursor */}
      {drag && draggedArticle && (
        <div
          className={cn(
            "pointer-events-none fixed z-[9999] w-44 -rotate-2 opacity-90",
            "rounded-lg drop-shadow-2xl",
            drag.valid && "ring-2 ring-primary rounded-lg"
          )}
          style={{ left: drag.x - 88, top: drag.y - 16 }}
        >
          {cardFor(draggedArticle, false)}
        </div>
      )}
    </div>
  );
}

function EmptyMonths({ block }: { block: Extract<MonthBlock, { kind: "empty" }> }) {
  const single = block.from.year === block.to.year && block.from.month === block.to.month;
  return (
    <p className="rounded-lg border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">
      {single ? monthName(block.from) : `${monthName(block.from)} to ${monthName(block.to)}`}
      : nothing scheduled
    </p>
  );
}

function MonthGrid({
  month,
  todayKey,
  itemsByDate,
  dragOverDate,
  isDragging,
  canDrag,
  onCardPointerDown,
  renderCard,
  rightSlot,
}: {
  month: Extract<MonthBlock, { kind: "month" }>;
  todayKey: string;
  itemsByDate: Map<string, RenderItem[]>;
  dragOverDate: string | null;
  isDragging: boolean;
  canDrag: (article: Article) => boolean;
  onCardPointerDown: (e: React.PointerEvent, article: Article) => void;
  renderCard: CardRenderer;
  rightSlot?: React.ReactNode;
}) {
  const { year, month: monthIndex } = month;
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  const startingDayOfWeek = new Date(year, monthIndex, 1).getDay();
  // Monday first: Sunday (0) goes to the end of the week.
  const leadingBlanks = startingDayOfWeek === 0 ? 6 : startingDayOfWeek - 1;

  const cells: Array<number | null> = [
    ...Array.from({ length: leadingBlanks }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold">{monthName(month)}</h2>
          <p className="text-sm text-muted-foreground mt-1">
            {month.count === 0
              ? "Nothing scheduled this month"
              : `${pluralize(month.count, "article")} this month`}
          </p>
        </div>
        {rightSlot}
      </div>

      <div className="border border-border rounded-lg overflow-hidden">
        <div className="grid grid-cols-7 border-b border-border bg-muted/30">
          {WEEKDAY_NAMES.map((day) => (
            <div
              key={day}
              className="p-2 text-center text-xs font-medium text-foreground border-r border-border last:border-r-0"
            >
              {day}
            </div>
          ))}
        </div>

        <div className="grid grid-cols-7">
          {cells.map((day, index) => {
            if (day === null) {
              return (
                <div
                  key={`blank-${index}`}
                  className="min-h-[120px] border-r border-b border-border last:border-r-0 bg-muted/10"
                />
              );
            }

            const cellKey = `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
            const dayItems = itemsByDate.get(cellKey) ?? [];
            const isToday = cellKey === todayKey;
            const isFuture = cellKey >= todayKey;
            const isDropTarget = dragOverDate === cellKey;

            return (
              <div
                key={day}
                data-day-cell={cellKey}
                className={cn(
                  "min-h-[120px] min-w-0 border-r border-b border-border last:border-r-0 p-1.5 lg:p-2 space-y-2",
                  isToday && "bg-primary/5",
                  isDragging && isFuture && "bg-primary/[0.03]",
                  isDropTarget && "ring-2 ring-inset ring-primary bg-primary/10"
                )}
              >
                <div className="mb-1">
                  {isToday ? (
                    <div className="w-6 h-6 rounded-full border-2 border-foreground flex items-center justify-center text-xs font-medium">
                      {day}
                    </div>
                  ) : (
                    <div className="text-xs font-medium">{day}</div>
                  )}
                </div>
                <div className="space-y-2">
                  {dayItems.map((item) => {
                    if (item.ghost) {
                      return (
                        <div key={item.article.id} className="pointer-events-none opacity-50">
                          {renderCard(item.article, false)}
                        </div>
                      );
                    }
                    const draggable = canDrag(item.article);
                    return (
                      <div
                        key={item.article.id}
                        onPointerDown={(e) => onCardPointerDown(e, item.article)}
                        className={cn(
                          draggable &&
                            "md:touch-none cursor-grab active:cursor-grabbing select-none"
                        )}
                      >
                        {renderCard(item.article, true)}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * The phone board: full-width cards grouped by day, what is coming first,
 * then what went live in the last 30 days.
 */
export function CalendarList({
  sections,
  today,
  renderCard,
}: {
  sections: CalendarListSections;
  today: Date;
  renderCard: CardRenderer;
}) {
  if (sections.upcoming.length === 0 && sections.published.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Nothing scheduled, and nothing published in the last {PUBLISHED_LOOKBACK_DAYS} days.
      </p>
    );
  }

  const group = (title: string, groups: CalendarListSections["upcoming"], empty: string) => (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold">{title}</h2>
      {groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        groups.map((g) => (
          <div key={g.day || "undated"} className="space-y-2">
            <h3 className="text-sm font-medium text-muted-foreground">{dayHeading(g.day, today)}</h3>
            <ul className="space-y-2">
              {g.articles.map((article) => (
                <li key={article.id}>
                  {renderCard(article, true, articleDateLine(article, today))}
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </section>
  );

  return (
    <div className="space-y-8">
      {group("Coming up", sections.upcoming, "Nothing waiting to be written or published.")}
      {group(
        `Published, last ${PUBLISHED_LOOKBACK_DAYS} days`,
        sections.published,
        `Nothing published in the last ${PUBLISHED_LOOKBACK_DAYS} days.`
      )}
    </div>
  );
}
