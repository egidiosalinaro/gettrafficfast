"use client";

import { AtSign } from "lucide-react";
import { XHandleField } from "@/components/placements/x-handle-field";

/**
 * X in Settings → Connections (2026-11-24; it was the "Find posts on X"
 * switch until then). The X features have no per-site switch any more: when
 * the platform has the X API on (`available`, `isXApiEnabled` read on the
 * server) they run for every site. What the site still gives is its X
 * account (`voice_settings.xHandle`), which finding the link of a posted
 * reply needs. `inferred` is the handle the site's saved reply links name,
 * shown while none is saved: it is what GTF uses until one is.
 */
export function XAccountCard({
  saved,
  inferred,
  available,
  hasBusiness,
}: {
  saved: string | null;
  inferred: string | null;
  available: boolean;
  hasBusiness: boolean;
}) {
  return (
    <div className="space-y-2 rounded-2xl border border-border bg-card px-4 py-3">
      <div className="flex min-h-[44px] items-center gap-3">
        <AtSign className="h-5 w-5 shrink-0 text-foreground" aria-hidden="true" />
        <span className="flex-1 text-[15px] font-medium">X</span>
        <span className="text-sm text-muted-foreground">{available ? "On for every site" : "Not available yet"}</span>
      </div>
      {!available && (
        <p role="status" className="pb-1 text-sm text-muted-foreground">
          Not available yet: reading X is not set up on GetTrafficFast, so nothing is searched or read on X.
        </p>
      )}
      {hasBusiness ? (
        <XHandleField
          initialValue={saved ?? ""}
          hint={
            saved
              ? "The account this site's replies on X are posted from."
              : inferred
                ? `From your saved reply links: @${inferred}. Save it, or another one, to be sure.`
                : "The account this site's replies on X are posted from. GTF needs it to find your replies' links on X."
          }
          className="pb-1"
        />
      ) : (
        <p className="pb-1 text-xs text-muted-foreground">Set up your business first (Settings → Business).</p>
      )}
    </div>
  );
}
