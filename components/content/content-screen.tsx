"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CalendarView } from "@/components/dashboard/calendar-view";
import type { ContentView } from "@/lib/calendar/content";
import { refreshOnboarding } from "@/lib/onboarding";
import { cn } from "@/lib/utils";
import { ContentTop, NextTopicsList, SECTION_HEADING } from "./content-parts";

/**
 * The Content screen (`/content`): the calendar, every article by day with
 * every action (components/dashboard/calendar-view.tsx, which also opens
 * `?article=<id>`'s modal). Above it, the Autopilot state and the links to
 * the topics; under it, the topics Autopilot picks next. Those read GET
 * /api/content (lib/calendar/content.ts, which `get_content` reads too).
 * Adding a topic is POST /api/keywords/save (add_keywords), removing one is
 * DELETE /api/keywords/delete (delete_keywords).
 */

type Notice = { type: "success" | "error"; text: string };

export function ContentScreen() {
  const [view, setView] = useState<ContentView | null>(null);
  const [failed, setFailed] = useState(false);
  const [adding, setAdding] = useState(false);
  const [topic, setTopic] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/content");
      if (!res.ok) throw new Error("Could not read Content");
      setView((await res.json()) as ContentView);
      setFailed(false);
    } catch (e) {
      console.error(e);
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load on mount; the state is set after the fetch resolves
    load();
    // The day moves on its own (writing, publishing): read again while visible.
    const tick = () => {
      if (document.visibilityState === "visible") load();
    };
    const interval = setInterval(tick, 30000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [load]);

  const removeTopic = useCallback(
    async (topicId: string) => {
      setNotice(null);
      try {
        const res = await fetch(`/api/keywords/delete?ids=${encodeURIComponent(topicId)}`, { method: "DELETE" });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || "Could not remove the topic");
        }
      } catch (e) {
        setNotice({ type: "error", text: e instanceof Error ? e.message : "Could not remove the topic" });
      } finally {
        await load();
      }
    },
    [load]
  );

  const addTopic = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      const keyword = topic.trim();
      if (!keyword) return;
      setSaving(true);
      setNotice(null);
      try {
        const res = await fetch("/api/keywords/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ keywords: [{ keyword }] }),
        });
        const result = await res.json().catch(() => ({}));
        if (res.status === 409) {
          setNotice({ type: "error", text: "That topic is already in your list." });
          return;
        }
        if (!res.ok) throw new Error(result.error || "Could not add the topic");
        const added = Array.isArray(result.keywords) && result.keywords.length > 0;
        // Not added because it overlaps a topic the site has: the API says which.
        setNotice(
          added
            ? { type: "success", text: `Added "${keyword}".` }
            : { type: "error", text: result.message || "That topic was not added." }
        );
        if (added) {
          setTopic("");
          setAdding(false);
          refreshOnboarding();
        }
      } catch (e) {
        setNotice({ type: "error", text: e instanceof Error ? e.message : "Could not add the topic" });
      } finally {
        setSaving(false);
        await load();
      }
    },
    [topic, load]
  );

  return (
    <div className="flex w-full min-w-0 flex-1 flex-col gap-6">
      <ContentTop view={view} failed={failed} onRetry={() => load()} />

      <CalendarView />

      {view && (
        <section aria-labelledby="content-topics" className="flex max-w-2xl flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <h2 id="content-topics" className={SECTION_HEADING}>
              Picked next
            </h2>
            {!adding && (
              <button
                type="button"
                onClick={() => setAdding(true)}
                className="inline-flex min-h-11 items-center text-sm font-semibold hover:underline md:min-h-8"
              >
                Add a topic
              </button>
            )}
          </div>
          {adding && (
            <form onSubmit={addTopic} className="flex flex-wrap items-center gap-2">
              <label htmlFor="new-topic" className="sr-only">
                A topic to write about
              </label>
              <Input
                id="new-topic"
                autoFocus
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="A topic to write about"
                maxLength={200}
                className="h-11 min-w-0 flex-1 basis-48 md:h-9"
              />
              <Button type="submit" className="h-11 md:h-9" disabled={saving || !topic.trim()}>
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Add
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="h-11 md:h-9"
                onClick={() => {
                  setAdding(false);
                  setTopic("");
                }}
              >
                Cancel
              </Button>
            </form>
          )}
          {notice && (
            <div
              role={notice.type === "error" ? "alert" : "status"}
              className={cn(
                "flex items-start gap-2 rounded-lg border p-3 text-sm",
                notice.type === "success"
                  ? "border-green-200 bg-green-50 text-green-900 dark:border-green-800 dark:bg-green-950/40 dark:text-green-100"
                  : "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100"
              )}
            >
              {notice.type === "success" ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              ) : (
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              )}
              <p className="flex-1 break-words">{notice.text}</p>
              <button
                type="button"
                onClick={() => setNotice(null)}
                aria-label="Dismiss"
                className="-m-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-md opacity-70 hover:opacity-100 md:h-8 md:w-8"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}
          <NextTopicsList topics={view.nextTopics} total={view.topicsTotal} onRemove={removeTopic} />
        </section>
      )}
    </div>
  );
}
