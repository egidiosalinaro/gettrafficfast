"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  Loader2,
  X,
  Search,
  CheckCircle2,
  AlertCircle,
  Sparkles,
} from "lucide-react";
import { KeywordSuggestion } from "@/lib/research/keywords";
import { pluralize } from "@/lib/utils";

interface AddKeywordsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export function AddKeywordsModal({
  isOpen,
  onClose,
  onSuccess,
}: AddKeywordsModalProps) {
  const [step, setStep] = useState<"input" | "suggestions">("input");
  const [userKeywords, setUserKeywords] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [suggestions, setSuggestions] = useState<KeywordSuggestion[]>([]);
  const [selectedSuggestions, setSelectedSuggestions] = useState<Set<number>>(
    new Set()
  );
  // Ideas left out because they overlap a topic the site already has
  // (lib/keywords/duplicates.ts), said under the list so their absence reads.
  const [leftOut, setLeftOut] = useState<Array<{ keyword: string }>>([]);
  // Selected keywords the save refused for the same reason; "Add anyway" is
  // the explicit override.
  const [refused, setRefused] = useState<KeywordSuggestion[]>([]);
  // Some keywords were saved while the modal stayed open: closing it then
  // refreshes the page's list like a finished add.
  const [addedSome, setAddedSome] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  if (!isOpen) return null;

  const handleGenerateFromBusiness = async () => {
    setIsGenerating(true);
    setMessage(null);

    try {
      const response = await fetch("/api/keywords/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ generateFromBusiness: true }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to generate keywords");
      }

      const { suggestions: data, duplicates } = await response.json();
      setSuggestions(data || []);
      setLeftOut(Array.isArray(duplicates) ? duplicates : []);
      setStep("suggestions");
      setSelectedSuggestions(new Set((data || []).map((_: unknown, i: number) => i)));
    } catch (error) {
      console.error("Error generating keywords:", error);
      setMessage({
        type: "error",
        text:
          error instanceof Error
            ? error.message
            : "Failed to generate keywords. Please try again.",
      });
    } finally {
      setIsGenerating(false);
    }
  };

  const handleFindSuggestions = async () => {
    const keywordsArray = userKeywords
      .split("\n")
      .map((k) => k.trim())
      .filter((k) => k.length > 0);

    if (keywordsArray.length === 0) {
      setMessage({
        type: "error",
        text: "Please enter at least one keyword",
      });
      return;
    }

    setIsSearching(true);
    setMessage(null);

    try {
      const response = await fetch("/api/keywords/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keywords: keywordsArray }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to find suggestions");
      }

      const { suggestions: data, duplicates } = await response.json();
      setSuggestions(data || []);
      setLeftOut(Array.isArray(duplicates) ? duplicates : []);
      setStep("suggestions");
      setSelectedSuggestions(new Set((data || []).map((_: unknown, i: number) => i)));
    } catch (error) {
      console.error("Error finding suggestions:", error);
      setMessage({
        type: "error",
        text:
          error instanceof Error
            ? error.message
            : "Failed to find suggestions. Please try again.",
      });
    } finally {
      setIsSearching(false);
    }
  };

  const handleSave = async (anyway: KeywordSuggestion[] | null = null) => {
    if (!anyway && selectedSuggestions.size === 0) {
      setMessage({
        type: "error",
        text: "Please select at least one keyword to add",
      });
      return;
    }

    setIsSaving(true);
    setMessage(null);

    try {
      const selectedKeywords =
        anyway ?? Array.from(selectedSuggestions).map((index) => suggestions[index]);

      const response = await fetch("/api/keywords/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          anyway ? { keywords: selectedKeywords, allowDuplicates: true } : { keywords: selectedKeywords }
        ),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to save keywords");
      }

      const result = await response.json();
      // Some were refused for overlapping a topic the site already has: say
      // which, and stay open so "Add anyway" can be chosen.
      const overlapping: Array<{ keyword: string }> = Array.isArray(result.duplicates) ? result.duplicates : [];
      if (overlapping.length > 0) {
        const names = new Set(overlapping.map((d) => d.keyword));
        setRefused(selectedKeywords.filter((k) => names.has(k.keyword.trim())));
        setMessage({ type: "error", text: result.message || "Some keywords overlap a topic you already have." });
        if (Array.isArray(result.keywords) && result.keywords.length > 0) setAddedSome(true);
        return;
      }
      setRefused([]);
      setMessage({
        type: "success",
        text: result.message || `${pluralize(selectedKeywords.length, "keyword")} added.`,
      });

      setTimeout(() => {
        onSuccess();
        handleReset();
      }, 1500);
    } catch (error) {
      console.error("Error saving keywords:", error);
      setMessage({
        type: "error",
        text:
          error instanceof Error
            ? error.message
            : "Failed to save keywords. Please try again.",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleReset = () => {
    setStep("input");
    setUserKeywords("");
    setSuggestions([]);
    setSelectedSuggestions(new Set());
    setLeftOut([]);
    setRefused([]);
    setAddedSome(false);
    setMessage(null);
  };

  const close = () => {
    if (addedSome) {
      onSuccess();
      handleReset();
    } else {
      onClose();
    }
  };

  const toggleSuggestion = (index: number) => {
    setSelectedSuggestions((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(index)) {
        newSet.delete(index);
      } else {
        newSet.add(index);
      }
      return newSet;
    });
  };

  const selectAll = () => {
    setSelectedSuggestions(new Set(suggestions.map((_, i) => i)));
  };

  const deselectAll = () => {
    setSelectedSuggestions(new Set());
  };

  const getDifficultyColor = (difficulty: number) => {
    if (difficulty <= 30) return "bg-green-100 text-green-700 border-green-200 dark:bg-green-950/40 dark:text-green-300 dark:border-green-800";
    if (difficulty <= 60) return "bg-yellow-100 text-yellow-700 border-yellow-200 dark:bg-yellow-950/40 dark:text-yellow-300 dark:border-yellow-800";
    return "bg-red-100 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800";
  };

  const formatNumber = (num: number | null) => {
    if (num === null) return "N/A";
    if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
    return num.toLocaleString("en-US");
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Overlay */}
      <div
        className="fixed inset-0 bg-black/80"
        onClick={close}
      />

      {/* Modal */}
      <div className="relative z-50 w-full max-w-4xl max-h-[90vh] bg-background border rounded-lg shadow-lg flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b">
          <div>
            <h2 className="text-xl font-semibold">Add Keywords</h2>
            <p className="text-sm text-muted-foreground mt-1">
              {step === "input"
                ? "Enter your keywords and we'll find similar ones using AI"
                : "Select keywords to add to your list"}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-11 w-11 items-center justify-center hover:bg-muted rounded-md md:h-9 md:w-9"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {message && (
            <div
              className={`flex items-center gap-2 p-4 rounded-md mb-4 ${
                message.type === "success"
                  ? "bg-green-50 dark:bg-green-950/40 text-green-900 dark:text-green-100 border border-green-200 dark:border-green-800"
                  : "bg-red-50 dark:bg-red-950/40 text-red-900 dark:text-red-100 border border-red-200 dark:border-red-800"
              }`}
            >
              {message.type === "success" ? (
                <CheckCircle2 className="h-5 w-5" />
              ) : (
                <AlertCircle className="h-5 w-5" />
              )}
              <p className="text-sm">{message.text}</p>
            </div>
          )}

          {step === "input" ? (
            <div className="space-y-4">
              <Button
                onClick={handleGenerateFromBusiness}
                disabled={isGenerating}
                className="w-full"
                variant="outline"
              >
                {isGenerating ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Generating Keywords...
                  </>
                ) : (
                  <>
                    <Sparkles className="mr-2 h-4 w-4" />
                    Generate Keywords from Business
                  </>
                )}
              </Button>
              <p className="text-xs text-muted-foreground text-center">
                Automatically generate keywords based on your business information
              </p>

              <div className="flex items-center gap-3">
                <div className="flex-1 border-t"></div>
                <span className="text-xs text-muted-foreground uppercase">Or</span>
                <div className="flex-1 border-t"></div>
              </div>

              <div>
                <Label htmlFor="keywords">Enter Keywords</Label>
                <Textarea
                  id="keywords"
                  placeholder="One keyword per line"
                  value={userKeywords}
                  onChange={(e) => setUserKeywords(e.target.value)}
                  rows={8}
                  className="mt-2"
                />
                <p className="text-xs text-muted-foreground mt-2">
                  Enter one keyword per line. Our AI will find similar and related keywords for you.
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">
                    {selectedSuggestions.size} of {pluralize(suggestions.length, "keyword")} selected
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={selectAll}>
                    Select All
                  </Button>
                  <Button variant="outline" size="sm" onClick={deselectAll}>
                    Deselect All
                  </Button>
                </div>
              </div>

              <div className="border rounded-lg overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-muted/50 border-b">
                      <tr>
                        <th className="text-left p-3 w-[50px]">
                          <Checkbox
                            checked={
                              selectedSuggestions.size === suggestions.length &&
                              suggestions.length > 0
                            }
                            onCheckedChange={(checked) => {
                              if (checked) selectAll();
                              else deselectAll();
                            }}
                          />
                        </th>
                        <th className="text-left p-3 text-xs font-semibold text-muted-foreground">
                          Keyword
                        </th>
                        <th className="text-left p-3 text-xs font-semibold text-muted-foreground">
                          Opportunity
                        </th>
                        <th
                          className="text-left p-3 text-xs font-semibold text-muted-foreground"
                          title="Model estimate, not measured data"
                        >
                          Difficulty <span className="font-normal">(est.)</span>
                        </th>
                        <th
                          className="text-left p-3 text-xs font-semibold text-muted-foreground"
                          title="Model estimate, not measured data"
                        >
                          Volume <span className="font-normal">(est.)</span>
                        </th>
                        <th
                          className="text-left p-3 text-xs font-semibold text-muted-foreground"
                          title="Model estimate, not measured data"
                        >
                          CPC <span className="font-normal">(est.)</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {suggestions.map((suggestion, index) => (
                        <tr
                          key={index}
                          className="border-b hover:bg-muted/30 transition-colors"
                        >
                          <td className="p-3">
                            <Checkbox
                              checked={selectedSuggestions.has(index)}
                              onCheckedChange={() => toggleSuggestion(index)}
                            />
                          </td>
                          <td className="p-3 font-medium">
                            {suggestion.keyword}
                          </td>
                          <td className="p-3">
                            <Badge
                              variant="outline"
                              className={
                                suggestion.opportunity === "Low"
                                  ? "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800"
                                  : suggestion.opportunity === "Medium"
                                  ? "bg-yellow-50 text-yellow-700 border-yellow-200 dark:bg-yellow-950/40 dark:text-yellow-300 dark:border-yellow-800"
                                  : "bg-green-50 text-green-700 border-green-200 dark:bg-green-950/40 dark:text-green-300 dark:border-green-800"
                              }
                            >
                              {suggestion.opportunity}
                            </Badge>
                          </td>
                          <td className="p-3">
                            <Badge
                              variant="outline"
                              className={getDifficultyColor(suggestion.difficulty)}
                            >
                              {suggestion.difficulty}
                            </Badge>
                          </td>
                          <td className="p-3 text-sm">
                            {formatNumber(suggestion.searchVolume)}
                          </td>
                          <td className="p-3 text-sm">
                            {suggestion.cpc
                              ? `$${suggestion.cpc.toFixed(1)}`
                              : "N/A"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              {leftOut.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  {pluralize(leftOut.length, "idea was", "ideas were")} left out because{" "}
                  {leftOut.length === 1 ? "it overlaps" : "they overlap"} a topic you already have:{" "}
                  {leftOut
                    .slice(0, 5)
                    .map((d) => d.keyword)
                    .join(", ")}
                  {leftOut.length > 5 ? "…" : ""}. Two articles on one topic compete with each other.
                </p>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 p-6 border-t">
          {step === "input" ? (
            <>
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button
                onClick={handleFindSuggestions}
                disabled={isSearching || isGenerating || !userKeywords.trim()}
              >
                {isSearching ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Finding Suggestions...
                  </>
                ) : (
                  <>
                    <Search className="mr-2 h-4 w-4" />
                    Find Similar Keywords
                  </>
                )}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => setStep("input")}>
                Back
              </Button>
              <Button variant="outline" onClick={close}>
                {addedSome ? "Done" : "Cancel"}
              </Button>
              {refused.length > 0 && (
                <Button variant="outline" onClick={() => handleSave(refused)} disabled={isSaving}>
                  Add the {refused.length} overlapping anyway
                </Button>
              )}
              <Button
                onClick={() => handleSave()}
                disabled={isSaving || selectedSuggestions.size === 0}
              >
                {isSaving ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="mr-2 h-4 w-4" />
                    Add {selectedSuggestions.size} Keyword
                    {selectedSuggestions.size !== 1 ? "s" : ""}
                  </>
                )}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
