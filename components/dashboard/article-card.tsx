"use client";

import { Eye, Trash2, BarChart3, RotateCcw, Zap, ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { InlineConfirm } from "@/components/ui/inline-confirm";
import type { CanonicalArticle } from "@/lib/content/types";
import type { QualityReport } from "@/lib/content/pipeline";
import { holdReasons } from "@/lib/content/hold-reasons";
import { formatCount } from "@/lib/format";
import { cn } from "@/lib/utils";

export type ArticleStatus =
  | "queued"
  | "generating"
  | "generated"
  | "needs_review"
  | "published"
  | "failed";

export interface Article {
  id: string;
  keywordId?: string;
  title?: string;
  keyword: string;
  category?: string;
  status: ArticleStatus;
  scheduledDate?: Date | string;
  monthlyTraffic?: number;
  searchVolume?: number | null;
  articleUrl?: string;
  publishedUrl?: string;
  content?: string | null;
  lastError?: string | null;
  /** Canonical document as stored by the pipeline (null for legacy rows). */
  canonical?: CanonicalArticle | null;
  qualityReport?: QualityReport | null;
}

/** How a status reads on screen. The stored value is never shown raw. */
export const ARTICLE_STATUS_LABEL: Record<ArticleStatus, string> = {
  queued: "Queued",
  generating: "Generating",
  generated: "Generated",
  needs_review: "Needs review",
  published: "Published",
  failed: "Failed",
};

/** A status from the API, or a readable fallback for one this build does not know. */
export function articleStatusLabel(status: string): string {
  if (status in ARTICLE_STATUS_LABEL) return ARTICLE_STATUS_LABEL[status as ArticleStatus];
  const words = status.replaceAll("_", " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Unknown";
}

interface ArticleCardProps {
  article: Article;
  onRemove?: (articleId: string) => void;
  onView?: (articleId: string) => void;
  onRequeue?: (articleId: string) => void;
  onGenerateNow?: (articleId: string) => void;
  /**
   * "Published Nov 2", "Scheduled for Nov 10". The list view shows it; a
   * grid cell already says which day it is.
   */
  dateLine?: string;
}

/*
 * Sizes: below `md` the cards are full-width list rows on a phone, so every
 * action is a 44px target. From `md` up they sit in a calendar cell, where
 * they shrink back. No content text goes below 12px at either size.
 */
const ACTION =
  "inline-flex min-h-11 items-center gap-1.5 text-xs text-primary hover:underline md:min-h-0";
const ICON_BUTTON =
  "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-destructive md:h-6 md:w-6";
const BADGE = "text-xs px-1.5 py-0 uppercase";

function formatVolume(v: number | null | undefined): string {
  if (v == null) return "volume not estimated";
  return `${formatCount(v)} /mo`;
}

/* ------------------------------------------------------------------------ */
/* Confirm before a costly action                                           */
/* ------------------------------------------------------------------------ */

/**
 * What a rewrite costs. Regenerate rewrites the article from scratch; on a
 * published one the next delivery replaces the live post. Asked inline, by
 * the shared second-tap confirm, never by `window.confirm`.
 */
export function regenerateQuestion(status: ArticleStatus): string {
  return status === "published"
    ? "This rewrites the published article. Continue?"
    : "This rewrites the article from scratch. Continue?";
}

/* ------------------------------------------------------------------------ */
/* Card pieces                                                              */
/* ------------------------------------------------------------------------ */

function CardShell({
  tone = "border-border",
  className,
  children,
}: {
  tone?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "bg-white dark:bg-card rounded-lg border p-3 md:p-2 lg:p-3 space-y-2 relative",
        tone,
        className
      )}
    >
      {children}
    </div>
  );
}

function CardHeader({
  article,
  badge,
  badgeClassName,
  onRemove,
}: {
  article: Article;
  badge: string;
  badgeClassName: string;
  onRemove?: ArticleCardProps["onRemove"];
}) {
  return (
    <div className="flex items-start justify-between gap-2">
      <Badge variant="outline" className={cn(badgeClassName, BADGE)}>
        {badge}
      </Badge>
      {onRemove && (
        <button
          type="button"
          onClick={() => onRemove(article.id)}
          className={cn(ICON_BUTTON, "-mr-2 -mt-2 md:mr-0 md:mt-0")}
          aria-label="Remove"
        >
          <Trash2 className="h-4 w-4 md:h-3 md:w-3" />
        </button>
      )}
    </div>
  );
}

function CardTitle({ article, dateLine }: { article: Article; dateLine?: string }) {
  return (
    <div>
      <h3 className="text-sm md:text-xs font-semibold text-foreground line-clamp-2 leading-tight">
        {article.keyword || article.title}
      </h3>
      {dateLine && <p className="mt-1 text-xs text-muted-foreground">{dateLine}</p>}
    </div>
  );
}

function Volume({ article }: { article: Article }) {
  return (
    <div className="flex items-center gap-1 text-xs text-muted-foreground">
      <BarChart3 className="h-3 w-3 flex-shrink-0" />
      <span>{formatVolume(article.searchVolume ?? article.monthlyTraffic)}</span>
    </div>
  );
}

function CardActions({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 md:flex-col md:items-start md:gap-1">
      {children}
    </div>
  );
}

function ViewLink({
  article,
  onView,
}: Pick<ArticleCardProps, "article" | "onView">) {
  if (!onView) return null;
  return (
    <button type="button" onClick={() => onView(article.id)} className={ACTION}>
      <Eye className="h-3 w-3" />
      <span>View article</span>
    </button>
  );
}

function RegenerateLink({
  article,
  onGenerateNow,
}: Pick<ArticleCardProps, "article" | "onGenerateNow">) {
  if (!onGenerateNow) return null;
  return (
    <InlineConfirm
      key={article.id}
      question={regenerateQuestion(article.status)}
      confirmLabel="Rewrite it"
      onConfirm={() => onGenerateNow(article.id)}
      buttonClassName={ACTION}
      trigger={(ask) => (
        <button type="button" onClick={ask} className={ACTION}>
          <RotateCcw className="h-3 w-3" />
          <span>Regenerate</span>
        </button>
      )}
    />
  );
}

/* ------------------------------------------------------------------------ */
/* Cards                                                                    */
/* ------------------------------------------------------------------------ */

export function PublishedArticleCard({
  article,
  onRemove,
  onView,
  onGenerateNow,
  dateLine,
}: ArticleCardProps) {
  return (
    <CardShell>
      <CardHeader
        article={article}
        badge={ARTICLE_STATUS_LABEL.published}
        badgeClassName="bg-green-50 dark:bg-green-950/40 text-green-700 dark:text-green-300 border-green-200 dark:border-green-800"
        onRemove={onRemove}
      />
      <CardTitle article={article} dateLine={dateLine} />
      <Volume article={article} />
      <CardActions>
        <ViewLink article={article} onView={onView} />
        <RegenerateLink article={article} onGenerateNow={onGenerateNow} />
      </CardActions>
    </CardShell>
  );
}

export function GeneratedArticleCard({
  article,
  onRemove,
  onView,
  onGenerateNow,
  dateLine,
}: ArticleCardProps) {
  return (
    <CardShell>
      <CardHeader
        article={article}
        badge={ARTICLE_STATUS_LABEL.generated}
        badgeClassName="bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800"
        onRemove={onRemove}
      />
      <CardTitle article={article} dateLine={dateLine} />
      <Volume article={article} />
      <CardActions>
        <ViewLink article={article} onView={onView} />
        <RegenerateLink article={article} onGenerateNow={onGenerateNow} />
      </CardActions>
    </CardShell>
  );
}

export function NeedsReviewArticleCard({
  article,
  onRemove,
  onView,
  onGenerateNow,
  dateLine,
}: ArticleCardProps) {
  const blocking = holdReasons(article);
  return (
    <CardShell tone="border-amber-300 dark:border-amber-800">
      <CardHeader
        article={article}
        badge={ARTICLE_STATUS_LABEL.needs_review}
        badgeClassName="bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-200 border-amber-200 dark:border-amber-800"
        onRemove={onRemove}
      />
      <CardTitle article={article} dateLine={dateLine} />
      <div className="flex items-center gap-1 text-xs text-amber-700 dark:text-amber-300">
        <ShieldAlert className="h-3 w-3 flex-shrink-0" />
        <span>
          {blocking.length > 0
            ? `${blocking.length} quality check${blocking.length > 1 ? "s" : ""} failed`
            : "Held before publishing"}
        </span>
      </div>
      <CardActions>
        <ViewLink article={article} onView={onView} />
        <RegenerateLink article={article} onGenerateNow={onGenerateNow} />
      </CardActions>
    </CardShell>
  );
}

export function FailedArticleCard({
  article,
  onRemove,
  onView,
  onRequeue,
  dateLine,
}: ArticleCardProps) {
  return (
    <CardShell tone="border-destructive/40">
      <CardHeader
        article={article}
        badge={ARTICLE_STATUS_LABEL.failed}
        badgeClassName="bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 border-red-200 dark:border-red-800"
        onRemove={onRemove}
      />
      <CardTitle article={article} dateLine={dateLine} />
      {article.lastError && (
        <p className="text-xs text-destructive line-clamp-2">{article.lastError}</p>
      )}
      <CardActions>
        {onRequeue && (
          <button type="button" onClick={() => onRequeue(article.id)} className={ACTION}>
            <RotateCcw className="h-3 w-3" />
            <span>Re-queue</span>
          </button>
        )}
        <ViewLink article={article} onView={onView} />
      </CardActions>
    </CardShell>
  );
}

export function QueuedArticleCard({
  article,
  onRemove,
  onGenerateNow,
  dateLine,
}: ArticleCardProps) {
  const isGenerating = article.status === "generating";

  return (
    <CardShell className="overflow-hidden">
      <CardHeader
        article={article}
        badge={isGenerating ? ARTICLE_STATUS_LABEL.generating : ARTICLE_STATUS_LABEL.queued}
        badgeClassName={
          isGenerating
            ? "bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800"
            : "bg-muted text-muted-foreground border-border"
        }
        onRemove={onRemove}
      />
      <CardTitle article={article} dateLine={dateLine} />
      <Volume article={article} />
      {!isGenerating && onGenerateNow && (
        <CardActions>
          <button type="button" onClick={() => onGenerateNow(article.id)} className={ACTION}>
            <Zap className="h-3 w-3" />
            <span>Generate now</span>
          </button>
        </CardActions>
      )}
      {isGenerating && (
        <div className="pointer-events-none absolute inset-0 !mt-0 overflow-hidden rounded-lg">
          <div className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-primary/20 to-transparent" />
        </div>
      )}
    </CardShell>
  );
}
