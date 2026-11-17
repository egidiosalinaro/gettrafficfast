"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Calendar } from "@/components/dashboard/calendar";
import { Article, ArticleStatus } from "@/components/dashboard/article-card";
import { ArticleModal, PublishOutcome } from "@/components/dashboard/article-modal";
import {
  generateArticleNow,
  publishArticleNow,
  requeueArticle,
  toArticle,
  useHasDestination,
} from "@/components/dashboard/article-actions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Loader2 } from "lucide-react";
import Link from "next/link";
import { CONTENT_PATHS } from "@/lib/content-paths";

/**
 * The full production board, "All articles" in Content
 * (`/content/articles`): every article by day, with the actions the modal
 * and the cards offer. The Content screen's first view shows today and the
 * week; this is everything else.
 */
export function CalendarView() {
  const [articles, setArticles] = useState<Article[]>([]);
  const [loading, setLoading] = useState(true);
  const hasIntegration = useHasDestination();
  const [viewedArticleId, setViewedArticleId] = useState<string | null>(null);
  const [pendingRemove, setPendingRemove] = useState<Article | null>(null);
  const [removing, setRemoving] = useState(false);

  const loadArticles = useCallback(async (opts?: { silent?: boolean }) => {
    try {
      if (!opts?.silent) setLoading(true);
      const res = await fetch("/api/calendar/get");
      if (!res.ok) throw new Error("Failed to fetch");
      const { articles: data } = await res.json();
      setArticles((data || []).map(toArticle));
    } catch (e) {
      console.error(e);
    } finally {
      if (!opts?.silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- existing load-on-mount effect, flagged by eslint-plugin-react-hooks 7.1; behaviour unchanged
    loadArticles();
  }, [loadArticles]);

  // Keep the board fresh so the daily cron's progress (queued -> generating ->
  // generated/published) and the countdown widget reflect reality. Silent so it
  // never flashes the full-page loader, and paused while the tab is hidden.
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") loadArticles({ silent: true });
    };
    const interval = setInterval(tick, 20000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [loadArticles]);

  // `?article=<id>` opens that article's modal once it is on the board
  // (Today's "Push this article" links here).
  const openedFromLink = useRef(false);
  useEffect(() => {
    if (openedFromLink.current || articles.length === 0) return;
    const wanted = new URLSearchParams(window.location.search).get("article");
    openedFromLink.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time open from the address, after the board loaded
    if (wanted && articles.some((a) => a.id === wanted)) setViewedArticleId(wanted);
  }, [articles]);

  const requestRemove = useCallback(
    (articleId: string) => {
      setPendingRemove(
        (prev) => articles.find((a) => a.id === articleId) ?? prev
      );
    },
    [articles]
  );

  const confirmRemove = useCallback(async () => {
    if (!pendingRemove) return;
    try {
      setRemoving(true);
      const res = await fetch("/api/calendar/remove", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ articleId: pendingRemove.id }),
      });
      if (res.ok) await loadArticles({ silent: true });
    } catch (e) {
      console.error(e);
    } finally {
      setRemoving(false);
      setPendingRemove(null);
    }
  }, [pendingRemove, loadArticles]);

  const handleMove = useCallback(
    async (articleId: string, targetDate: string) => {
      // Optimistic reschedule (swap dates if the target day is taken) for
      // instant feedback; loadArticles() reconciles with server truth after.
      setArticles((prev) => {
        const moving = prev.find((a) => a.id === articleId);
        if (!moving || moving.scheduledDate === targetDate) return prev;
        const fromDate = moving.scheduledDate;
        const occupant = prev.find(
          (a) => a.scheduledDate === targetDate && a.id !== articleId
        );
        return prev.map((a) => {
          if (a.id === articleId) return { ...a, scheduledDate: targetDate };
          if (occupant && a.id === occupant.id)
            return { ...a, scheduledDate: fromDate };
          return a;
        });
      });

      try {
        const res = await fetch("/api/calendar/reschedule", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ articleId, targetDate }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || "Failed to reschedule");
        }
      } catch (e) {
        console.error(e);
        alert(e instanceof Error ? e.message : "Failed to reschedule article");
      } finally {
        loadArticles({ silent: true });
      }
    },
    [loadArticles]
  );

  const handleRequeue = useCallback(
    async (articleId: string) => {
      if (await requeueArticle(articleId)) loadArticles({ silent: true });
    },
    [loadArticles]
  );

  const handlePublishNow = useCallback(
    async (articleId: string): Promise<PublishOutcome> => {
      try {
        return await publishArticleNow(articleId);
      } finally {
        await loadArticles({ silent: true });
      }
    },
    [loadArticles]
  );

  const handleGenerateNow = useCallback(
    async (articleId: string) => {
      // Flip to "generating" right away so the shimmer shows during the request.
      setArticles((prev) =>
        prev.map((a) =>
          a.id === articleId ? { ...a, status: "generating" as ArticleStatus } : a
        )
      );
      try {
        await generateArticleNow(articleId);
      } catch (e) {
        console.error(e);
        alert(e instanceof Error ? e.message : "Failed to generate article");
      } finally {
        loadArticles({ silent: true });
      }
    },
    [loadArticles]
  );

  const viewedArticle =
    articles.find((a) => a.id === viewedArticleId) ?? null;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex-1 w-full flex flex-col gap-8">
      {articles.length === 0 && (
        <div className="rounded-lg border border-foreground/10 bg-muted/20 p-4">
          <p className="text-sm font-medium">Nothing on the board yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            A topic becomes an article on the next free day.
          </p>
          <Link
            href={CONTENT_PATHS.topics}
            className="mt-3 inline-flex min-h-11 md:min-h-0 items-center rounded-md border border-foreground/10 px-3 py-1.5 text-sm font-medium hover:bg-muted/40"
          >
            Open topics
          </Link>
        </div>
      )}
      <Calendar
        articles={articles}
        onRemoveArticle={requestRemove}
        onViewArticle={setViewedArticleId}
        onRequeueArticle={handleRequeue}
        onMoveArticle={handleMove}
        onGenerateNow={handleGenerateNow}
      />
      <ArticleModal
        article={viewedArticle}
        hasIntegration={hasIntegration}
        onClose={() => setViewedArticleId(null)}
        onRequeue={handleRequeue}
        onRegenerate={handleGenerateNow}
        onPublish={handlePublishNow}
      />

      <Dialog
        open={!!pendingRemove}
        onOpenChange={(open) => {
          if (!open && !removing) setPendingRemove(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Remove this article?</DialogTitle>
            <DialogDescription>
              {pendingRemove ? (
                <>
                  “{pendingRemove.keyword}” will be removed from your calendar and
                  the topic goes back to your list. This can&apos;t be undone.
                </>
              ) : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              className="h-11 md:h-9"
              onClick={() => setPendingRemove(null)}
              disabled={removing}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              className="h-11 md:h-9"
              onClick={confirmRemove}
              disabled={removing}
            >
              {removing ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Removing...
                </>
              ) : (
                "Remove"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
