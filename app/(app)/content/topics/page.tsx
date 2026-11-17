"use client";

import { useState, useEffect, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Search,
  Plus,
  Trash2,
  Star,
  Loader2,
  X,
  CalendarPlus,
  Sparkles,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  ExternalLink,
  AlertCircle,
  CheckCircle2,
} from "lucide-react";
import { AddKeywordsModal } from "@/components/keywords/add-keywords-modal";
import { BackToContent } from "@/components/content/back-to-content";
import { AskedInPublicThread, QuestionIdeas } from "@/components/keywords/question-ideas";
import { OverlappingTopics } from "@/components/keywords/overlapping-topics";
import { QUESTION_SOURCE } from "@/lib/keywords/questions";
import { refreshOnboarding } from "@/lib/onboarding";
import {
  bestPicks,
  isAddable,
  sortKeywords,
  type KeywordSortColumn,
  type SortDirection,
} from "@/lib/keywords/picks";
import { cn, pluralize } from "@/lib/utils";

interface Keyword {
  id: string;
  keyword: string;
  // Null on a keyword taken from a question asked in a public thread
  // (`source`): nothing about it is measured or estimated.
  search_volume: number | null;
  competition: string | null;
  difficulty: number | null;
  cpc: number | null;
  opportunity: string | null;
  source?: string | null;
  source_url?: string | null;
  status: string;
  is_starred: boolean;
  article_id: string | null;
  /** Where the keyword's article went live, when it did (api/keywords/get). */
  published_url: string | null;
}

/** The tooltip on every column a model estimated. */
const ESTIMATE_NOTE = "Model estimate, not measured data";

/** Phones get 44px targets; from md up the table keeps its compact rows. */
const TOUCH = "min-h-[44px] md:min-h-0";

type SortColumn = KeywordSortColumn;
type SortDir = SortDirection;

export default function KeywordsPage() {
  const [keywords, setKeywords] = useState<Keyword[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedKeywords, setSelectedKeywords] = useState<Set<string>>(new Set());
  const [isBulkAdding, setIsBulkAdding] = useState(false);
  const [sort, setSort] = useState<{ column: SortColumn; dir: SortDir } | null>(
    null
  );
  // Outcomes are said on the page, never in a native alert or confirm.
  const [notice, setNotice] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  // Bumped when the pool changes outside "Questions people ask" (keywords
  // added in the modal, keywords deleted), so its list is read again: a
  // question is offered only while no keyword covers it.
  const [poolVersion, setPoolVersion] = useState(0);

  const loadKeywords = async () => {
    try {
      setIsLoading(true);
      const params = new URLSearchParams();
      if (searchQuery) {
        params.append("search", searchQuery);
      }
      
      const response = await fetch(`/api/keywords/get?${params.toString()}`);
      if (!response.ok) {
        throw new Error("Failed to load keywords");
      }
      const { keywords: data } = await response.json();
      setKeywords(data || []);
    } catch (error) {
      console.error("Error loading keywords:", error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- existing load-on-mount effect, flagged by eslint-plugin-react-hooks 7.1; behaviour unchanged
    loadKeywords();
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      loadKeywords();
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const handleStarToggle = async (keywordId: string, currentStarred: boolean) => {
    try {
      const response = await fetch("/api/keywords/update", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          keywordId,
          updates: { is_starred: !currentStarred },
        }),
      });

      if (response.ok) {
        setKeywords((prev) =>
          prev.map((k) =>
            k.id === keywordId ? { ...k, is_starred: !currentStarred } : k
          )
        );
      }
    } catch (error) {
      console.error("Error toggling star:", error);
    }
  };

  const handleAddToCalendar = async (keywordId: string) => {
    setNotice(null);
    try {
      const res = await fetch("/api/calendar/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keywordId }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to add to calendar");
      }
      loadKeywords();
      refreshOnboarding();
    } catch (e) {
      console.error(e);
      setNotice({
        type: "error",
        text: e instanceof Error ? e.message : "Failed to add to calendar",
      });
    }
  };

  const handleBulkAddToCalendar = async (keywordIds: string[]) => {
    if (keywordIds.length === 0) return;
    setNotice(null);
    try {
      setIsBulkAdding(true);
      const res = await fetch("/api/calendar/add-bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keywordIds }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to add keywords to calendar");
      }
      setSelectedKeywords(new Set());
      if (typeof data.message === "string" && data.message) {
        setNotice({ type: "success", text: data.message });
      }
      await loadKeywords();
      refreshOnboarding();
    } catch (e) {
      console.error(e);
      setNotice({
        type: "error",
        text: e instanceof Error ? e.message : "Failed to add keywords to calendar",
      });
    } finally {
      setIsBulkAdding(false);
    }
  };

  const handleRemoveFromCalendar = async (keywordId: string) => {
    const kw = keywords.find((k) => k.id === keywordId);
    if (!kw?.article_id) return;
    setNotice(null);
    try {
      const res = await fetch("/api/calendar/remove", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ articleId: kw.article_id }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Could not remove it from the calendar");
      }
      loadKeywords();
    } catch (e) {
      console.error(e);
      setNotice({
        type: "error",
        text: e instanceof Error ? e.message : "Could not remove it from the calendar",
      });
    }
  };

  // Deleting asks once, inline: the first click shows the question next to
  // the button, the second one deletes.
  const handleBulkDelete = async () => {
    if (selectedKeywords.size === 0) return;
    setNotice(null);
    setIsDeleting(true);
    try {
      const response = await fetch(
        `/api/keywords/delete?ids=${Array.from(selectedKeywords).join(",")}`,
        { method: "DELETE" }
      );
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || "Could not delete the keywords");
      }
      setKeywords((prev) => prev.filter((k) => !selectedKeywords.has(k.id)));
      setNotice({
        type: "success",
        text: `${pluralize(selectedKeywords.size, "topic")} deleted.`,
      });
      setSelectedKeywords(new Set());
      setPoolVersion((v) => v + 1);
    } catch (error) {
      console.error("Error deleting keywords:", error);
      setNotice({
        type: "error",
        text: error instanceof Error ? error.message : "Could not delete the keywords",
      });
    } finally {
      setIsDeleting(false);
      setConfirmingDelete(false);
    }
  };

  const getDifficultyColor = (difficulty: number) => {
    if (difficulty <= 30) return "bg-green-100 text-green-700 border-green-200 dark:bg-green-950/40 dark:text-green-300 dark:border-green-800";
    if (difficulty <= 60) return "bg-yellow-100 text-yellow-700 border-yellow-200 dark:bg-yellow-950/40 dark:text-yellow-300 dark:border-yellow-800";
    return "bg-red-100 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800";
  };

  const getCompetitionColor = (competition: string) => {
    if (competition === "Low") return "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800";
    if (competition === "Medium") return "bg-yellow-50 text-yellow-700 border-yellow-200 dark:bg-yellow-950/40 dark:text-yellow-300 dark:border-yellow-800";
    return "bg-green-50 text-green-700 border-green-200 dark:bg-green-950/40 dark:text-green-300 dark:border-green-800";
  };

  const formatNumber = (num: number | null) => {
    if (num === null) return "N/A";
    if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
    return num.toLocaleString("en-US");
  };

  const formatCurrency = (amount: number | null) => {
    if (amount === null) return "N/A";
    return `$${amount.toFixed(1)}`;
  };

  // A keyword is "addable" until it has an article (i.e. is on the calendar).
  const addableKeywords = useMemo(
    () => keywords.filter(isAddable),
    [keywords]
  );
  // Recommended = the best picks (lib/keywords/picks.ts, the rule
  // `recommend_keywords` answers with), queued in one click.
  const recommendedKeywords = useMemo(
    () => bestPicks(addableKeywords),
    [addableKeywords]
  );
  const selectedAddableIds = useMemo(
    () =>
      addableKeywords
        .filter((k) => selectedKeywords.has(k.id))
        .map((k) => k.id),
    [addableKeywords, selectedKeywords]
  );

  // Changing the selection withdraws a pending "Delete N keywords?" question:
  // it was asked about the old selection.
  const toggleSelectKeyword = (id: string) => {
    setConfirmingDelete(false);
    setSelectedKeywords((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allSelected =
    keywords.length > 0 && selectedKeywords.size === keywords.length;
  const toggleSelectAll = () => {
    setConfirmingDelete(false);
    setSelectedKeywords((prev) =>
      prev.size === keywords.length
        ? new Set()
        : new Set(keywords.map((k) => k.id))
    );
  };

  const toggleSort = (column: SortColumn) => {
    setSort((prev) => {
      if (prev?.column === column) {
        return { column, dir: prev.dir === "desc" ? "asc" : "desc" };
      }
      return { column, dir: "desc" };
    });
  };

  // The same sort as `list_keywords` (lib/keywords/picks.ts): unknown volume
  // or CPC always sorts to the bottom.
  const sortedKeywords = useMemo(
    () => (sort ? sortKeywords(keywords, sort) : keywords),
    [keywords, sort]
  );

  const sortIcon = (column: SortColumn) => {
    if (sort?.column !== column) {
      return <ArrowUpDown className="h-3 w-3 opacity-40" />;
    }
    return sort.dir === "asc" ? (
      <ArrowUp className="h-3 w-3" />
    ) : (
      <ArrowDown className="h-3 w-3" />
    );
  };

  return (
    <div className="flex-1 w-full flex flex-col gap-8">
      <div>
        <BackToContent />
        <h1 className="text-3xl font-bold">Topics</h1>
      </div>

      <div>
        <p className="text-sm text-muted-foreground mb-6">
          Topics proposed from your site&apos;s niche, description and URL, or
          typed by you. Volume, difficulty and CPC are a model&apos;s
          estimates, not measured search data: use them to compare topics
          with each other, not as a traffic forecast. A topic from
          &quot;Questions people ask&quot; has none: it shows where it was
          asked instead.
        </p>

        {notice && (
          <div
            role={notice.type === "error" ? "alert" : "status"}
            className={cn(
              "mb-4 flex items-start gap-2 rounded-md border p-3 text-sm",
              notice.type === "success"
                ? "border-green-200 bg-green-50 text-green-900 dark:border-green-800 dark:bg-green-950/40 dark:text-green-100"
                : "border-red-200 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-100"
            )}
          >
            {notice.type === "success" ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            ) : (
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            )}
            <p className="flex-1">{notice.text}</p>
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

        {/* Control Bar */}
        <div className="flex items-center gap-4 mb-4 flex-wrap">
          <Button onClick={() => setIsModalOpen(true)} className={TOUCH}>
            <Plus className="h-4 w-4 mr-2" />
            Add topics
          </Button>

          <div className="flex-1 min-w-[200px]">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search topics..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9 h-11 md:h-9"
              />
            </div>
          </div>

          <span className="text-sm text-muted-foreground whitespace-nowrap">
            {pluralize(keywords.length, "topic")} in total
          </span>
        </div>

        {/* Bulk add-to-calendar bar: skip clicking "Add to Calendar" per row */}
        {addableKeywords.length > 0 && (
          <div className="flex items-center gap-3 flex-wrap mb-4 rounded-lg border bg-muted/30 p-3">
            <span className="text-sm font-medium">
              Schedule in bulk
            </span>
            <Button
              size="sm"
              onClick={() =>
                handleBulkAddToCalendar(addableKeywords.map((k) => k.id))
              }
              disabled={isBulkAdding}
              className={TOUCH}
            >
              {isBulkAdding ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <CalendarPlus className="h-4 w-4 mr-2" />
              )}
              Add all ({addableKeywords.length})
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                handleBulkAddToCalendar(recommendedKeywords.map((k) => k.id))
              }
              disabled={isBulkAdding || recommendedKeywords.length === 0}
              title="High opportunity and an estimated difficulty of 60 or below"
              className={TOUCH}
            >
              <Sparkles className="h-4 w-4 mr-2" />
              Add best picks ({recommendedKeywords.length})
            </Button>
            {selectedAddableIds.length > 0 && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => handleBulkAddToCalendar(selectedAddableIds)}
                disabled={isBulkAdding}
                className={TOUCH}
              >
                <CalendarPlus className="h-4 w-4 mr-2" />
                Add selected ({selectedAddableIds.length})
              </Button>
            )}
            <span className="text-xs text-muted-foreground">
              Each topic is scheduled on the next free day and written
              automatically.
            </span>
          </div>
        )}

        {selectedKeywords.size > 0 && (
          <div className="flex items-center gap-3 flex-wrap mb-4">
            <span className="text-sm text-muted-foreground">
              {selectedKeywords.size} selected
            </span>
            {confirmingDelete ? (
              <>
                <span className="text-sm font-medium">
                  Delete {pluralize(selectedKeywords.size, "topic")}? This cannot be undone.
                </span>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={handleBulkDelete}
                  disabled={isDeleting}
                  className={TOUCH}
                >
                  {isDeleting ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Trash2 className="h-4 w-4 mr-2" />
                  )}
                  Delete
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmingDelete(false)}
                  disabled={isDeleting}
                  className={TOUCH}
                >
                  Cancel
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setConfirmingDelete(true)}
                  className={cn("text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300", TOUCH)}
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete ({selectedKeywords.size})
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelectedKeywords(new Set())}
                  className={TOUCH}
                >
                  Clear selection
                </Button>
              </>
            )}
          </div>
        )}

        {/* Keywords Table */}
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : keywords.length === 0 ? (
          <div className="text-center py-12 border rounded-lg">
            <p className="text-muted-foreground mb-4">
              No topics yet. They are proposed from your business profile,
              or typed by you.
            </p>
            <Button onClick={() => setIsModalOpen(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Add your first topics
            </Button>
          </div>
        ) : (
          <div className="border rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-muted/50 border-b">
                  <tr>
                    <th className="text-left p-4 w-[40px]">
                      <Checkbox
                        checked={allSelected}
                        onCheckedChange={toggleSelectAll}
                        aria-label="Select all topics"
                      />
                    </th>
                    <th className="text-left p-4 text-xs font-semibold text-muted-foreground w-[300px]">
                      Topic
                    </th>
                    <th className="text-left p-4 text-xs font-semibold text-muted-foreground">
                      <button
                        type="button"
                        onClick={() => toggleSort("opportunity")}
                        className="flex items-center gap-1 hover:text-foreground transition-colors"
                      >
                        Opportunity
                        {sortIcon("opportunity")}
                      </button>
                    </th>
                    <th className="text-left p-4 text-xs font-semibold text-muted-foreground">
                      <button
                        type="button"
                        onClick={() => toggleSort("difficulty")}
                        title={ESTIMATE_NOTE}
                        className="flex items-center gap-1 hover:text-foreground transition-colors"
                      >
                        Difficulty <span className="font-normal">(est.)</span>
                        {sortIcon("difficulty")}
                      </button>
                    </th>
                    <th className="text-left p-4 text-xs font-semibold text-muted-foreground">
                      <button
                        type="button"
                        onClick={() => toggleSort("search_volume")}
                        title={ESTIMATE_NOTE}
                        className="flex items-center gap-1 hover:text-foreground transition-colors"
                      >
                        Volume <span className="font-normal">(est.)</span>
                        {sortIcon("search_volume")}
                      </button>
                    </th>
                    <th className="text-left p-4 text-xs font-semibold text-muted-foreground">
                      <button
                        type="button"
                        onClick={() => toggleSort("cpc")}
                        title={ESTIMATE_NOTE}
                        className="flex items-center gap-1 hover:text-foreground transition-colors"
                      >
                        CPC <span className="font-normal">(est.)</span>
                        {sortIcon("cpc")}
                      </button>
                    </th>
                    <th className="text-left p-4 text-xs font-semibold text-muted-foreground">
                      Action
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sortedKeywords.map((keyword) => (
                    <tr
                      key={keyword.id}
                      className="border-b hover:bg-muted/30 transition-colors"
                    >
                      <td className="p-4">
                        <Checkbox
                          checked={selectedKeywords.has(keyword.id)}
                          onCheckedChange={() => toggleSelectKeyword(keyword.id)}
                          aria-label={`Select ${keyword.keyword}`}
                        />
                      </td>
                      <td className="p-4">
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => handleStarToggle(keyword.id, keyword.is_starred)}
                            aria-label={keyword.is_starred ? "Unstar keyword" : "Star keyword"}
                            aria-pressed={keyword.is_starred}
                            className="-m-2 flex h-11 w-11 shrink-0 items-center justify-center rounded hover:bg-muted md:m-0 md:h-auto md:w-auto md:p-1"
                          >
                            <Star
                              className={`h-4 w-4 ${
                                keyword.is_starred
                                  ? "fill-yellow-400 text-yellow-400"
                                  : "text-muted-foreground"
                              }`}
                            />
                          </button>
                          <span className="font-medium">{keyword.keyword}</span>
                        </div>
                      </td>
                      {keyword.source === QUESTION_SOURCE ? (
                        // A question from a thread has no estimates: one
                        // cell says where it was asked, in place of four numbers.
                        <td className="p-4" colSpan={4}>
                          <AskedInPublicThread sourceUrl={keyword.source_url ?? null} />
                        </td>
                      ) : (
                        <>
                          <td className="p-4">
                            {keyword.opportunity ? (
                              <Badge
                                variant="outline"
                                className={getCompetitionColor(keyword.opportunity)}
                              >
                                {keyword.opportunity}
                              </Badge>
                            ) : (
                              <span className="text-sm">N/A</span>
                            )}
                          </td>
                          <td className="p-4">
                            {keyword.difficulty === null ? (
                              <span className="text-sm">N/A</span>
                            ) : (
                              <Badge
                                variant="outline"
                                className={getDifficultyColor(keyword.difficulty)}
                              >
                                {keyword.difficulty}
                              </Badge>
                            )}
                          </td>
                          <td className="p-4 text-sm">
                            {formatNumber(keyword.search_volume)}
                          </td>
                          <td className="p-4 text-sm">
                            {formatCurrency(keyword.cpc)}
                          </td>
                        </>
                      )}
                      <td className="p-4">
                        {keyword.status === "queued" ? (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleRemoveFromCalendar(keyword.id)}
                            className={TOUCH}
                          >
                            <X className="h-3 w-3 mr-1" />
                            Remove from Calendar
                          </Button>
                        ) : keyword.status === "published" ? (
                          // The live page, when the delivery recorded one.
                          // Without a URL there is nothing true to open.
                          keyword.published_url ? (
                            <Button variant="outline" size="sm" asChild className={TOUCH}>
                              <a
                                href={keyword.published_url}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                <ExternalLink className="h-3 w-3 mr-1" />
                                View Article
                              </a>
                            </Button>
                          ) : (
                            <span className="text-xs text-muted-foreground">Published</span>
                          )
                        ) : (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleAddToCalendar(keyword.id)}
                            className={TOUCH}
                          >
                            <Plus className="h-3 w-3 mr-1" />
                            Add to Calendar
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      <OverlappingTopics refreshKey={`${poolVersion}:${keywords.length}`} />

      <QuestionIdeas
        refreshKey={poolVersion}
        onAdded={() => {
          loadKeywords();
          refreshOnboarding();
        }}
        onNotice={setNotice}
      />

      <AddKeywordsModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onSuccess={() => {
          setIsModalOpen(false);
          loadKeywords();
          setPoolVersion((v) => v + 1);
          refreshOnboarding();
        }}
      />
    </div>
  );
}
