"use client";

import { useEffect, useState } from "react";
import type { Article, ArticleStatus } from "./article-card";
import type { PublishOutcome } from "./article-modal";

/**
 * What the article modal's buttons call, shared by the Articles board
 * (calendar-view.tsx) and the Content screen (components/content/), so the
 * two cannot drift: each is the route the matching tool calls the same
 * function as (Re-queue: retry_article, Publish: publish_article,
 * Generate now / Regenerate: generate_article).
 */

const KNOWN_STATUSES: ArticleStatus[] = ["queued", "generating", "generated", "needs_review", "published", "failed"];

/** A calendar row from GET /api/calendar/get as the board and the modal read it. */
export interface RawCalendarArticle {
  id: string;
  keywordId: string;
  keyword: string;
  searchVolume: number | null;
  scheduledDate: string;
  status: string;
  content?: string | null;
  publishedUrl?: string | null;
  lastError?: string | null;
  canonical?: Article["canonical"];
  qualityReport?: Article["qualityReport"];
}

export function toArticle(raw: RawCalendarArticle): Article {
  return {
    id: raw.id,
    keywordId: raw.keywordId,
    keyword: raw.keyword,
    title: raw.keyword,
    searchVolume: raw.searchVolume,
    monthlyTraffic: raw.searchVolume ?? undefined,
    scheduledDate: raw.scheduledDate,
    status: KNOWN_STATUSES.includes(raw.status as ArticleStatus) ? (raw.status as ArticleStatus) : "queued",
    content: raw.content ?? null,
    canonical: raw.canonical ?? null,
    qualityReport: raw.qualityReport ?? null,
    publishedUrl: raw.publishedUrl ?? undefined,
    lastError: raw.lastError ?? null,
  };
}

/** Puts a failed article back in the queue. */
export async function requeueArticle(articleId: string): Promise<boolean> {
  const res = await fetch("/api/calendar/requeue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ articleId }),
  });
  return res.ok;
}

/** Publishes (or republishes) now, with the API's own words when it refuses. */
export async function publishArticleNow(articleId: string): Promise<PublishOutcome> {
  try {
    const res = await fetch("/api/publish-now", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ articleId }),
    });
    if (res.ok) return { ok: true };
    // The API knows why it refused (still producing, failed gates, the site
    // rejected the post): carry its words to the modal.
    const err = await res.json().catch(() => ({}));
    return {
      ok: false,
      message: typeof err.error === "string" ? err.error : "Failed to publish article.",
      hint: err.hint === "integrations" ? "integrations" : undefined,
    };
  } catch (e) {
    console.error(e);
    return { ok: false, message: "Could not reach the server. Check your connection." };
  }
}

/** Starts writing it now (Generate now, Regenerate). Throws the API's refusal. */
export async function generateArticleNow(articleId: string): Promise<void> {
  const res = await fetch("/api/generate-now", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ articleId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || "Failed to generate article");
  }
}

/** Whether the site has a destination to publish to (connected, or failing and retried). */
export function useHasDestination(): boolean {
  const [has, setHas] = useState(false);
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetch("/api/integrations/list");
        if (!res.ok) return;
        const { integrations } = await res.json();
        if (!live) return;
        setHas(
          (integrations || []).some((i: { status: string }) => i.status === "connected" || i.status === "error")
        );
      } catch (e) {
        console.error(e);
      }
    })();
    return () => {
      live = false;
    };
  }, []);
  return has;
}
