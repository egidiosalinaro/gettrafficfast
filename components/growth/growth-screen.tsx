"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { GrowthHeader, GrowthView } from "@/components/growth/growth-view";
import type { GrowthDays } from "@/lib/growth/period";
import type { GrowthSummary } from "@/lib/growth/schema";
import type { ResultsView } from "@/lib/lifecycle/load-results";

/**
 * `/growth`: reads GET /api/growth for the period and draws GrowthView.
 *
 * As Results did, opening the page pulls Search Console when its newest
 * settled day is behind (one POST, then a reload), and polls while a first
 * pull runs, so the numbers are Google's latest without a button.
 */

type Payload = { hasBusiness: false } | { hasBusiness: true; growth: GrowthSummary; results: ResultsView };

const POLL_MS = 5_000;

export function GrowthScreen({ days }: { days: GrowthDays }) {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const kicked = useRef(false);

  const load = useCallback(async () => {
    const response = await fetch(`/api/growth?days=${days}`, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? "Could not load Growth");
    setData(payload as Payload);
    setError(null);
  }, [days]);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/growth?days=${days}`, { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error ?? "Could not load Growth");
        if (!cancelled) setData(payload as Payload);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load Growth");
      });
    return () => {
      cancelled = true;
    };
  }, [days]);

  const connection = data?.hasBusiness ? data.growth.google.connection : null;

  // Google settles its last days late: a stale watermark pulls once on open.
  useEffect(() => {
    if (!connection || kicked.current) return;
    if (connection.status === "connected" && connection.siteUrl && connection.stale && !connection.syncing) {
      kicked.current = true;
      fetch("/api/integrations/search-console/sync", { method: "POST" })
        .then(() => load())
        .catch(() => undefined);
    }
  }, [connection, load]);

  const syncing = Boolean(connection?.syncing);
  useEffect(() => {
    if (!syncing) return;
    const timer = setInterval(() => {
      load().catch(() => undefined);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [syncing, load]);

  if (error) {
    return (
      <div className="mx-auto max-w-5xl space-y-5">
        <GrowthHeader days={days} />
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="mx-auto max-w-5xl space-y-5">
        <GrowthHeader days={days} />
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Loading growth...
        </p>
      </div>
    );
  }
  if (!data.hasBusiness) {
    return (
      <div className="mx-auto max-w-5xl space-y-3">
        <GrowthHeader days={days} />
        <p className="text-sm text-muted-foreground">
          Set up your site first.{" "}
          <Link href="/settings/business" className="underline underline-offset-2">
            Settings, Business
          </Link>
        </p>
      </div>
    );
  }
  return <GrowthView growth={data.growth} results={data.results} />;
}
