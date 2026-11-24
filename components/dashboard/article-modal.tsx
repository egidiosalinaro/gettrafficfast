"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Check,
  Copy,
  ExternalLink,
  ImageOff,
  Plug,
  RotateCcw,
  Send,
  Loader2,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { articleDocuments, exportArticle } from "@/lib/content/export";
import { holdReasons, REASON_NOT_RECORDED } from "@/lib/content/hold-reasons";
import { InlineConfirm } from "@/components/ui/inline-confirm";
import { IMAGE_STYLE_PATH } from "@/lib/media/settings";
import { readSkipNotes } from "@/lib/media/skips";
import { ARTICLE_STATUS_LABEL, Article, regenerateQuestion } from "./article-card";
import { articleDateLine } from "./calendar-model";
import { IndexStatusLine } from "./index-status-line";
import { ArticlePushPanel } from "./article-push-panel";

/**
 * Why a publish did not happen. Publishing can refuse for reasons that have
 * nothing to do with the destination (the article is still being produced, it
 * failed the quality gates), so the reason travels with the outcome and only
 * a genuine delivery failure carries the Integrations pointer.
 */
export type PublishOutcome =
  | { ok: true }
  | { ok: false; message: string; hint?: "integrations" };

interface ArticleModalProps {
  article: Article | null;
  hasIntegration: boolean;
  onClose: () => void;
  onRequeue?: (articleId: string) => void;
  /** Rewrites the article from scratch (same path as Generate now). */
  onRegenerate?: (articleId: string) => void;
  /** Publishes/republishes the article, resolving with what happened. */
  onPublish?: (articleId: string) => Promise<PublishOutcome>;
}

/** 44px on a phone, the compact size from `md` up. */
const TOUCH = "h-11 md:h-8";

/** The answer buttons of an inline confirm, sized like the modal's buttons. */
const CONFIRM_BUTTON =
  "inline-flex h-11 md:h-8 items-center rounded-md border border-input bg-background px-3 text-xs font-medium hover:bg-accent";

const STATUS_BADGE: Record<Article["status"], { className: string }> = {
  queued: { className: "bg-muted text-muted-foreground border-border" },
  generating: {
    className:
      "bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800",
  },
  needs_review: {
    className:
      "bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-200 border-amber-200 dark:border-amber-800",
  },
  generated: {
    className:
      "bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800",
  },
  published: {
    className:
      "bg-green-50 dark:bg-green-950/40 text-green-700 dark:text-green-300 border-green-200 dark:border-green-800",
  },
  failed: {
    className:
      "bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 border-red-200 dark:border-red-800",
  },
};

export function ArticleModal({
  article,
  hasIntegration,
  onClose,
  onRequeue,
  onRegenerate,
  onPublish,
}: ArticleModalProps) {
  const [copied, setCopied] = useState<"html" | "markdown" | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishResult, setPublishResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);

  // Azzerare lo stato quando cambia l'articolo selezionato va fatto durante il
  // render, non in un effect: l'effect produrrebbe un primo render con i dati
  // del vecchio articolo, e solo dopo il reset.
  const articleId = article?.id ?? null;
  const [shownArticleId, setShownArticleId] = useState(articleId);
  if (articleId !== shownArticleId) {
    setShownArticleId(articleId);
    setPublishing(false);
    setPublishResult(null);
  }

  if (!article) return null;

  async function runPublish() {
    if (!article || !onPublish) return;
    const republish = article.status === "published";
    setPublishing(true);
    setPublishResult(null);
    const outcome = await onPublish(article.id);
    setPublishing(false);
    setPublishResult(
      outcome.ok
        ? {
            ok: true,
            message: republish
              ? "Post updated on your site."
              : "Published to your site.",
          }
        : {
            ok: false,
            message:
              outcome.hint === "integrations"
                ? `${outcome.message} See Recent deliveries in Settings → Connections.`
                : outcome.message,
          }
    );
  }

  function runRegenerate() {
    if (!article || !onRegenerate) return;
    onRegenerate(article.id);
    onClose();
  }

  // A rewrite replaces what was written, and on a live article the post on
  // the site: a second tap, never one.
  const regenerate = onRegenerate ? (
    <InlineConfirm
      key={`regenerate-${article.id}`}
      question={regenerateQuestion(article.status)}
      confirmLabel="Rewrite it"
      onConfirm={runRegenerate}
      buttonClassName={CONFIRM_BUTTON}
      trigger={(ask) => (
        <Button variant="outline" size="sm" className={TOUCH} onClick={ask}>
          <RotateCcw className="h-4 w-4 mr-1.5" />
          Regenerate
        </Button>
      )}
    />
  ) : null;

  const badge = STATUS_BADGE[article.status];
  const dateLine = article.scheduledDate ? articleDateLine(article, new Date()) : null;
  // The very document the publisher adapters receive, hero on top, built by
  // the same function `get_article` exports with (lib/content/export.ts), so
  // what a person copies here is what an agent reads.
  const view = article.canonical ?? null;
  const source = { canonical: view, content: article.content ?? null };
  const { previewHtml } = articleDocuments(source);
  const hasContent = previewHtml.length > 0;
  // Why it was held: the same sentences publish_article answers with
  // (lib/content/hold-reasons.ts), never an empty list.
  const reasons = article.status === "needs_review" ? holdReasons(article) : [];
  // Written without images because no image style was chosen yet: said here,
  // in the platform's sentence, with the way to choose one.
  const noStyle = readSkipNotes(view).find((note) => note.media === "images" && note.reason === "no_style") ?? null;

  async function copy(kind: "html" | "markdown") {
    const text = exportArticle(source, kind);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      // Clipboard unavailable (e.g. insecure context); nothing to do.
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <div className="flex items-center gap-2 pr-8">
            <DialogTitle className="line-clamp-2">
              {view?.title ?? (article.keyword || article.title)}
            </DialogTitle>
            <Badge
              variant="outline"
              className={`${badge.className} text-xs px-1.5 py-0 uppercase shrink-0`}
            >
              {ARTICLE_STATUS_LABEL[article.status]}
            </Badge>
          </div>
          {dateLine && <DialogDescription>{dateLine}</DialogDescription>}
        </DialogHeader>

        {article.status === "published" && (
          <div className="flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center gap-1.5 text-sm font-medium text-green-700 dark:text-green-300">
              <Check className="h-4 w-4" />
              Already on your site
            </span>
            {article.publishedUrl && (
              <a
                href={article.publishedUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline w-fit"
              >
                <ExternalLink className="h-4 w-4" />
                View live post
              </a>
            )}
            {hasIntegration && onPublish && (
              <InlineConfirm
                key={`republish-${article.id}`}
                question="This replaces the post on your site with this version, including any edits made there. Continue?"
                confirmLabel="Republish"
                onConfirm={runPublish}
                buttonClassName={CONFIRM_BUTTON}
                trigger={(ask) => (
                  <Button
                    variant="outline"
                    size="sm"
                    className={TOUCH}
                    onClick={ask}
                    disabled={publishing}
                    title="Send this article to your site again (updates the existing post)"
                  >
                    {publishing ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                        Republishing...
                      </>
                    ) : (
                      <>
                        <RefreshCw className="h-4 w-4 mr-1.5" />
                        Republish
                      </>
                    )}
                  </Button>
                )}
              />
            )}
            {regenerate}
          </div>
        )}

        {article.status === "published" && article.publishedUrl && (
          <IndexStatusLine key={`index-${article.id}`} articleId={article.id} />
        )}
        {article.status === "published" && article.publishedUrl && (
          <ArticlePushPanel key={`push-${article.id}`} articleId={article.id} />
        )}

        {noStyle && (
          <div
            role="status"
            data-testid="article-no-image-style"
            className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100"
          >
            <ImageOff className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              Written without images: no image style chosen yet.{" "}
              <Link href={IMAGE_STYLE_PATH} className="font-medium underline underline-offset-2 hover:no-underline">
                Choose a style
              </Link>{" "}
              and the articles written after that get a featured image.
            </p>
          </div>
        )}

        {publishResult && (
          <p
            className={
              publishResult.ok
                ? "text-sm font-medium text-green-700 dark:text-green-300"
                : "text-sm font-medium text-destructive"
            }
          >
            {publishResult.message}
          </p>
        )}

        {article.status === "generated" && hasIntegration && (
          <div className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/40 p-4 flex items-start gap-3">
            <Send className="h-5 w-5 text-blue-700 dark:text-blue-300 shrink-0 mt-0.5" />
            <div className="text-sm flex-1">
              <p className="font-medium text-blue-900 dark:text-blue-100">
                This article is ready but not on your site yet.
              </p>
              <p className="text-blue-800 dark:text-blue-200 mt-0.5">
                It will publish automatically on the next scheduled run, or you
                can push it live right now.
              </p>
              <div className="flex flex-wrap gap-2 mt-2">
                <Button
                  size="sm"
                  className={TOUCH}
                  onClick={runPublish}
                  disabled={publishing}
                >
                  {publishing ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                      Publishing...
                    </>
                  ) : (
                    <>
                      <Send className="h-4 w-4 mr-1.5" />
                      Publish now
                    </>
                  )}
                </Button>
                {regenerate}
              </div>
            </div>
          </div>
        )}

        {article.status === "generated" && !hasIntegration && (
          <div className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/40 p-4 flex items-start gap-3">
            <Plug className="h-5 w-5 text-blue-700 dark:text-blue-300 shrink-0 mt-0.5" />
            <div className="text-sm">
              <p className="font-medium text-blue-900 dark:text-blue-100">
                This article is ready but not on your site yet.
              </p>
              <p className="text-blue-800 dark:text-blue-200 mt-0.5">
                Connect an integration and it will be published automatically on
                the next run. Or copy the content below and publish it manually.
              </p>
              <Link
                href="/settings/integrations"
                className="inline-flex min-h-11 md:min-h-0 items-center gap-1 mt-2 font-medium text-blue-700 dark:text-blue-300 hover:underline"
              >
                Connect an integration
              </Link>
              {regenerate && <div className="mt-2">{regenerate}</div>}
            </div>
          </div>
        )}

        {article.status === "needs_review" && (
          <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 p-4 space-y-3">
            <div className="flex items-start gap-3">
              <ShieldAlert className="h-5 w-5 text-amber-700 dark:text-amber-300 shrink-0 mt-0.5" />
              <div className="text-sm">
                <p className="font-medium text-amber-900 dark:text-amber-100">
                  Held before publishing
                </p>
                <p className="text-amber-800 dark:text-amber-200 mt-0.5">
                  {reasons.length > 0
                    ? "The article was written and nothing was lost, but these quality checks failed, so it was not sent to your site:"
                    : `The article was written and nothing was lost, but it was not sent to your site. ${REASON_NOT_RECORDED}`}
                </p>
              </div>
            </div>
            {reasons.length > 0 && (
              <ul className="text-sm text-amber-900 dark:text-amber-100 list-disc pl-9 space-y-1">
                {reasons.map((reason, index) => (
                  <li key={index}>{reason}</li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap gap-2 md:pl-9">
              {regenerate}
              {hasIntegration && onPublish && (
                <InlineConfirm
                  key={`publish-anyway-${article.id}`}
                  question="This puts an article that failed its quality checks on your site. Continue?"
                  confirmLabel="Publish anyway"
                  onConfirm={runPublish}
                  buttonClassName={CONFIRM_BUTTON}
                  trigger={(ask) => (
                    <Button
                      variant="outline"
                      size="sm"
                      className={TOUCH}
                      onClick={ask}
                      disabled={publishing}
                      title="Publish it anyway: you have reviewed the issues above"
                    >
                      {publishing ? (
                        <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                      ) : (
                        <Send className="h-4 w-4 mr-1.5" />
                      )}
                      Publish anyway
                    </Button>
                  )}
                />
              )}
            </div>
          </div>
        )}

        {article.status === "failed" && (
          <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/40 p-4 space-y-2 text-sm">
            <p className="font-medium text-red-900 dark:text-red-100">
              Generation failed after multiple attempts.
            </p>
            {article.lastError && (
              <p className="text-red-800 dark:text-red-200 break-words">
                {article.lastError}
              </p>
            )}
            {onRequeue && (
              <Button
                variant="outline"
                size="sm"
                className={TOUCH}
                onClick={() => {
                  onRequeue(article.id);
                  onClose();
                }}
              >
                <RotateCcw className="h-4 w-4 mr-1.5" />
                Re-queue article
              </Button>
            )}
          </div>
        )}

        {hasContent ? (
          <>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" className={TOUCH} onClick={() => copy("html")}>
                {copied === "html" ? (
                  <Check className="h-4 w-4 mr-1.5" />
                ) : (
                  <Copy className="h-4 w-4 mr-1.5" />
                )}
                {copied === "html" ? "Copied!" : "Copy HTML"}
              </Button>
              <Button variant="outline" size="sm" className={TOUCH} onClick={() => copy("markdown")}>
                {copied === "markdown" ? (
                  <Check className="h-4 w-4 mr-1.5" />
                ) : (
                  <Copy className="h-4 w-4 mr-1.5" />
                )}
                {copied === "markdown" ? "Copied!" : "Copy Markdown"}
              </Button>
            </div>
            <div className="flex-1 overflow-y-auto rounded-lg border border-border p-4 md:p-6 min-h-0">
              <div
                className="blog-content"
                dangerouslySetInnerHTML={{ __html: previewHtml }}
              />
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            {article.status === "queued" || article.status === "generating"
              ? "The content has not been generated yet. Check back after the next scheduled run."
              : "No content available for this article."}
          </p>
        )}

        {/* The corner X is a 16px target; on a phone, a real one. */}
        <Button variant="outline" className="h-11 w-full md:hidden" onClick={onClose}>
          Close
        </Button>
      </DialogContent>
    </Dialog>
  );
}
