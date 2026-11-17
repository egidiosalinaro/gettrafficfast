"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CheckCircle2, Loader2, LineChart } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SearchConsolePropertyList } from "@/components/integrations/search-console-property";
import { searchConsoleCaption } from "@/lib/lifecycle/results";

/**
 * Connect a Search Console property.
 *
 * This is the only place in the product that reads ground truth rather than a
 * sample, so the page says plainly what it will and will not do: read-only
 * access, no writes to the customer's property. The first pull starts as soon
 * as a property is chosen; the daily sweep only refreshes the overlapping tail.
 */

interface Site {
  siteUrl: string;
  permissionLevel: string;
}

const ERRORS: Record<string, string> = {
  not_configured:
    "Search Console is not configured on this deployment yet. Ask the administrator to set the Google OAuth credentials.",
  denied: "You declined the Google consent screen, so nothing was connected.",
  state_mismatch:
    "The sign-in round trip could not be verified. Start again from this page.",
  missing_code: "Google did not return an authorization code. Please try again.",
  no_refresh_token:
    "Google did not return a long-lived token, which would make the connection stop working after an hour. Try again and accept the consent screen.",
  exchange_failed: "Google refused the connection.",
  site_not_found:
    "That link names a site this account does not have, so nothing was connected. Pick the site in the sidebar and connect from this page.",
};

export default function SearchConsolePage() {
  const params = useSearchParams();
  const [sites, setSites] = useState<Site[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [websiteUrl, setWebsiteUrl] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [lastSyncedOn, setLastSyncedOn] = useState<string | null>(null);
  const [pulledAt, setPulledAt] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [firstKickDone, setFirstKickDone] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const kicked = useRef(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/integrations/search-console/sites");
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not read the connection");
      setConnected(Boolean(data.connected));
      setSites(data.sites ?? []);
      setSelected(data.selected ?? null);
      setWebsiteUrl(typeof data.websiteUrl === "string" ? data.websiteUrl : null);
      setLastSyncedOn(typeof data.lastSyncedOn === "string" ? data.lastSyncedOn : null);
      setPulledAt(typeof data.pulledAt === "string" ? data.pulledAt : null);
      setStale(data.stale === true);
      setSyncing(Boolean(data.syncing));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read the connection");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    const code = params.get("error");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- existing load-on-mount effect, flagged by eslint-plugin-react-hooks 7.1; behaviour unchanged
    if (code) setError(ERRORS[code] ?? "Something went wrong connecting Search Console.");
    load();
  }, [params, load]);

  useEffect(() => {
    if (!connected || !selected || kicked.current) return;
    if (lastSyncedOn && !stale) return;
    kicked.current = true;
    fetch("/api/integrations/search-console/sync", { method: "POST" })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (typeof data.lastSyncedOn === "string") setLastSyncedOn(data.lastSyncedOn);
        setSyncing(Boolean(data.syncing));
        setStale(false);
      })
      .catch(() => undefined)
      .finally(() => setFirstKickDone(true));
  }, [connected, selected, lastSyncedOn, stale]);

  const showSyncing =
    syncing || Boolean(selected && !lastSyncedOn && !firstKickDone);

  useEffect(() => {
    if (!showSyncing) return;
    const timer = setInterval(() => {
      load().catch(() => undefined);
    }, 5_000);
    return () => clearInterval(timer);
  }, [showSyncing, load]);

  const chooseSite = async (siteUrl: string) => {
    setIsSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/integrations/search-console/select-site", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteUrl }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error("Could not save the property");
      setSelected(siteUrl);
      setLastSyncedOn(typeof data.lastSyncedOn === "string" ? data.lastSyncedOn : null);
      setSyncing(Boolean(data.syncing));
      setFirstKickDone(true);
      kicked.current = true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the property");
    } finally {
      setIsSaving(false);
    }
  };

  const disconnect = async () => {
    setIsSaving(true);
    try {
      await fetch("/api/integrations/search-console/disconnect", { method: "POST" });
      setConnected(false);
      setSites([]);
      setSelected(null);
      setWebsiteUrl(null);
      setLastSyncedOn(null);
      setPulledAt(null);
      setStale(false);
      setSyncing(false);
      setFirstKickDone(false);
      kicked.current = false;
    } finally {
      setIsSaving(false);
    }
  };

  const freshness = searchConsoleCaption({
    siteLabel: null,
    through: lastSyncedOn,
    pulledAt,
    syncing: false,
  });
  const syncCaption = !selected
    ? null
    : showSyncing
      ? "Pulling the first ~90 days of history now."
      : freshness
        ? `${freshness.charAt(0).toUpperCase()}${freshness.slice(1)}. Google settles the newest days over about three days, so the latest days always arrive a little late.`
        : "The first pull starts as soon as a published article has a live URL.";

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <LineChart className="h-5 w-5" /> Google Search Console
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Connect your property to see the impressions and clicks your articles
          actually get. Everything else on the Results page is measured by
          sampling; this is counted by Google itself.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Checking the connection...
        </div>
      ) : !connected ? (
        <div className="space-y-3">
          <ul className="space-y-1 text-sm text-muted-foreground">
            <li>Read-only access: nothing is ever written to your property.</li>
            <li>You choose which property to read, if you own more than one.</li>
            <li>
              The first pull starts as soon as you pick a property, covering
              about three months of history that Google still holds.
            </li>
          </ul>
          <Button asChild>
            <a href="/api/integrations/search-console/connect">Connect Search Console</a>
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400">
            {showSyncing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <CheckCircle2 className="h-4 w-4" />
            )}
            {showSyncing ? "Connected · syncing…" : "Connected"}
          </div>

          <div className="space-y-2">
            <div className="text-sm font-medium">Property</div>
            {sites.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                This Google account has no Search Console properties.
              </p>
            ) : (
              <SearchConsolePropertyList
                sites={sites}
                selected={selected}
                websiteUrl={websiteUrl}
                disabled={isSaving}
                onSelect={chooseSite}
              />
            )}
            {syncCaption && (
              <p className="text-xs text-muted-foreground">
                {syncCaption} Changing the property starts its history from
                scratch.
              </p>
            )}
          </div>

          <Button variant="outline" onClick={disconnect} disabled={isSaving}>
            Disconnect
          </Button>
        </div>
      )}
    </div>
  );
}
