"use client";

import { useState } from "react";
import type { AuditCheck } from "@/lib/placements/audit";
import type { PlacementDraftRecord } from "@/lib/placements/read";
import { legacyNumberSentences } from "@/lib/placements/numeric-claims";
import { ABOUT_YOU_FACT_MAX, factFromSentence } from "@/lib/voice/about-you";
import { cn } from "@/lib/utils";
import { BusyLabel, CHIP, FIELD, Problem } from "@/components/placements/ui";

/**
 * "It's true: add to About you", under a failed fact check
 * (`verifiable_claims`). One quiet action per flagged sentence; a tap opens
 * a one-line field in place, prefilled with the sentence as a dated fact
 * (`factFromSentence`, no model). Nothing is written until Save. Save adds
 * the fact to About you and judges the same text again, the "Check again"
 * path; nothing is rewritten. Then "Added to About you", with an Undo.
 * See docs/VOICE.md, "It's true" (2026-11-12).
 */

export type AddFactResult = { ok: true; aboutYou: string; fact: string; added: boolean } | { ok: false; error: string };
export type RemoveFactResult = { ok: true } | { ok: false; error: string };

/**
 * The sentences a check lets the person confirm. A check stored since
 * 12 November 2026 names them (`confirmable`). An older failed fact check
 * names none, so its undeclared numbers are read back from the text the way
 * that gate read them; only the fact check, never another.
 */
export function confirmableSentences(check: AuditCheck, draft: Pick<PlacementDraftRecord, "body" | "claims">): string[] {
  if (check.id !== "verifiable_claims" || check.status === "pass") return [];
  if (Array.isArray(check.confirmable)) return check.confirmable;
  if (!/numbers not declared as claims/.test(check.detail ?? "")) return [];
  return legacyNumberSentences(
    draft.body,
    draft.claims.map((claim) => claim.text ?? "")
  );
}

/** The sentence, short enough for one quiet line. */
function quoted(sentence: string): string {
  const clean = sentence.replace(/\s+/g, " ").trim();
  return clean.length > 70 ? `${clean.slice(0, 69).trimEnd()}…` : clean;
}

export function ConfirmFacts({
  sentences,
  now,
  disabled,
  onSave,
}: {
  sentences: string[];
  /** The page's clock: the date the prefilled fact carries. */
  now: number;
  disabled: boolean;
  /** Adds the fact and judges the draft again; resolves with an error sentence, or null. */
  onSave: (fact: string) => Promise<string | null>;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const [fact, setFact] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (sentences.length === 0) return null;

  const start = (index: number) => {
    setOpen(index);
    setFact(factFromSentence(sentences[index], new Date(now)));
    setError(null);
  };

  const save = async () => {
    if (saving || !fact.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const problem = await onSave(fact);
      if (problem) setError(problem);
      else setOpen(null);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-1" data-confirm-facts="">
      {sentences.map((sentence, index) =>
        open === index ? (
          <form
            key={index}
            noValidate
            className="flex flex-wrap items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <input
              value={fact}
              onChange={(e) => setFact(e.target.value)}
              maxLength={ABOUT_YOU_FACT_MAX}
              autoFocus
              aria-label="The fact to add to About you"
              className={cn(FIELD, "flex-1 basis-64")}
            />
            <button type="submit" disabled={disabled || saving || !fact.trim()} aria-busy={saving || undefined} className={cn(CHIP, "border-primary bg-primary font-semibold text-primary-foreground hover:bg-primary")}>
              <BusyLabel busy={saving}>Save</BusyLabel>
            </button>
            <button type="button" disabled={saving} onClick={() => setOpen(null)} className={CHIP}>
              Cancel
            </button>
          </form>
        ) : (
          <button
            key={index}
            type="button"
            disabled={disabled || saving}
            onClick={() => start(index)}
            title={sentence}
            className="-my-1 flex min-h-11 w-full items-center text-left text-xs text-muted-foreground underline-offset-2 hover:underline md:my-0 md:min-h-0"
          >
            {sentences.length > 1 ? `It's true: add to About you ("${quoted(sentence)}")` : "It's true: add to About you"}
          </button>
        )
      )}
      {error && <Problem>{error}</Problem>}
    </div>
  );
}

/** "Added to About you", and its Undo: shown once the fact is saved, whatever the checks say now. */
export function FactAdded({ onUndo, undoing, error }: { onUndo: () => void; undoing: boolean; error: string | null }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span role="status">Added to About you.</span>
      <button type="button" disabled={undoing} aria-busy={undoing || undefined} onClick={onUndo} className={CHIP}>
        <BusyLabel busy={undoing}>Undo</BusyLabel>
      </button>
      {error && <Problem>{error}</Problem>}
    </div>
  );
}
