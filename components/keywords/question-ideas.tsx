"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ExternalLink, Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ASKED_IN_PUBLIC, QUESTION_SOURCE, threadHost, type QuestionIdea } from "@/lib/keywords/questions";
import { pluralize } from "@/lib/utils";
import { useHashScroll } from "./use-hash-scroll";

/**
 * "Questions people ask" on the Keywords screen: questions asked in the
 * public threads discovery found (Replies), offered as keywords.
 *
 * A question has no volume, difficulty or CPC, measured or estimated, so
 * none is shown: each row says where it was asked and links to the thread.
 * A list, not a table: on a phone a row stacks and nothing scrolls sideways.
 */

/** Phones get 44px targets; from md up the controls are compact. */
const TOUCH = "min-h-[44px] md:min-h-0";

/**
 * What a keyword taken from a question shows where the estimates would be:
 * "Asked in a public thread", linked to the thread when its link is a web
 * address. Never a number.
 */
export function AskedInPublicThread({ sourceUrl }: { sourceUrl: string | null }) {
  const host = sourceUrl ? threadHost(sourceUrl) : null;
  if (!sourceUrl || !host) return <span className="text-sm text-muted-foreground">{ASKED_IN_PUBLIC}</span>;
  return (
    <a
      href={sourceUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex min-h-[44px] items-center gap-1 text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline md:min-h-0"
    >
      {ASKED_IN_PUBLIC}
      <span className="whitespace-nowrap">· {host}</span>
      <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
    </a>
  );
}

export function QuestionIdeasList({
  ideas,
  selected,
  adding,
  onToggle,
  onAdd,
}: {
  ideas: QuestionIdea[];
  selected: ReadonlySet<string>;
  /** Source URLs being added right now; "all" while "Add selected" runs. */
  adding: ReadonlySet<string> | "all";
  onToggle: (sourceUrl: string) => void;
  onAdd: (ideas: QuestionIdea[]) => void;
}) {
  if (ideas.length === 0) {
    return (
      <p className="rounded-lg border p-4 text-sm text-muted-foreground">
        No questions found yet. Run discovery in{" "}
        <Link href="/today" className="underline underline-offset-2 hover:text-foreground">
          Today
        </Link>{" "}
        to find conversations.
      </p>
    );
  }
  const busy = (idea: QuestionIdea) => adding === "all" || adding.has(idea.sourceUrl);
  const chosen = ideas.filter((idea) => selected.has(idea.sourceUrl));
  return (
    <div>
      <ul className="divide-y rounded-lg border">
        {ideas.map((idea) => (
          <li key={idea.sourceUrl} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:gap-3">
            <div className="flex min-w-0 flex-1 items-start gap-1">
              <label className="-ml-2 -mt-2 flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center sm:mt-0">
                <Checkbox
                  checked={selected.has(idea.sourceUrl)}
                  onCheckedChange={() => onToggle(idea.sourceUrl)}
                  aria-label={`Select ${idea.question}`}
                />
              </label>
              <div className="min-w-0 flex-1">
                <p className="break-words font-medium">{idea.question}</p>
                <p className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
                  <AskedInPublicThread sourceUrl={idea.sourceUrl} />
                  {idea.threadCount > 1 && <span>· asked in {idea.threadCount} threads we found</span>}
                </p>
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onAdd([idea])}
              disabled={busy(idea)}
              className={`${TOUCH} shrink-0 self-start sm:self-center`}
              aria-label={`Add ${idea.question}`}
            >
              {busy(idea) ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Plus className="mr-1 h-3 w-3" />}
              Add
            </Button>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button size="sm" onClick={() => onAdd(chosen)} disabled={chosen.length === 0 || adding === "all"} className={TOUCH}>
          {adding === "all" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
          Add selected{chosen.length > 0 ? ` (${chosen.length})` : ""}
        </Button>
        <span className="text-xs text-muted-foreground">
          Added as keywords with no volume, difficulty or CPC: nobody measured them.
        </span>
      </div>
    </div>
  );
}

export function QuestionIdeas({
  refreshKey,
  onAdded,
  onNotice,
}: {
  /** Changes when the pool changed elsewhere on the page, to read the ideas again. */
  refreshKey?: unknown;
  /** The pool gained keywords. */
  onAdded: () => void;
  onNotice: (notice: { type: "success" | "error"; text: string }) => void;
}) {
  const [ideas, setIdeas] = useState<QuestionIdea[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState<Set<string> | "all">(new Set());

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/keywords/questions");
      if (!response.ok) throw new Error("Failed to load questions");
      const { questions } = await response.json();
      setIdeas(Array.isArray(questions) ? questions : []);
      setFailed(false);
    } catch (error) {
      console.error("Error loading question ideas:", error);
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load on mount and when the pool changes; the state is set after the fetch resolves
    load();
  }, [load, refreshKey]);

  // The Content screen's "Questions people ask" row links here.
  useHashScroll("questions-people-ask", ideas !== null || failed);

  const toggle = (sourceUrl: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(sourceUrl)) next.delete(sourceUrl);
      else next.add(sourceUrl);
      return next;
    });

  const add = async (chosen: QuestionIdea[]) => {
    if (chosen.length === 0) return;
    setAdding(chosen.length === 1 ? new Set([chosen[0].sourceUrl]) : "all");
    try {
      const response = await fetch("/api/keywords/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // No figures are sent, and none would be stored: a question has none.
          keywords: chosen.map((idea) => ({ keyword: idea.question, source: QUESTION_SOURCE, sourceUrl: idea.sourceUrl })),
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Could not add the questions");
      onNotice({
        type: "success",
        text: result.message || `${pluralize(chosen.length, "question")} added to your topics.`,
      });
      setSelected((prev) => {
        const next = new Set(prev);
        for (const idea of chosen) next.delete(idea.sourceUrl);
        return next;
      });
      onAdded();
      await load();
    } catch (error) {
      console.error("Error adding questions:", error);
      onNotice({ type: "error", text: error instanceof Error ? error.message : "Could not add the questions" });
    } finally {
      setAdding(new Set());
    }
  };

  return (
    <section aria-labelledby="questions-people-ask">
      <h2 id="questions-people-ask" className="mb-2 text-xl font-semibold">
        Questions people ask
      </h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Questions asked in the public conversations found for your site in Replies, not yet covered by a topic or an
        article. They come from real threads, so there is no volume, difficulty or CPC for them: each links to where it
        was asked. With Autopilot on, up to 3 a day become topics on their own.
      </p>
      {failed ? (
        <p role="alert" className="rounded-lg border p-4 text-sm text-muted-foreground">
          The questions could not be loaded. Reload the page to try again.
        </p>
      ) : ideas === null ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <QuestionIdeasList ideas={ideas} selected={selected} adding={adding} onToggle={toggle} onAdd={add} />
      )}
    </section>
  );
}
