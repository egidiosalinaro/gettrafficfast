"use client";

import { useState } from "react";
import { Loader2, Plus } from "lucide-react";
import { MAX_LINKS_PER_PASTE, PASTE_BLOCKED, linksFromPaste, readClipboard, type AddAttempt } from "@/lib/placements/paste";
import { shortLink } from "@/components/placements/posted-item";
import { FIELD, PRIMARY } from "@/components/placements/ui";
import { cn } from "@/lib/utils";

/**
 * Adding posts from X: the first thing on the Replies page, because it is
 * where the daily loop starts. One row: a field and one button. With the
 * field empty the button is "Paste & add": it reads the clipboard and adds
 * every link in it, one tap instead of Paste, then Add. Several links can
 * be pasted or typed at once (one per line or separated by spaces), at most
 * MAX_LINKS_PER_PASTE: each one starts a paid draft, and the account's
 * draft caps and spend ceiling still decide whether it does.
 *
 * What was not added is listed under the field with its reason, link by
 * link; nothing is dropped silently. The box for a post's own text appears
 * only after X refused to hand one post over.
 */

export interface AddReport {
  /** "3 posts added." or "2 of 5 posts added. 3 not added." */
  text: string;
  failed: AddAttempt[];
  /** What else the person should know: links the cap left out, drafts a cap is holding. */
  notes: string[];
}

export function AddPostForm({
  value,
  onChange,
  text,
  onTextChange,
  askForText,
  progress,
  report,
  onAdd,
}: {
  value: string;
  onChange: (value: string) => void;
  /** The post's text, asked for only when X would not hand one post over. */
  text: string;
  onTextChange: (value: string) => void;
  askForText: boolean;
  /** "Adding 2 of 5…" while posts are being added, else null. */
  progress: string | null;
  report: AddReport | null;
  onAdd: (links: string[], over: number) => void;
}) {
  const [note, setNote] = useState<string | null>(null);
  const adding = progress !== null;

  const add = (raw: string) => {
    const { links, over } = linksFromPaste(raw);
    if (links.length === 0) {
      setNote("No link there. Copy a post's link on X first.");
      return;
    }
    setNote(null);
    onAdd(links, over);
  };

  const pasteAndAdd = async () => {
    const clip = await readClipboard();
    if (clip === null) {
      setNote(PASTE_BLOCKED);
      return;
    }
    add(clip);
  };

  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!adding) add(value);
      }}
    >
      <div className="flex gap-2">
        {/* 16px text on a phone: iOS zooms the page into a smaller field. */}
        <input
          id="placements-add-url"
          type="text"
          inputMode="url"
          enterKeyHint="go"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setNote(null);
          }}
          placeholder="Links of posts on X"
          aria-label={`Links of posts on X, up to ${MAX_LINKS_PER_PASTE} at a time`}
          className={cn(FIELD, "flex-1")}
        />
        {adding ? (
          // Progress lives in the button: a line under the field made the
          // row taller and moved the title and the filter beside it.
          <button type="submit" disabled role="status" className={cn(PRIMARY, "w-auto shrink-0 whitespace-nowrap tabular-nums")}>
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> {progress}
          </button>
        ) : value.trim() ? (
          <button type="submit" className={cn(PRIMARY, "w-auto shrink-0")}>
            <Plus className="h-4 w-4" aria-hidden="true" /> Add
          </button>
        ) : (
          <button type="button" onClick={() => void pasteAndAdd()} className={cn(PRIMARY, "w-auto shrink-0")}>
            <Plus className="h-4 w-4" aria-hidden="true" /> Paste &amp; add
          </button>
        )}
      </div>
      {askForText && (
        <label className="block space-y-1 text-xs text-muted-foreground">
          <span>X did not let us read that post. Paste its text, then Add.</span>
          <textarea value={text} onChange={(e) => onTextChange(e.target.value)} rows={3} className={cn(FIELD, "py-2 leading-relaxed")} />
        </label>
      )}
      {note && !adding && (
        <p role="status" className="text-xs text-muted-foreground">
          {note}
        </p>
      )}
      {report && !adding && (report.failed.length > 0 || report.notes.length > 0) && (
        <div role="alert" className="space-y-1 text-xs">
          <p className="font-medium">{report.text}</p>
          {report.failed.map((attempt) => (
            <p key={attempt.link} className="text-red-700 dark:text-red-400">
              <span className="font-medium">{shortLink(attempt.link)}</span>: {attempt.error}
            </p>
          ))}
          {report.notes.map((line) => (
            <p key={line} className="text-muted-foreground">
              {line}
            </p>
          ))}
        </div>
      )}
    </form>
  );
}
