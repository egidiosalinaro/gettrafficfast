"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronDown, Globe, Plus } from "lucide-react";
import { Favicon } from "@/components/favicon";
import {
  businessHostname,
  businessLabel,
  type NamedSite,
} from "@/lib/domain/business-display";
import { cn } from "@/lib/utils";

export interface SwitcherBusiness extends NamedSite {
  id: string;
}

const ADD_SITE_HREF = "/settings/business?new=1";

/**
 * Favicon when we have a host, globe when we do not. Never a guessed domain:
 * the icon is decoration next to a name the reader can already see.
 */
export function SiteMark({
  site,
  size = 16,
}: {
  site: NamedSite;
  size?: number;
}) {
  const hostname = businessHostname(site.website_url);
  if (hostname) {
    return <Favicon domain={hostname} size={size} className="shrink-0" />;
  }
  return (
    <Globe
      aria-hidden="true"
      className="shrink-0 text-muted-foreground"
      style={{ width: size, height: size }}
    />
  );
}

/**
 * The menu of the site switcher: every owned site, then "Add a site".
 *
 * Rendered even while closed (hidden) so the action lives inside the control
 * rather than as a sibling link under it, and so the structure is testable
 * without opening a portal.
 */
export function BusinessSwitcherMenu({
  businesses,
  selectedId,
  onSelect,
}: {
  businesses: SwitcherBusiness[];
  selectedId: string | null;
  onSelect: (businessId: string) => void;
}) {
  return (
    <>
      {businesses.map((business) => {
        const selected = business.id === selectedId;
        return (
          <button
            key={business.id}
            type="button"
            role="menuitem"
            aria-current={selected ? "true" : undefined}
            onClick={() => onSelect(business.id)}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-medium",
              // 44px on a phone, where this menu opens from the top row.
              "min-h-[44px] md:min-h-0",
              "text-foreground hover:bg-accent hover:text-accent-foreground",
              "focus-visible:outline-none focus-visible:bg-accent",
            )}
          >
            <SiteMark site={business} />
            <span className="min-w-0 flex-1 truncate">{businessLabel(business)}</span>
            {selected ? (
              <Check className="h-3.5 w-3.5 shrink-0 text-foreground" aria-hidden="true" />
            ) : (
              <span className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            )}
          </button>
        );
      })}
      <div role="separator" className="my-1 h-px bg-border" />
      <a
        href={ADD_SITE_HREF}
        role="menuitem"
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs font-medium",
          "min-h-[44px] md:min-h-0",
          "text-muted-foreground hover:bg-accent hover:text-foreground",
          "focus-visible:outline-none focus-visible:bg-accent",
        )}
      >
        <Plus className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        Add a site
      </a>
    </>
  );
}

/**
 * Where the switcher sits. `sidebar`: a bordered control under the brand on
 * a desktop. `bar`: the phone's top row, the site's name and a chevron as in
 * a title, its menu under it. Both can be in the page at once (one hidden by
 * CSS), so each has its own ids.
 */
export type SwitcherVariant = "sidebar" | "bar";

const SWITCHER_ID: Record<SwitcherVariant, string> = {
  sidebar: "business-switcher",
  bar: "business-switcher-bar",
};

export function BusinessSwitcherControl({
  businesses,
  selectedId,
  switching,
  onSelect,
  variant = "sidebar",
}: {
  businesses: SwitcherBusiness[];
  selectedId: string | null;
  switching: boolean;
  onSelect: (businessId: string) => void;
  variant?: SwitcherVariant;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected =
    businesses.find((business) => business.id === selectedId) ?? businesses[0];

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!selected) return null;

  function choose(businessId: string) {
    setOpen(false);
    onSelect(businessId);
  }

  const id = SWITCHER_ID[variant];
  const bar = variant === "bar";

  return (
    <div ref={rootRef} className={cn("relative", bar ? "min-w-0" : "px-2 pt-2")}>
      <button
        type="button"
        id={id}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={`${id}-menu`}
        disabled={switching}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "flex items-center rounded-md",
          bar
            ? "min-h-[44px] max-w-full gap-1.5 text-sm font-semibold text-foreground hover:text-foreground/80"
            : cn(
                "w-full gap-2 border border-border bg-background px-2 py-1.5",
                "min-h-[44px] md:min-h-0",
                "text-xs font-medium shadow-sm",
                "hover:bg-accent hover:text-accent-foreground",
              ),
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          "disabled:pointer-events-none disabled:opacity-60",
        )}
      >
        <SiteMark site={selected} />
        <span className={cn("min-w-0 truncate text-left", !bar && "flex-1")}>
          {businessLabel(selected)}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "shrink-0 transition-transform",
            bar ? "h-4 w-4" : "h-3.5 w-3.5 text-muted-foreground",
            open && "rotate-180",
          )}
        />
      </button>
      <div
        id={`${id}-menu`}
        role="menu"
        aria-labelledby={id}
        hidden={!open}
        className={cn(
          "absolute z-50 mt-1 overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md",
          bar ? "left-0 top-full w-[min(20rem,calc(100vw-2rem))]" : "left-2 right-2",
        )}
      >
        <BusinessSwitcherMenu
          businesses={businesses}
          selectedId={selected.id}
          onSelect={choose}
        />
      </div>
    </div>
  );
}

/**
 * Which site you are working on.
 *
 * A custom menu, not a native <select>: the native control cannot show a
 * favicon, cannot hold "Add a site" as an action, and does not share the
 * rest of the sidebar's identity. The selection still lives in a cookie
 * server-side (lib/tenancy.ts), so the switch is a round trip and a refresh,
 * not client state that could drift from what the server filters on.
 */
export function BusinessSwitcher({
  businesses: knownBusinesses = [],
  selectedId: knownSelectedId = null,
  variant = "sidebar",
}: {
  /** Provided by the authenticated shell, so the first paint is not empty. */
  businesses?: SwitcherBusiness[];
  selectedId?: string | null;
  variant?: SwitcherVariant;
}) {
  const router = useRouter();
  const [fetched, setFetched] = useState<{
    businesses: SwitcherBusiness[];
    selectedId: string | null;
  } | null>(null);
  const [switching, setSwitching] = useState(false);
  const businesses = fetched?.businesses ?? knownBusinesses;
  const selectedId = fetched?.selectedId ?? knownSelectedId;

  useEffect(() => {
    // The shell already rendered the list. Fetching here would only matter
    // for a switcher mounted with nothing, and replacing a known list with a
    // slower response is what made the control vanish between sections.
    if (knownBusinesses.length > 0) return;
    let cancelled = false;
    fetch("/api/business/list")
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        const next = Array.isArray(data.businesses) ? data.businesses : [];
        if (next.length === 0) return;
        setFetched({ businesses: next, selectedId: data.selectedId ?? null });
      })
      .catch(() => {
        /* The sidebar still works without the switcher. */
      });
    return () => {
      cancelled = true;
    };
  }, [knownBusinesses.length]);

  async function select(businessId: string) {
    if (businessId === selectedId) return;
    setSwitching(true);
    try {
      const response = await fetch("/api/business/select", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ businessId }),
      });
      if (!response.ok) throw new Error("switch failed");
      setFetched({ businesses, selectedId: businessId });
      // Everything on screen belongs to the old site: reload rather than
      // patch, so nothing is left showing the previous business's numbers.
      router.refresh();
      window.location.reload();
    } catch {
      setSwitching(false);
    }
  }

  if (businesses.length === 0) return null;

  return (
    <BusinessSwitcherControl
      businesses={businesses}
      selectedId={selectedId}
      switching={switching}
      onSelect={select}
      variant={variant}
    />
  );
}
