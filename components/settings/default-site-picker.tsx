"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * The default site of one key or one connected app (Settings → Claude and
 * API): the site its calls act on when they name none. "Oldest site" saves
 * no default (null), so a site added later never changes it silently. The
 * same change Claude makes with the set_default_site tool: PATCH
 * /api/api-keys/:id or /api/connected-apps/:id, both through
 * lib/tools/site.ts `saveDefaultSite`. Shown only for a credential for
 * every site of an account that has more than one.
 */

export interface DefaultSiteOption {
  id: string;
  name: string | null;
  website_url: string | null;
}

function label(site: DefaultSiteOption | undefined): string {
  return site?.name || site?.website_url || "a removed site";
}

export function DefaultSitePicker({
  endpoint,
  sites,
  value,
  id,
}: {
  /** The route that saves it: /api/api-keys/:id or /api/connected-apps/:id. */
  endpoint: string;
  /** The account's sites, oldest first. */
  sites: DefaultSiteOption[];
  /** The saved default; null when none is saved (the oldest site). */
  value: string | null;
  /** For the label's htmlFor. */
  id: string;
}) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = value && sites.some((site) => site.id === value) ? value : "";

  async function handleChange(next: string) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(endpoint, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultSite: next || null }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(payload?.error?.message ?? "The default site could not be saved.");
      }
      router.refresh();
    } catch {
      setError("Network error. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <label htmlFor={id}>Default site</label>
      <select
        id={id}
        className="h-11 rounded-md border border-input bg-transparent px-2 text-sm text-foreground shadow-sm md:h-8 md:text-xs"
        value={current}
        disabled={saving}
        onChange={(e) => handleChange(e.target.value)}
      >
        <option value="">Oldest site ({label(sites[0])})</option>
        {sites.map((site) => (
          <option key={site.id} value={site.id}>
            {label(site)}
          </option>
        ))}
      </select>
      <span>when a request names no site</span>
      {error && <span className="w-full text-destructive">{error}</span>}
    </div>
  );
}
