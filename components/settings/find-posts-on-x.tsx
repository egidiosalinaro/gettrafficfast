"use client";

import { useState } from "react";
import { Loader2, Search } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Find posts on X, in Settings → Connections (2026-11-14; it was a card in
 * Settings → Voice). The value is still `voice_settings.findPostsOnX`, so a
 * tap sends only that field through the partial PATCH the Today sheet's goal
 * uses (`updateVoiceSettings`, the merge `update_voice_settings` runs), and
 * nothing else in the voice moves.
 *
 * `available` is the platform's X API (`isXApiEnabled`, read on the server).
 * Without it there is no switch: a switch that does nothing would be a
 * promise the product does not keep. A site that turned it on earlier is
 * told nothing is searched.
 */
export function FindPostsOnXSwitch({
  initialOn,
  available,
  hasBusiness,
}: {
  initialOn: boolean;
  available: boolean;
  hasBusiness: boolean;
}) {
  const [on, setOn] = useState(initialOn);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    const next = !on;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/business/voice-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ findPostsOnX: next }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError((data && typeof data.error === "string" && data.error) || "Could not save. Try again.");
        return;
      }
      setOn(Boolean(data?.settings?.findPostsOnX ?? next));
    } catch {
      setError("Network error. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-2 rounded-2xl border border-border bg-card px-4 py-2">
      <div className="flex min-h-[44px] items-center gap-3">
        <Search className="h-5 w-5 shrink-0 text-foreground" aria-hidden="true" />
        <span className="flex-1 text-[15px] font-medium">Find posts on X</span>
        {available && (
          <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-label="Find posts on X"
            onClick={toggle}
            disabled={saving || !hasBusiness}
            className="flex min-h-[44px] items-center gap-2 rounded-md text-sm font-medium disabled:opacity-60"
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label="Saving" />
            ) : (
              <span className="text-muted-foreground">{on ? "On" : "Off"}</span>
            )}
            <span
              className={cn(
                "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors",
                on ? "border-primary bg-primary" : "border-border bg-muted"
              )}
            >
              <span
                className={cn(
                  "inline-block h-5 w-5 rounded-full bg-background shadow transition-transform",
                  on ? "translate-x-5" : "translate-x-0.5"
                )}
              />
            </span>
          </button>
        )}
      </div>
      {!available && (
        <p role="status" className="pb-1 text-sm text-muted-foreground">
          Not available yet: searching X is not set up on GetTrafficFast
          {on ? ", so nothing is searched even though this is on for your site" : ""}.
        </p>
      )}
      {available && !hasBusiness && (
        <p className="pb-1 text-xs text-muted-foreground">Set up your business first (Settings → Business).</p>
      )}
      {error && <p className="pb-1 text-sm text-red-700 dark:text-red-400">{error}</p>}
    </div>
  );
}
