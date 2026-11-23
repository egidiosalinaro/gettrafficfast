"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DefaultSitePicker } from "./default-site-picker";

/**
 * Settings → API keys → Connected apps: the apps a person let in through
 * the OAuth consent screen (claude.ai, the Claude apps, any MCP client that
 * signs in), each with what it may do, on which site, and when it was last
 * used, its default site (the site it acts on when a request names none,
 * which Claude can also change with set_default_site), and a Revoke that
 * ends every token of that connection. The list comes from the server page
 * (lib/oauth/tokens.ts `listConnectedApps`).
 */

type Scope = "read" | "write" | "spend" | "publish";

export interface ConnectedAppRow {
  id: string;
  clientName: string;
  redirectHost: string | null;
  scopes: Scope[];
  businessId: string | null;
  defaultBusinessId: string | null;
  grantedAt: string;
  lastUsedAt: string | null;
}

export interface ConnectedAppSite {
  id: string;
  name: string | null;
  website_url: string | null;
}

/** A timestamp as "2026-11-09 13:31 UTC": the same on the server and in the browser, so hydration agrees. */
function when(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function siteLabel(site: ConnectedAppSite | undefined): string {
  return site?.name || site?.website_url || "a removed site";
}

export function ConnectedApps({
  apps,
  sites,
  loadError,
}: {
  apps: ConnectedAppRow[];
  sites: ConnectedAppSite[];
  /** Set when the list could not be read: the section says so rather than claim there is nothing. */
  loadError?: string | null;
}) {
  const router = useRouter();
  const [revoking, setRevoking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sitesById = new Map(sites.map((s) => [s.id, s]));

  async function handleRevoke(app: ConnectedAppRow) {
    if (!confirm(`Disconnect ${app.clientName}? It stops working on its next call, and has to be connected again.`)) return;
    setRevoking(app.id);
    setError(null);
    try {
      const res = await fetch(`/api/connected-apps/${app.id}`, { method: "DELETE" });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(payload?.error?.message ?? "The app could not be disconnected.");
      }
      router.refresh();
    } catch {
      setError("Network error. Try again.");
    } finally {
      setRevoking(null);
    }
  }

  return (
    <Card className="p-6 space-y-4">
      <div>
        <h2 className="text-xl font-semibold mb-1">Connected apps</h2>
        <p className="text-sm text-muted-foreground">
          Apps you connected by signing in, such as Claude on claude.ai or in the Claude apps. Each acts with the
          permissions you ticked when you connected it, and is held to the same limits as a key.
        </p>
      </div>
      {loadError && <p className="text-sm text-destructive">Your connected apps could not be loaded: {loadError}</p>}
      {!loadError && apps.length === 0 && <p className="text-sm text-muted-foreground">No connected apps.</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}
      <ul className="divide-y">
        {apps.map((app) => (
          <li key={app.id} className="py-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium break-all">{app.clientName}</span>
                {app.redirectHost && <code className="text-xs text-muted-foreground">{app.redirectHost}</code>}
                {app.scopes.map((scope) => (
                  <Badge key={scope} variant={scope === "spend" || scope === "publish" ? "default" : "secondary"}>
                    {scope}
                  </Badge>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                {app.businessId ? `Only ${siteLabel(sitesById.get(app.businessId))}` : "Every site"} · Last used{" "}
                {app.lastUsedAt ? when(app.lastUsedAt) : "never"} · Connected {when(app.grantedAt)}
              </p>
              {!app.businessId && sites.length > 1 && (
                <DefaultSitePicker
                  id={`app-default-${app.id}`}
                  endpoint={`/api/connected-apps/${app.id}`}
                  sites={sites}
                  value={app.defaultBusinessId}
                />
              )}
            </div>
            <Button variant="outline" size="sm" onClick={() => handleRevoke(app)} disabled={revoking === app.id}>
              {revoking === app.id ? "Revoking…" : "Revoke"}
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}
