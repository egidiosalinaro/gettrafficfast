/**
 * What a discovery run is doing, in the few words the Replies page shows
 * beside "Run discovery" while it runs (2026-11-12): read from the job's own
 * checkpoints, never guessed. The step the worker is on (`current_step`) says
 * whether it is still searching; the qualify step writes how many of the
 * targets it took it has judged (`result.progress`, placement-discovery.ts).
 */

export interface DiscoveryJobView {
  status: string | null;
  currentStep: string | null;
  result: unknown;
}

export interface QualifyProgress {
  judged: number;
  total: number;
}

/** `result.progress` of a running job, when it is the qualify step's and readable. */
export function qualifyProgressOf(result: unknown): QualifyProgress | null {
  if (!result || typeof result !== "object") return null;
  const progress = (result as { progress?: unknown }).progress;
  if (!progress || typeof progress !== "object") return null;
  const { judged, total } = progress as { judged?: unknown; total?: unknown };
  if (typeof judged !== "number" || typeof total !== "number" || !Number.isFinite(judged) || !Number.isFinite(total) || total <= 0) {
    return null;
  }
  return { judged: Math.max(0, Math.min(judged, total)), total };
}

const SEARCH_STEPS = new Set(["queries", "recanonicalize", "dates", "rules"]);

/**
 * "Starting…", "Searching…", "Judging 23 of 60…", "Judging…"; null when the
 * job is not queued or running.
 */
export function discoveryProgressText(job: DiscoveryJobView | null): string | null {
  if (!job || (job.status !== "pending" && job.status !== "running")) return null;
  const step = job.currentStep;
  if (!step) return "Starting…";
  if (step === "qualify") {
    const progress = qualifyProgressOf(job.result);
    return progress ? `Judging ${progress.judged} of ${progress.total}…` : "Judging…";
  }
  if (SEARCH_STEPS.has(step) || step.startsWith("discover:")) return "Searching…";
  return "Discovering…";
}

/** What the heading and the menu read off the inbox's discovery state (read.ts `DiscoveryState`). */
export interface SearchesView {
  running: boolean;
  progress?: string | null;
  lastCompletedAt?: string | null;
  nextAt?: string | null;
  x?: { running: boolean; progress: string | null; lastCompletedAt: string | null; nextAt: string | null } | null;
}

/** The discovery state without the X search, when the platform has no X API: the site's switch alone does not run it. */
export function withXSearchOff<T extends { x?: unknown }>(discovery: T, xApiEnabled: boolean): T {
  return xApiEnabled ? discovery : { ...discovery, x: null };
}

/** "just now", "40m ago", "3h ago", "2d ago". Null when the instant cannot be read. */
export function agoLabel(iso: string | null | undefined, now: number): string | null {
  const at = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(at)) return null;
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}

/**
 * The note beside "Found for you · 49": what a run is doing while it runs,
 * else when each search last completed. "last search 2h ago" with the web
 * search alone; "web 2h ago · X 5h ago" when the site also has the daily X
 * search, because the two find different things; "no search yet" when
 * neither has completed. Null with no state at all (an older payload).
 */
export function lastSearchText(state: SearchesView | null | undefined, now: number): string | null {
  if (!state) return null;
  if (state.running) return state.progress ?? "Discovering…";
  if (state.x?.running) return state.x.progress ?? "Searching X…";
  const web = agoLabel(state.lastCompletedAt, now);
  if (!state.x) return web ? `last search ${web}` : "no search yet";
  const x = agoLabel(state.x.lastCompletedAt, now);
  if (!web && !x) return "no search yet";
  return [web ? `web ${web}` : "web not yet", x ? `X ${x}` : "X not yet"].join(" · ");
}

const WEEKDAY_TIME: Intl.DateTimeFormatOptions = { weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" };

function weekdayTime(iso: string | null | undefined, timeZone: string | null): string | null {
  const at = iso ? new Date(iso) : null;
  if (!at || !Number.isFinite(at.getTime())) return null;
  try {
    return at.toLocaleString("en-US", { ...WEEKDAY_TIME, ...(timeZone ? { timeZone } : {}) }).replace(",", "");
  } catch {
    // An unknown zone: UTC, said so.
    return `${at.toLocaleString("en-US", { ...WEEKDAY_TIME, timeZone: "UTC" }).replace(",", "")} UTC`;
  }
}

/**
 * The next scheduled searches, in the person's time zone, for the ⋯ menu:
 * "Next search Mon 11:00", or "Next search: web Mon 11:00 · X Fri 14:20"
 * when the site also has the daily X search. Null when nothing is scheduled.
 */
export function nextSearchLabel(state: SearchesView | null | undefined, timeZone: string | null): string | null {
  if (!state) return null;
  const web = weekdayTime(state.nextAt, timeZone);
  const x = state.x ? weekdayTime(state.x.nextAt, timeZone) : null;
  if (web && x) return `Next search: web ${web} · X ${x}`;
  if (web) return `Next search ${web}`;
  if (x) return `Next X search ${x}`;
  return null;
}
