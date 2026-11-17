"use client";

import { useEffect, useRef, useState } from "react";
import { ClipboardPaste, X } from "lucide-react";
import { leftToast, type InboxToast } from "@/lib/placements/inbox-view";
import { readClipboard } from "@/lib/placements/paste";
import { checkPublishedUrl, publishedUrlExample } from "@/lib/placements/published-url";
import { surfaceLabel } from "@/lib/placements/surfaces";
import type { PlacementTargetRecord } from "@/lib/placements/read";
import { cn } from "@/lib/utils";
import { pasteLinkFor } from "@/components/placements/posted-item";
import { BusyLabel, CHIP, FIELD, PRIMARY, Problem } from "@/components/placements/ui";

/**
 * The link to the reply, asked for the moment it is marked as posted
 * (2026-11-10).
 *
 * "I posted it" is recorded when it is tapped; this sheet only adds the
 * link afterwards. Skip, the close button, a tap outside and Escape all
 * leave the reply posted with no link, to be added later from "Posted, no
 * link": nothing here can lose a posted reply. The link is checked by the
 * same `checkPublishedUrl` as every other place a link is saved (the server
 * runs it again), so Save stays off until it passes and the line under the
 * field says why; Paste reads the clipboard and saves at once when the link
 * passes, like Paste link on a row.
 *
 * On a phone a bottom sheet (the More sheet's pattern in mobile-nav.tsx and
 * the filter sheet's), with the buttons above the field so the keyboard
 * never covers them; from `md` up a small modal in the middle.
 *
 * Since 2026-11-13 it does not open for a reply GTF will look for on X by
 * itself (`findingToast`): the toast says so, and the card says when GTF
 * stops looking.
 */

export type LinkSheetOutcome = "saved" | "skipped";

/** What the page says once the sheet closes. A saved link cannot be undone into "not posted" (the server refuses), so it has no Undo. */
export function linkSheetToast(outcome: LinkSheetOutcome): InboxToast {
  return outcome === "saved" ? { text: "Posted, link saved." } : leftToast("mark_published");
}

/**
 * What the page says after I posted it when GTF will find the link on X by
 * itself (lib/placements/reply-link.ts): no sheet, the Undo of a skipped one.
 */
export function findingToast(): InboxToast {
  return { text: "Posted. GTF will find its link on X.", action: { label: "Undo" } };
}

/** The hint for the one platform where the link is a few taps away. */
export function linkHint(surface: string): string | null {
  return surface === "x" ? "On X: your reply → Share → Copy link" : null;
}

/**
 * Save in the sheet: the typed link checked as everywhere else, then saved.
 * Null once saved; otherwise why not (the check's sentence, or the
 * server's), and nothing is saved for a link the check refuses.
 */
export async function saveTypedLink(io: {
  value: string;
  target: { surface: string; url: string };
  save: (url: string) => Promise<string | null>;
}): Promise<string | null> {
  const check = checkPublishedUrl(io.value, io.target);
  if (!check.ok) return check.error;
  return io.save(check.url);
}

export function LinkSheet({
  target,
  onSave,
  onClose,
  initialValue = "",
}: {
  /** What the field starts with: empty in the app. */
  initialValue?: string;
  target: Pick<PlacementTargetRecord, "surface" | "url">;
  /** Saves the link. Null once saved, else the server's sentence. */
  onSave: (url: string) => Promise<string | null>;
  onClose: (outcome: LinkSheetOutcome) => void;
}) {
  const [value, setValue] = useState(initialValue);
  const [saving, setSaving] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const working = saving || pasting;
  const check = checkPublishedUrl(value, target);
  const problem = !check.ok && value.trim() ? check.error : null;
  const where = target.surface === "web" ? "" : ` on ${surfaceLabel(target.surface)}`;
  const hint = linkHint(target.surface);

  // Escape skips. The panel takes the focus, not the field: on a phone a
  // focused field would open the keyboard before the person chose to type.
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });
  useEffect(() => {
    panelRef.current?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current("skipped");
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const save = async () => {
    if (!check.ok || working) return;
    setSaving(true);
    setRefused(null);
    try {
      const error = await saveTypedLink({ value, target, save: onSave });
      if (error) setRefused(error);
      else onClose("saved");
    } finally {
      setSaving(false);
    }
  };

  const paste = async () => {
    if (working) return;
    setPasting(true);
    setRefused(null);
    try {
      const error = await pasteLinkFor({ target, read: readClipboard, save: onSave });
      if (error) setRefused(error);
      else onClose("saved");
    } finally {
      setPasting(false);
    }
  };

  const typed = value.trim().length > 0;

  return (
    // `!mt-0`: the page's `space-y-3` would push a fixed child 12px down.
    <div className="fixed inset-0 z-50 !mt-0 flex items-end justify-center md:items-center md:p-4" data-link-sheet="">
      <button
        type="button"
        aria-label="Skip the link"
        tabIndex={-1}
        className="absolute inset-0 h-full w-full bg-black/40"
        onClick={() => onClose("skipped")}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="link-sheet-title"
        tabIndex={-1}
        className="relative flex w-full flex-col gap-3 rounded-t-2xl border-t border-border bg-background px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-2 shadow-xl outline-none md:max-w-md md:rounded-xl md:border md:pb-4 md:pt-3"
      >
        <div className="flex items-center gap-2">
          <h2 id="link-sheet-title" className="min-w-0 flex-1 text-base font-semibold">
            Posted. Link to your reply?
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={() => onClose("skipped")}
            className="-mr-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
        {hint && <p className="-mt-2 text-sm text-muted-foreground">{hint}</p>}

        {/* The buttons above the field: a phone's keyboard opens under the field and never covers them. */}
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            disabled={working}
            aria-busy={pasting || undefined}
            onClick={() => void paste()}
            className={typed ? cn(CHIP, "font-medium text-foreground") : cn(PRIMARY, "w-auto flex-1 md:flex-none")}
          >
            <BusyLabel busy={pasting}>
              <ClipboardPaste className="h-4 w-4" aria-hidden="true" /> Paste link
            </BusyLabel>
          </button>
          <button
            type="submit"
            form="link-sheet-form"
            disabled={!check.ok || working}
            aria-busy={saving || undefined}
            className={typed ? cn(PRIMARY, "w-auto flex-1 md:flex-none") : CHIP}
          >
            <BusyLabel busy={saving}>Save</BusyLabel>
          </button>
          <button type="button" disabled={working} onClick={() => onClose("skipped")} className={CHIP}>
            Skip
          </button>
        </div>

        <form
          id="link-sheet-form"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
          className="space-y-1"
        >
          <input
            type="url"
            inputMode="url"
            enterKeyHint="done"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            value={value}
            readOnly={working}
            onChange={(e) => {
              setValue(e.target.value);
              setRefused(null);
            }}
            placeholder={publishedUrlExample(target.surface)}
            aria-label={`Link to your reply${where}`}
            aria-invalid={Boolean(problem || refused)}
            className={FIELD}
          />
          {(refused || problem) && <Problem>{refused ?? problem}</Problem>}
        </form>
      </div>
    </div>
  );
}
