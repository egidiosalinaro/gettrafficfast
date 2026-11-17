"use client";

import { useCallback, useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import type { OverlapCluster, OverlapMember } from "@/lib/keywords/overlap";
import { formatPosition } from "@/lib/format";
import { useHashScroll } from "./use-hash-scroll";

/**
 * "Overlapping topics" on the Keywords screen: clusters of keywords that are
 * near-duplicates of each other, so the articles written for them compete in
 * search (lib/keywords/duplicates.ts).
 *
 * It reports and suggests, and that is all: each cluster names the article
 * to keep (most Search Console impressions, then best position) and there is
 * no button that deletes, merges or redirects. The owner decides.
 *
 * Numbers are Search Console's counts; "not measured" is said in words,
 * never shown as 0. A list, not a table: on a phone a row stacks.
 */

function measured(member: OverlapMember): string {
  const sc = member.searchConsole;
  if (!member.article) return "Not written yet";
  if (!member.article.publishedUrl) return `On the calendar (${member.article.status})`;
  if (!sc || sc.days === 0) return "Published · not measured by Search Console yet";
  const position = sc.position === null ? "no position measured" : `average position ${formatPosition(sc.position)}`;
  return `Published · ${sc.impressions ?? 0} impressions, ${sc.clicks ?? 0} clicks, ${position}`;
}

export function OverlappingTopicsList({ clusters }: { clusters: OverlapCluster[] }) {
  return (
    <ul className="space-y-4">
      {clusters.map((cluster) => (
        <li key={cluster.members.map((m) => m.keywordId).join(":")} className="rounded-lg border">
          <ul className="divide-y">
            {cluster.members.map((member) => {
              const keep = member.keywordId === cluster.keeperKeywordId;
              return (
                <li key={member.keywordId} className="flex flex-col gap-1 p-3 sm:flex-row sm:items-center sm:gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="break-words font-medium">
                      {member.keyword}
                      {keep && (
                        <span className="ml-2 rounded-full border px-2 py-0.5 text-xs font-normal text-muted-foreground">
                          Suggested to keep
                        </span>
                      )}
                    </p>
                    <p className="text-sm text-muted-foreground">{measured(member)}</p>
                  </div>
                  {member.article?.publishedUrl && (
                    <a
                      href={member.article.publishedUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex min-h-[44px] shrink-0 items-center gap-1 text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline md:min-h-0"
                    >
                      View article
                      <ExternalLink className="h-3 w-3" aria-hidden />
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="border-t bg-muted/40 p-3 text-sm">{cluster.recommendation}</p>
        </li>
      ))}
    </ul>
  );
}

export function OverlappingTopics({ refreshKey }: { /** Changes when the pool changed, to read the clusters again. */ refreshKey?: unknown }) {
  const [clusters, setClusters] = useState<OverlapCluster[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/keywords/overlaps");
      if (!response.ok) throw new Error("Failed to load overlapping topics");
      const data = await response.json();
      setClusters(Array.isArray(data.clusters) ? data.clusters : []);
      setFailed(false);
    } catch (error) {
      console.error("Error loading overlapping topics:", error);
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load on mount and when the pool changes; the state is set after the fetch resolves
    load();
  }, [load, refreshKey]);

  // The Content screen's "topics overlap" notice links here.
  useHashScroll("overlapping-topics", failed || (clusters?.length ?? 0) > 0);

  // Nothing overlapping is the ordinary state: the section appears only
  // when there is something to decide (or the read failed, said in words).
  if (!failed && (clusters === null || clusters.length === 0)) return null;

  return (
    <section aria-labelledby="overlapping-topics">
      <h2 id="overlapping-topics" className="mb-2 text-xl font-semibold">
        Overlapping topics
      </h2>
      <p className="mb-4 text-sm text-muted-foreground">
        These topics are close enough that their articles compete with each other in search. For each group, the
        article to keep is the one Search Console shows the most impressions for, then the best position. Nothing here
        is deleted, merged or redirected: what to do with the others is your call.
      </p>
      {failed ? (
        <p role="alert" className="rounded-lg border p-4 text-sm text-muted-foreground">
          The overlapping topics could not be loaded. Reload the page to try again.
        </p>
      ) : (
        <OverlappingTopicsList clusters={clusters ?? []} />
      )}
    </section>
  );
}
