"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import type { ArticlePushView } from "@/lib/lifecycle/push-store";
import { InlineConfirm } from "@/components/ui/inline-confirm";

/**
 * Push page 3 in the article modal (docs/LIFECYCLE.md): the article's
 * newest push, in words. A proposal (the site could not take the update)
 * spells out each link to add (the page, the words to link, or the
 * sentence to add) and the new search title and description, with "I added
 * it" and "Dismiss" (POST /api/article-pushes/:id, `resolve_article_push`).
 * An applied push says what changed and its measurement ("not measured
 * yet" until Search Console covers the window). "Push this article" asks
 * first, inline: it uses AI work (POST /api/article-pushes, `push_article`).
 */

export function PushDetails({ push }: { push: ArticlePushView }) {
  const proposed = push.status === "proposed";
  const links = push.links.filter((l) => l.status === "proposed" || l.status === "applied" || l.status === "not_delivered");
  return (
    <div className="space-y-2 text-sm" data-testid="push-details">
      <p className="text-muted-foreground">
        {proposed ? "Proposed" : push.status === "applied" ? "Pushed" : "Push"} for the search{" "}
        <span className="font-medium text-foreground">&ldquo;{push.mainQuery}&rdquo;</span>
        {push.before.position !== null && <> (position {Math.round(push.before.position)} over 28 days)</>}.
      </p>
      {links.length > 0 && (
        <ul className="space-y-1.5">
          {links.map((link) => (
            <li key={link.fromArticleId} className="rounded-md border border-foreground/10 p-2">
              <a href={link.fromUrl} target="_blank" rel="noopener noreferrer" className="font-medium hover:underline">
                {link.fromTitle}
              </a>
              <span className="block text-muted-foreground">
                {link.mode === "sentence" ? (
                  <>Add at the end of a paragraph: &ldquo;{link.sentence}&rdquo;, linking &ldquo;{link.anchor}&rdquo;.</>
                ) : (
                  <>Link the words &ldquo;{link.anchor}&rdquo;.</>
                )}
                {link.status === "applied" && " Done on your site."}
                {link.status === "not_delivered" && " Saved; your site did not take the update yet."}
              </span>
            </li>
          ))}
        </ul>
      )}
      {push.title.new && (
        <p>
          <span className="text-muted-foreground">Search title: </span>
          {push.title.new}
          {push.title.old && <span className="block text-xs text-muted-foreground">Was: {push.title.old}</span>}
        </p>
      )}
      {push.metaDescription.new && (
        <p>
          <span className="text-muted-foreground">Description: </span>
          {push.metaDescription.new}
        </p>
      )}
      {push.line && <p className="text-xs text-muted-foreground">{push.line}</p>}
    </div>
  );
}

export function ArticlePushPanel({ articleId }: { articleId: string }) {
  const [push, setPush] = useState<ArticlePushView | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch(`/api/article-pushes?articleId=${encodeURIComponent(articleId)}`).catch(() => null);
    if (!response?.ok) return setPush(null);
    const payload = (await response.json()) as { pushes: ArticlePushView[] };
    setPush(payload.pushes.find((p) => p.status !== "skipped" && p.status !== "failed") ?? payload.pushes[0] ?? null);
  }, [articleId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load-on-open, like the index status line
    void load();
  }, [load]);

  const act = async (url: string, body: unknown) => {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const payload = (await response.json().catch(() => ({}))) as { push?: ArticlePushView; error?: string };
      if (!response.ok || !payload.push) setMessage(payload.error ?? "That did not work; try again.");
      else setPush(payload.push);
    } finally {
      setBusy(false);
    }
  };

  if (push === undefined) return null;
  const showPush = push && push.status !== "skipped" && push.status !== "failed" && push.status !== "dismissed";

  return (
    <section className="space-y-2 rounded-lg border border-foreground/10 p-3" aria-label="Push page 3">
      <h3 className="text-sm font-semibold">Push up Google&apos;s pages</h3>
      {showPush && push && <PushDetails push={push} />}
      {push?.status === "selected" && (
        <p className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> Working on it.
        </p>
      )}
      {push && (push.status === "skipped" || push.status === "failed") && push.skipReason && (
        <p className="text-xs text-muted-foreground">Last try: {push.skipReason}</p>
      )}
      {push?.status === "proposed" && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void act(`/api/article-pushes/${push.id}`, { action: "applied" })}
            className="inline-flex min-h-11 items-center rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-50 md:min-h-9"
          >
            I added it
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void act(`/api/article-pushes/${push.id}`, { action: "dismissed" })}
            className="inline-flex min-h-11 items-center rounded-lg border border-border px-4 text-sm font-medium md:min-h-9"
          >
            Dismiss
          </button>
        </div>
      )}
      {(!push || push.status === "skipped" || push.status === "failed" || push.status === "dismissed") && (
        <InlineConfirm
          question="This uses AI work to add links and a new search title. Continue?"
          confirmLabel="Push it"
          onConfirm={() => void act("/api/article-pushes", { articleId })}
          trigger={(ask) => (
            <button
              type="button"
              disabled={busy}
              onClick={ask}
              className="inline-flex min-h-11 items-center rounded-lg border border-border px-4 text-sm font-medium disabled:opacity-50 md:min-h-9"
            >
              Push this article
            </button>
          )}
        />
      )}
      {message && <p className="text-xs text-destructive">{message}</p>}
    </section>
  );
}
