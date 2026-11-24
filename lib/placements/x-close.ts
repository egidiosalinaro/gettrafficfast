import type { SupabaseClient } from "@supabase/supabase-js";
import { canonicalTarget } from "@/lib/providers/discovery/canonical";
import { X_QUERY_MAX_CHARS, type XApiClient } from "@/lib/providers/x/api";
import { storeTargets } from "./discovery";
import { saveTargetMedia } from "./media";
import { referencedFromXApi, saveTargetReferenced } from "./referenced";
import { savedXHandle } from "./x-handle";
import {
  X_CLOSE_CALL_WORST_USD,
  X_CLOSE_QUERIES_PER_RUN,
  X_CLOSE_RESULTS_PER_QUERY,
  X_CLOSE_WINDOW_HOURS,
  meteredXCall,
  type MeteredRefusal,
} from "./x-budget";
import { existingStatusIds, filterXPosts, ownXHandle, xPostAsTarget, xPostMediaState, xQueryFilters, type XSkips } from "./x-search";

/**
 * The close accounts (docs/PLACEMENTS.md, "Close accounts"): part of the
 * daily X run for every site since 2026-11-24, after a three-day trial on
 * one site (2026-11-14 to 16) gated by deployment settings that no longer
 * exist.
 *
 * Watch the accounts a site replies to most, at most 25, with at most two
 * recent searches a day, `(from:a OR from:b …) -is:retweet -is:reply
 * lang:<site language>`, filtered on X's side so X returns, and bills, only
 * fresh original posts. The accounts come from the site's own posted X
 * replies (no OAuth): the authors of the threads it answered in the last 30
 * days. A site with none makes no call.
 *
 * What the search returns goes through the daily X search's pipeline
 * (rules, the X pre-filter, the qualifier, drafting) with `found_via` =
 * `x_close`, so it shows in Today like every found post. It is the `close`
 * step of the `x-post-discovery` job (lib/jobs/workflows/x-discovery.ts),
 * so it shares that job's bounds: the X API on for the deployment, a site
 * whose owner pays and is under the AI limit, at most once in 20 hours a
 * site, at most X_MAX_BUSINESSES_PER_RUN sites a run in rotation, and the
 * monthly X cap before every call.
 */

/** `found_via` of a row the close-accounts search found. */
export const X_CLOSE_SOURCE = "x_close";

/** Posted replies this recent name the close accounts. */
export const X_CLOSE_LOOKBACK_DAYS = 30;
/** Accounts watched at most: what about two 512-character searches hold. */
export const X_CLOSE_MAX_HANDLES = 25;
/** Fewer than this and the run notes it; it still runs with what it has. */
export const X_CLOSE_MIN_HANDLES = 5;
/** Searches a run, at most (the bound lives with the X plan, lib/placements/x-budget.ts). */
export const X_CLOSE_MAX_QUERIES = X_CLOSE_QUERIES_PER_RUN;
export { X_CLOSE_CALL_WORST_USD, X_CLOSE_RESULTS_PER_QUERY, X_CLOSE_WINDOW_HOURS };

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
  now: Date,
  /** The handle the person gave for the site; wins over the one the links name. */
  savedHandle: string | null = null
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
  const ownHandle = savedHandle ?? ownXHandle(rows.map((r) => r.published_url));
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

/** Where a run's window starts: the last run's search, never more than X_CLOSE_WINDOW_HOURS (12) back. */
export function closeWindowStart(lastSearchedAt: string | null, now: Date): Date {
  const floor = now.getTime() - X_CLOSE_WINDOW_HOURS * 3_600_000;
  const last = lastSearchedAt ? Date.parse(lastSearchedAt) : NaN;
  return new Date(Number.isFinite(last) && last > floor && last < now.getTime() ? last : floor);
}

/**
 * When the newest earlier run of this site searched its close accounts (the
 * `searchedAt` of the job type's `step`: `close` of `x-post-discovery`).
 */
export async function lastCloseSearchAt(
  supabase: SupabaseClient,
  businessId: string,
  jobType: string,
  currentJobId: string,
  step = "close"
): Promise<string | null> {
  const { data: jobs } = await supabase
    .from("jobs")
    .select("id, created_at")
    .eq("business_id", businessId)
    .eq("type", jobType)
    .order("created_at", { ascending: false })
    .limit(5);
  const ids = ((jobs ?? []) as Array<{ id: string }>).map((j) => j.id).filter((id) => id !== currentJobId);
  if (ids.length === 0) return null;
  const { data: steps } = await supabase.from("job_steps").select("job_id, output").in("job_id", ids).eq("step", step).eq("status", "completed");
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
 * One run's close-accounts searches for one site, each under the monthly cap
 * through `meteredXCall`. The authors are the accounts the site replies to,
 * so "an author the owner replied to in the last 7 days" is not a skip here
 * (it is in the daily search); a post already stored, the site's own and a
 * crowded one still are.
 */
export async function searchXCloseAccounts(params: {
  supabase: SupabaseClient;
  client: XApiClient | null;
  /** `voice_settings` carries the handle the person gave for the site, when they did. */
  business: { id: string; user_id: string; content_language: string | null; voice_settings?: unknown };
  windowStart: Date;
  now?: Date;
  signal?: AbortSignal;
}): Promise<CloseSearchOutcome> {
  const now = params.now ?? new Date();
  const { supabase, business } = params;
  const { accounts, ownHandle } = await loadCloseAccounts(supabase, business.id, now, savedXHandle(business.voice_settings));
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
