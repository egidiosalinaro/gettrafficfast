"use client";

import { useId, useState } from "react";
import { normalizeXHandle, xHandleProblem } from "@/lib/voice/settings";
import { BusyLabel, CHIP, FIELD, Problem } from "@/components/placements/ui";
import { cn } from "@/lib/utils";

/**
 * "Your X account" (2026-11-24): the site's X username, which GTF needs to
 * find the link of a reply marked as posted on X. Asked on Today the first
 * time a reply on X is marked as posted while it is unknown (the link sheet
 * and the posted reply's card), and kept in Settings → Connections.
 *
 * It saves `voice_settings.xHandle` for the selected site through the
 * partial PATCH (`updateVoiceSettings`, the merge `update_voice_settings`
 * runs), so nothing else in the voice moves. The same check as the server
 * (`XHandle`): 1 to 15 letters, digits or underscores, the @ optional,
 * stored lowercased; Save stays off until it passes, and the line under the
 * field says why.
 */

/** The line under "Your X account" where Today asks for it. */
export const X_HANDLE_HINT = "GTF finds the links of your replies on X by itself once it knows your account. Asked once for this site.";

export type SaveXHandleResult = { ok: true; handle: string | null } | { ok: false; error: string };

/** Saves the site's X account (null clears it). The server's sentence when it refuses. */
export async function saveXHandle(handle: string | null, fetcher: typeof fetch = fetch): Promise<SaveXHandleResult> {
  try {
    const res = await fetcher("/api/business/voice-settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ xHandle: handle }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: (data && typeof data.error === "string" && data.error) || "Could not save. Try again." };
    const saved = data?.settings?.xHandle;
    return { ok: true, handle: typeof saved === "string" ? saved : null };
  } catch {
    return { ok: false, error: "Network error. Try again." };
  }
}

export function XHandleField({
  initialValue = "",
  hint,
  onSaved,
  save = saveXHandle,
  className,
}: {
  /** What the field starts with (the saved handle, without the @), empty when none. */
  initialValue?: string;
  /** The line under the label. */
  hint?: string;
  /** Called with the handle as stored, once saved. */
  onSaved?: (handle: string | null) => void;
  /** Test seam: the save; the PATCH otherwise. */
  save?: (handle: string | null) => Promise<SaveXHandleResult>;
  className?: string;
}) {
  const id = useId();
  const [value, setValue] = useState(initialValue);
  const [saved, setSaved] = useState(initialValue ? normalizeXHandle(initialValue) : "");
  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const typed = value.trim().length > 0;
  const problem = typed ? xHandleProblem(value) : null;
  const unchanged = typed ? normalizeXHandle(value) === saved : saved === "";

  const submit = async () => {
    if (saving || problem || unchanged) return;
    setSaving(true);
    setRefused(null);
    try {
      const result = await save(typed ? normalizeXHandle(value) : null);
      if (!result.ok) {
        setRefused(result.error);
        return;
      }
      setSaved(result.handle ?? "");
      setValue(result.handle ?? "");
      onSaved?.(result.handle);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      noValidate
      data-x-handle-field=""
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className={cn("space-y-1", className)}
    >
      <label htmlFor={id} className="text-sm font-medium">
        Your X account
      </label>
      {hint && <p className="text-sm text-muted-foreground">{hint}</p>}
      <div className="flex items-center gap-1.5">
        <div className="relative min-w-0 flex-1">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden="true">
            @
          </span>
          <input
            id={id}
            type="text"
            inputMode="text"
            enterKeyHint="done"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            maxLength={40}
            value={value}
            readOnly={saving}
            onChange={(e) => {
              setValue(e.target.value);
              setRefused(null);
            }}
            placeholder="yourname"
            aria-label="Your X account"
            aria-invalid={Boolean(problem || refused)}
            className={cn(FIELD, "pl-7")}
          />
        </div>
        <button type="submit" disabled={saving || Boolean(problem) || unchanged} aria-busy={saving || undefined} className={cn(CHIP, "font-medium")}>
          <BusyLabel busy={saving}>Save</BusyLabel>
        </button>
      </div>
      {(refused || problem) && <Problem>{refused ?? problem}</Problem>}
      {!refused && !problem && saved && unchanged && (
        <p role="status" className="text-xs text-muted-foreground">
          Saved: @{saved}
        </p>
      )}
    </form>
  );
}
