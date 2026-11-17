"use client";

import { Check, Globe } from "lucide-react";
import { Favicon } from "@/components/favicon";
import {
  describeSearchConsoleProperty,
  permissionLabel,
  propertyCoversHost,
  sortSearchConsoleSites,
} from "@/lib/analytics/property-display";
import { cn } from "@/lib/utils";

export interface SearchConsoleSiteOption {
  siteUrl: string;
  permissionLevel?: string;
}

/**
 * One row in the Search Console property picker.
 *
 * The raw siteUrl stays on the control (title, and the value we POST). The
 * visible line is the host a person recognises, with a favicon and whether
 * this is a domain property or a URL prefix.
 */
export function SearchConsolePropertyOption({
  site,
  selected,
  websiteUrl,
  disabled,
  onSelect,
}: {
  site: SearchConsoleSiteOption;
  selected: boolean;
  websiteUrl?: string | null;
  disabled?: boolean;
  onSelect: (siteUrl: string) => void;
}) {
  const view = describeSearchConsoleProperty(site.siteUrl);
  const covers = propertyCoversHost(site.siteUrl, websiteUrl);
  const permission = permissionLabel(site.permissionLevel);

  return (
    <button
      type="button"
      role="radio"
      disabled={disabled}
      title={view.siteUrl}
      aria-checked={selected}
      onClick={() => onSelect(site.siteUrl)}
      className={cn(
        "flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        "disabled:pointer-events-none disabled:opacity-60",
        selected
          ? "border-primary bg-primary/5"
          : "border-foreground/10 hover:bg-muted/60"
      )}
    >
      {view.host ? (
        <Favicon domain={view.host} size={20} className="shrink-0" />
      ) : (
        <Globe className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
      )}
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{view.label}</span>
          {covers && (
            <span className="shrink-0 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
              This site
            </span>
          )}
        </span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
          {view.detail}
          {permission ? ` · ${permission}` : ""}
        </span>
      </span>
      {selected ? (
        <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
      ) : (
        <span className="h-4 w-4 shrink-0" aria-hidden="true" />
      )}
    </button>
  );
}

export function SearchConsolePropertyList({
  sites,
  selected,
  websiteUrl,
  disabled,
  onSelect,
}: {
  sites: SearchConsoleSiteOption[];
  selected: string | null;
  websiteUrl?: string | null;
  disabled?: boolean;
  onSelect: (siteUrl: string) => void;
}) {
  const ordered = sortSearchConsoleSites(sites, websiteUrl);
  return (
    <div
      role="radiogroup"
      aria-label="Search Console property"
      className="space-y-1.5"
    >
      {ordered.map((site) => (
        <SearchConsolePropertyOption
          key={site.siteUrl}
          site={site}
          selected={selected === site.siteUrl}
          websiteUrl={websiteUrl}
          disabled={disabled}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}
