import type { SupabaseClient } from "@supabase/supabase-js";
import { canonicalTarget } from "@/lib/providers/discovery/canonical";
import { X_QUERY_MAX_CHARS, isXApiEnabled, searchWorstCaseUsd, type XApiClient } from "@/lib/providers/x/api";
import { storeTargets } from "./discovery";
import { saveTargetMedia } from "./media";
import { referencedFromXApi, saveTargetReferenced } from "./referenced";
import { meteredXCall, type MeteredRefusal } from "./x-budget";
import { existingStatusIds, filterXPosts, ownXHandle, xPostAsTarget, xPostMediaState, xQueryFilters, type XSkips } from "./x-search";

/**
 * The close-accounts trial (docs/PLACEMENTS.md, "Close accounts trial",
 * the owner's decision of 2026-11-14).
 *
 * Before building "Connect X" (OAuth, read-only) for every customer, two
 * days on the owner's site measure what the cheap design returns and costs:
 * watch the ~25 accounts the site replies to most, with one recent search a
 * run, `(from:a OR from:b …) -is:retweet -is:reply lang:<site language>`,
 * filtered on X's side so X returns, and bills, only fresh original posts.
 * The accounts come from the site's own posted X replies (no OAuth): the
 * authors of the threads it answered in the last 30 days.
 *
 * What the search returns goes through the daily X search's pipeline
 * (rules, the X pre-filter, the qualifier, drafting) with `found_via` =
 * `x_close`, so it shows in Today like every found post. Each run records
 * its numbers (the `measure` step of the `x-close-trial` job). Off unless
 * the platform lists the site in `X_CLOSE_TRIAL_BUSINESS_IDS`; ends by
 * itself on `X_CLOSE_TRIAL_UNTIL`.
 */

/** `found_via` of a row the close-accounts trial found. */
export const X_CLOSE_SOURCE = "x_close";

/** Posted replies this recent name the close accounts. */
export const X_CLOSE_LOOKBACK_DAYS = 30;
/** Accounts watched at most: what about two 512-character searches hold. */
export const X_CLOSE_MAX_HANDLES = 25;
/** Fewer than this and the trial says so in its log; it still runs with what it has. */
export const X_CLOSE_MIN_HANDLES = 5;
/** Searches a run, at most. */
export const X_CLOSE_MAX_QUERIES = 2;
/**
 * `max_results` per search. 25 original posts in three hours from 25
 * accounts is well above what they post; a search that returns exactly 25
 * is recorded as possibly truncated, so the measurement says when the
 * ceiling, not the accounts, set the number.
 */
export const X_CLOSE_RESULTS_PER_QUERY = 25;
/** The window a run searches: since the last run, never more than this. */
export const X_CLOSE_WINDOW_HOURS = 3;
/** Reserved before each search: 25 posts and, at worst, two referenced each ($0.375). */
export const X_CLOSE_CALL_WORST_USD = searchWorstCaseUsd(X_CLOSE_RESULTS_PER_QUERY, { references: true });

// ── The gate ────────────────────────────────────────────────────────────────

type Env = Record<string, string | undefined>;

/** The site ids in `X_CLOSE_TRIAL_BUSINESS_IDS` (comma or space separated). */
export function closeTrialBusinessIds(env: Env = process.env): string[] {
  return (env.X_CLOSE_TRIAL_BUSINESS_IDS ?? "")
    .split(/[\s,]+/)
    .map((id) => id.trim().toLowerCase())
    .filter((id) => /^[0-9a-f-]{36}$/.test(id));
}

/**
 * Whether the trial may run for this site now, and if not, why. Needs the
 * site in the list, the platform's X API, and the date before
 * `X_CLOSE_TRIAL_UNTIL` (an ISO date: the trial stops at its first instant,
 * UTC) when that is set. An end date that does not parse stops the trial:
 * a cost must never switch itself on by a typo.
 */
export function closeTrialGate(businessId: string, now: Date, env: Env = process.env): { ok: true } | { ok: false; reason: string } {
  if (!closeTrialBusinessIds(env).includes(businessId.toLowerCase())) return { ok: false, reason: "site not in X_CLOSE_TRIAL_BUSINESS_IDS" };
  if (!isXApiEnabled(env)) return { ok: false, reason: "the X API is not turned on for this deployment" };
  const until = env.X_CLOSE_TRIAL_UNTIL?.trim();
  if (until) {
    const end = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(until) ? `${until}T00:00:00Z` : until);
    if (!Number.isFinite(end)) return { ok: false, reason: `X_CLOSE_TRIAL_UNTIL is not a date: ${until.slice(0, 40)}` };
    if (now.getTime() >= end) return { ok: false, reason: `the trial ended on ${until.slice(0, 40)}` };
  }
  return { ok: true };
}

// ── The accounts ────────────────────────────────────────────────────────────

export interface PostedReplyRow {
  /** The thread answered. */
  url: string | null;
  author: string | null;
  /** The site's own reply. */
  published_url: string | null;
  published_at: string | null;
}

export interface CloseAccount {
  handle: string;
  replies: number;
  lastRepliedAt: string | null;
}

const HANDLE = /^\w{1,15}$/;

/** The thread's author: from its URL first (`x.com/<handle>/status/…`), else the stored author. Lowercase. */
function threadAuthor(row: PostedReplyRow): string | null {
  const target = row.url ? canonicalTarget(row.url) : null;
  const fromUrl = target && target.surface === "x" && target.author && target.author !== "i" ? target.author : null;
  const handle = (fromUrl ?? row.author ?? "").replace(/^@/, "").trim().toLowerCase();
  return HANDLE.test(handle) && handle !== "i" ? handle : null;
}

/**
 * The accounts the site is close to: the authors of the threads it replied
 * to on X in the last 30 days, ranked by how many replies, then by the most
 * recent, at most 25, never its own account. Pure.
 */
export function closeAccountsFrom(
  rows: PostedReplyRow[],
  params: { now: Date; ownHandle?: string | null; lookbackDays?: number; max?: number }
): CloseAccount[] {
  const since = params.now.getTime() - (params.lookbackDays ?? X_CLOSE_LOOKBACK_DAYS) * 86_400_000;
  const own = (params.ownHandle ?? ownXHandle(rows.map((r) => r.published_url)))?.toLowerCase() ?? null;
  const byHandle = new Map<string, CloseAccount>();
  for (const row of rows) {
    const at = row.published_at ? Date.parse(row.published_at) : NaN;
    if (!Number.isFinite(at) || at < since || at > params.now.getTime()) continue;
    const handle = threadAuthor(row);
    if (!handle || handle === own) continue;
    const known = byHandle.get(handle);
    const iso = new Date(at).toISOString();
    if (!known) byHandle.set(handle, { handle, replies: 1, lastRepliedAt: iso });
    else {
      known.replies += 1;
      if (!known.lastRepliedAt || iso > known.lastRepliedAt) known.lastRepliedAt = iso;
    }
  }
  return [...byHandle.values()]
    .sort((a, b) => b.replies - a.replies || (b.lastRepliedAt ?? "").localeCompare(a.lastRepliedAt ?? "") || a.handle.localeCompare(b.handle))
    .slice(0, params.max ?? X_CLOSE_MAX_HANDLES);
}

/** The site's posted X replies of the lookback window, and its own handle, read from them. */
export async function loadCloseAccounts(
  supabase: SupabaseClient,
  businessId: string,
  now: Date
): Promise<{ accounts: CloseAccount[]; ownHandle: string | null }> {
  const since = new Date(now.getTime() - X_CLOSE_LOOKBACK_DAYS * 86_400_000).toISOString();
  const { data, error } = await supabase
    .from("placement_targets")
    .select("url, author, published_url, published_at")
    .eq("business_id", businessId)
    .eq("surface", "x")
    .eq("status", "published_manually")
    .gte("published_at", since)
    .limit(1000);
  if (error) throw new Error(`placement targets: ${error.message}`);
  const rows = (data ?? []) as PostedReplyRow[];
  const ownHandle = ownXHandle(rows.map((r) => r.published_url));
  return { accounts: closeAccountsFrom(rows, { now, ownHandle }), ownHandle };
}

// ── The queries ─────────────────────────────────────────────────────────────

export interface CloseQueries {
  queries: Array<{ query: string; handles: string[] }>;
  /** Handles that did not fit in the searches a run allows (lowest ranked). */
  dropped: string[];
}

/**
 * The run's searches: the handles OR-ed as `from:` in as few queries as
 * X's 512 characters allow, in rank order, each with the filters (`lang:`,
 * `-is:retweet`, `-is:reply`), at most `maxQueries`. Pure.
 */
export function buildCloseQueries(handles: string[], language: string, maxQueries = X_CLOSE_MAX_QUERIES): CloseQueries {
  const valid = handles.filter((h) => HANDLE.test(h));
  if (maxQueries <= 0) return { queries: [], dropped: valid };
  const filters = xQueryFilters(language, null);
  const compose = (group: string[]) => `${group.length === 1 ? `from:${group[0]}` : `(${group.map((h) => `from:${h}`).join(" OR ")})`} ${filters}`;
  const queries: CloseQueries["queries"] = [];
  let group: string[] = [];
  let i = 0;
  for (; i < valid.length; i += 1) {
    const next = [...group, valid[i]];
    if (compose(next).length <= X_QUERY_MAX_CHARS) {
      group = next;
      continue;
    }
    queries.push({ query: compose(group), handles: group });
    group = [valid[i]];
    if (queries.length >= maxQueries) break;
  }
  if (queries.length < maxQueries && group.length > 0) {
    queries.push({ query: compose(group), handles: group });
    i = valid.length;
  }
  return { queries, dropped: valid.slice(i) };
}

/** Where a run's window starts: the last run's search, never more than three hours back. */
export function closeWindowStart(lastSearchedAt: string | null, now: Date): Date {
  const floor = now.getTime() - X_CLOSE_WINDOW_HOURS * 3_600_000;
  const last = lastSearchedAt ? Date.parse(lastSearchedAt) : NaN;
  return new Date(Number.isFinite(last) && last > floor && last < now.getTime() ? last : floor);
}

/** When the newest earlier trial run of this site searched (its `search` step's `searchedAt`). */
export async function lastCloseSearchAt(supabase: SupabaseClient, businessId: string, jobType: string, currentJobId: string): Promise<string | null> {
  const { data: jobs } = await supabase
    .from("jobs")
    .select("id, created_at")
    .eq("business_id", businessId)
    .eq("type", jobType)
    .order("created_at", { ascending: false })
    .limit(5);
  const ids = ((jobs ?? []) as Array<{ id: string }>).map((j) => j.id).filter((id) => id !== currentJobId);
  if (ids.length === 0) return null;
  const { data: steps } = await supabase.from("job_steps").select("job_id, output").in("job_id", ids).eq("step", "search").eq("status", "completed");
  let newest: string | null = null;
  for (const row of (steps ?? []) as Array<{ output: { searchedAt?: unknown } | null }>) {
    const at = row.output?.searchedAt;
    if (typeof at === "string" && (!newest || at > newest)) newest = at;
  }
  return newest;
}

// ── The search ──────────────────────────────────────────────────────────────

export interface CloseSearchOutcome {
  handles: string[];
  /** Replies per watched handle, as ranked. */
  handleReplies: number[];
  fewHandles: boolean;
  droppedHandles: string[];
  queries: string[];
  windowStart: string;
  searchedAt: string;
  calls: number;
  returned: number;
  /** A search returned as many posts as it asked for: more may have matched. */
  truncated: boolean;
  stored: number;
  skipped: XSkips;
  costUsd: number;
  stopped: MeteredRefusal | null;
  notes: string[];
}

/**
 * One trial run's searches for one site, each under the monthly cap
 * through `meteredXCall`. The authors are the accounts the site replies to,
 * so "an author the owner replied to in the last 7 days" is not a skip here
 * (it is in the daily search); a post already stored, the site's own and a
 * crowded one still are.
 */
export async function searchXCloseAccounts(params: {
  supabase: SupabaseClient;
  client: XApiClient | null;
  business: { id: string; user_id: string; content_language: string | null };
  windowStart: Date;
  now?: Date;
  signal?: AbortSignal;
}): Promise<CloseSearchOutcome> {
  const now = params.now ?? new Date();
  const { supabase, business } = params;
  const { accounts, ownHandle } = await loadCloseAccounts(supabase, business.id, now);
  const handles = accounts.map((a) => a.handle);
  const built = buildCloseQueries(handles, business.content_language ?? "en");
  const outcome: CloseSearchOutcome = {
    handles,
    handleReplies: accounts.map((a) => a.replies),
    fewHandles: handles.length < X_CLOSE_MIN_HANDLES,
    droppedHandles: built.dropped,
    queries: built.queries.map((q) => q.query),
    windowStart: params.windowStart.toISOString(),
    searchedAt: now.toISOString(),
    calls: 0,
    returned: 0,
    truncated: false,
    stored: 0,
    skipped: { duplicate: 0, recentAuthor: 0, crowded: 0, own: 0, empty: 0 },
    costUsd: 0,
    stopped: null,
    notes: [],
  };
  if (outcome.fewHandles) outcome.notes.push(`only ${handles.length} close accounts (fewer than ${X_CLOSE_MIN_HANDLES}): running with them`);

  for (const search of built.queries) {
    const called = await meteredXCall({
      supabase,
      client: params.client,
      worstCaseUsd: X_CLOSE_CALL_WORST_USD,
      now,
      run: (client) =>
        client.searchRecent({ query: search.query, maxResults: X_CLOSE_RESULTS_PER_QUERY, startTime: params.windowStart, signal: params.signal }),
    });
    if (!called.ok) {
      outcome.notes.push(`${search.query}: ${called.message}`);
      if (called.reason !== "error") {
        outcome.stopped = called.reason;
        break;
      }
      continue;
    }
    outcome.calls += 1;
    outcome.returned += called.result.billedPosts;
    if (called.result.posts.length >= X_CLOSE_RESULTS_PER_QUERY) outcome.truncated = true;
    outcome.costUsd = Math.round((outcome.costUsd + called.result.costUsd) * 10_000) / 10_000;

    const existing = await existingStatusIds(supabase, business.id, called.result.posts.map((p) => p.id));
    const { keep, skipped } = filterXPosts(called.result.posts, { existingIds: existing, recentAuthors: new Set(), ownHandle });
    for (const key of Object.keys(skipped) as Array<keyof XSkips>) outcome.skipped[key] += skipped[key];
    outcome.stored += await storeTargets({
      supabase,
      userId: business.user_id,
      businessId: business.id,
      targets: keep.map((post) => ({ ...xPostAsTarget(post, "close accounts"), foundVia: X_CLOSE_SOURCE })),
      now,
    });
    for (const post of keep) {
      const where = { businessId: business.id, externalId: `status:${post.id}`, surface: "x" };
      const state = xPostMediaState(post);
      if (state) await saveTargetMedia(supabase, where, state);
      const referenced = referencedFromXApi(post);
      if (referenced) await saveTargetReferenced(supabase, where, referenced);
    }
  }
  return outcome;
}

// ── The measurement ─────────────────────────────────────────────────────────

export interface CloseTrialRecord {
  handlesWatched: number;
  fewHandles: boolean;
  queries: number;
  calls: number;
  windowStart: string | null;
  searchedAt: string | null;
  /** Posts X returned and billed, the referenced ones included. */
  returned: number;
  truncated: boolean;
  stored: number;
  skipped: XSkips | null;
  /** Rules rejections, by rule (the shared rules and the X pre-filter). */
  droppedByRule: Record<string, number>;
  judged: number | null;
  qualified: number | null;
  rejectedByQualifier: number | null;
  drafted: number | null;
  /** The estimate settled in the ledger for this run's searches. */
  costUsd: number;
  stopped: string | null;
  skippedReason: string | null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * One run's numbers from its steps' outputs. A step that did not run (the
 * run was skipped) reads as null, never 0: not measured is not none. Pure.
 */
export function closeTrialRecord(outputs: Record<string, unknown>): CloseTrialRecord {
  const search = (outputs.search ?? {}) as Record<string, unknown>;
  const rules = (outputs.rules ?? {}) as { byRule?: Record<string, number>; skipped?: string };
  const qualify = (outputs.qualify ?? null) as { judged?: number; qualified?: number; rejected?: number } | null;
  const draft = (outputs.draft ?? null) as { started?: number } | null;
  const skippedReason = typeof search.skipped === "string" ? search.skipped : null;
  return {
    handlesWatched: Array.isArray(search.handles) ? search.handles.length : 0,
    fewHandles: search.fewHandles === true,
    queries: Array.isArray(search.queries) ? search.queries.length : 0,
    calls: num(search.calls) ?? 0,
    windowStart: typeof search.windowStart === "string" ? search.windowStart : null,
    searchedAt: typeof search.searchedAt === "string" ? search.searchedAt : null,
    returned: num(search.returned) ?? 0,
    truncated: search.truncated === true,
    stored: num(search.stored) ?? 0,
    skipped: search.skipped && typeof search.skipped === "object" ? (search.skipped as XSkips) : null,
    droppedByRule: rules.byRule ?? {},
    judged: qualify ? num(qualify.judged) : null,
    qualified: qualify ? num(qualify.qualified) : null,
    rejectedByQualifier: qualify ? num(qualify.rejected) : null,
    drafted: draft ? num(draft.started) : null,
    costUsd: num(search.costUsd) ?? 0,
    stopped: typeof search.stopped === "string" ? search.stopped : null,
    skippedReason,
  };
}
