"use client";

import { useEffect, useState } from "react";

// The generate-articles cron runs daily at 08:00 UTC (see vercel.json).
const CRON_HOUR_UTC = 8;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

// The next 08:00 UTC cron tick from `now`.
function nextCronRun(now: number): Date {
  const d = new Date(now);
  const next = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), CRON_HOUR_UTC, 0, 0, 0)
  );
  if (next.getTime() <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

// A queued article dated D is generated at the first cron run on/after D. If it
// is already due (D <= the next run's date) that's the next run; otherwise it's
// the 08:00 UTC run on D.
function nextGenerationTime(now: number, nextQueuedDate: string | null): number | null {
  if (!nextQueuedDate) return null;
  const nextRun = nextCronRun(now);
  const nextRunDay = nextRun.toISOString().slice(0, 10);
  if (nextQueuedDate <= nextRunDay) return nextRun.getTime();
  const [y, m, d] = nextQueuedDate.split("-").map(Number);
  return Date.UTC(y, m - 1, d, CRON_HOUR_UTC, 0, 0, 0);
}

function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const clock = `${pad(h)}:${pad(m)}:${pad(s)}`;
  return days > 0 ? `${days}d ${clock}` : clock;
}

export function GenerationStatus({
  generatingCount,
  nextQueuedDate,
}: {
  generatingCount: number;
  nextQueuedDate: string | null;
}) {
  const [now, setNow] = useState<number | null>(null);

  // The clock starts in the browser: rendering a server timestamp would
  // guarantee a hydration mismatch, so `now` stays null until mount.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- client-only clock
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const generating = generatingCount > 0;
  const genTime = now === null ? null : nextGenerationTime(now, nextQueuedDate);

  return (
    <div className="flex items-center gap-2 rounded-full border border-border bg-background px-3 py-1.5 text-sm shadow-sm">
      <span className="relative flex h-2.5 w-2.5">
        <span
          className={
            "absolute inline-flex h-full w-full rounded-full opacity-75 animate-ping " +
            (generating ? "bg-amber-500" : "bg-green-500")
          }
        />
        <span
          className={
            "relative inline-flex h-2.5 w-2.5 rounded-full " +
            (generating ? "bg-amber-500" : "bg-green-500")
          }
        />
      </span>
      {generating ? (
        <span className="font-medium">{generatingCount} generating</span>
      ) : !nextQueuedDate ? (
        <span className="text-muted-foreground">No articles queued</span>
      ) : (
        <span className="text-muted-foreground">
          Next generation in{" "}
          <span className="font-medium text-foreground tabular-nums">
            {now === null || genTime === null
              ? "--:--:--"
              : formatCountdown(genTime - now)}
          </span>
        </span>
      )}
    </div>
  );
}
