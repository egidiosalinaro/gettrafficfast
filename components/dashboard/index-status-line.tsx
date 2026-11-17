"use client";

import { useCallback, useEffect, useState } from "react";
import { ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { indexStatusLine, type IndexStatusView } from "@/lib/analytics/index-status-display";

/**
 * One quiet line under a published article: whether Google has it in its
 * index, in Google's words, and when that was checked ("On Google · checked
 * Nov 12"). Shown only when Search Console is connected; a URL nobody has
 * inspected reads "Not checked on Google yet", never "not on Google".
 * "Check now" asks Google again for this one URL (POST
 * /api/index-status/inspect, the `inspect_url` tool's function).
 */

const TONE = {
  ok: "text-green-700 dark:text-green-300",
  warn: "text-amber-700 dark:text-amber-300",
  muted: "text-muted-foreground",
} as const;

export function IndexStatusLineView({
  row,
  checking,
  error,
  onCheck,
  now,
}: {
  row: IndexStatusView | null;
  checking: boolean;
  error: string | null;
  onCheck?: () => void;
  now?: Date;
}) {
  const line = indexStatusLine(row, now);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      <span className={TONE[line.tone]} data-testid="index-status-line">
        {line.text}
      </span>
      {line.link && (
        <a
          href={line.link}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-11 md:min-h-0 items-center gap-1 text-muted-foreground hover:text-foreground hover:underline"
        >
          <ExternalLink className="h-3 w-3" />
          Google&apos;s report
        </a>
      )}
      {onCheck && (
        <button
          type="button"
          onClick={onCheck}
          disabled={checking}
          className="inline-flex min-h-11 md:min-h-0 items-center gap-1 text-muted-foreground hover:text-foreground hover:underline disabled:opacity-60"
        >
          {checking ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          {checking ? "Checking..." : "Check now"}
        </button>
      )}
      {error && <span className="text-destructive">{error}</span>}
    </div>
  );
}

export function IndexStatusLine({ articleId }: { articleId: string }) {
  const [state, setState] = useState<{ connected: boolean; row: IndexStatusView | null } | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/index-status?articleId=${encodeURIComponent(articleId)}`)
      .then(async (response) => {
        if (!response.ok) return null;
        return (await response.json()) as { connected: boolean; siteUrl: string | null; rows: IndexStatusView[] };
      })
      .then((payload) => {
        if (cancelled || !payload) return;
        setState({ connected: payload.connected && Boolean(payload.siteUrl), row: payload.rows[0] ?? null });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [articleId]);

  const check = useCallback(async () => {
    setChecking(true);
    setError(null);
    try {
      const response = await fetch("/api/index-status/inspect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ articleId }),
      });
      const payload = (await response.json().catch(() => ({}))) as { row?: IndexStatusView; error?: string };
      if (!response.ok || !payload.row) {
        setError(payload.error ?? "Google could not be asked right now.");
      } else {
        setState({ connected: true, row: payload.row });
      }
    } catch {
      setError("Google could not be asked right now.");
    } finally {
      setChecking(false);
    }
  }, [articleId]);

  if (!state?.connected) return null;
  return <IndexStatusLineView row={state.row} checking={checking} error={error} onCheck={check} />;
}
