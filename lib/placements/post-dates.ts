import type { SupabaseClient } from "@supabase/supabase-js";
import type { Discussion } from "@/lib/providers/discovery/types";
import { postDateKey, type PostDateLookup, type PostDateRequest } from "@/lib/providers/post-dates";
import { DATABLE_SURFACES, dateFromUrl, postDateRequestFor } from "./date-from-url";
import { freshUntil } from "./rules";
import { OPEN_STATUSES } from "./workflow";

/**
 * Every found row gets a date by the cheapest exact method there is
 * (2026-11-13; docs/PLACEMENTS.md, "Dating what a search found").
 *
 *   1. The URL, free and exact: an X or LinkedIn id is a timestamp
 *      (./date-from-url.ts). Applied to every discussion before it is
 *      stored, so it wins over the engine's printed date.
 *   2. The platform's free API: Hacker News, Stack Exchange, DEV, Reddit, a
 *      GitHub issue (lib/providers/post-dates), capped per run.
 *   3. The date the engine printed beside the result, as before
 *      (lib/providers/serp/dates.ts), kept as the bound it is.
 *
 * A date found by 1 or 2 is exact: stored with no precision, and
 * `fresh_until` recomputed from it. Nothing is estimated: what none of them
 * dates stays null, and the inbox stops presenting it as fresh a week after
 * it was found (`undatedTooLong`, ./inbox-view.ts).
 */

/** The discussion with its URL's date when the URL carries one: exact, so it replaces the engine's bound. */
export function withUrlDate<T extends Discussion>(discussion: T, now: Date = new Date()): T {
  const dated = dateFromUrl(discussion.url, now);
  if (!dated) return discussion;
  return { ...discussion, createdAt: dated.at, createdAtPrecision: null };
}

/** Undated rows not yet judged the step dates per run, newest find first: this run's finds. */
export const NEW_ROWS_PER_RUN = 150;

/**
 * Undated open rows (qualified, drafted, needs review, approved) the step
 * backfills per run, oldest find first: the rows most likely to be past
 * their window. No migration and no script: each run takes the next ones.
 */
export const BACKFILL_ROWS_PER_RUN = 150;

interface UndatedRow {
  id: string;
  surface: string;
  kind: string | null;
  url: string;
  created_at: string | null;
}

export interface DatingResult {
  /** Undated rows not yet judged, looked at. */
  newRows: number;
  /** Undated open rows, looked at. */
  backfillRows: number;
  /** Rows given a date, by how. */
  dated: Record<string, number>;
  /** Rows still undated after every method. */
  unknown: number;
  /** HTTP requests per source, and posts the caps left unasked. */
  requests: Record<string, number>;
  skipped: Record<string, number>;
}

async function undated(
  supabase: SupabaseClient,
  businessId: string,
  statuses: readonly string[],
  ascending: boolean,
  limit: number
): Promise<UndatedRow[]> {
  if (limit <= 0) return [];
  const { data } = await supabase
    .from("placement_targets")
    .select("id, surface, kind, url, created_at")
    .eq("business_id", businessId)
    .in("status", [...statuses])
    .in("surface", [...DATABLE_SURFACES])
    .neq("kind", "page")
    .is("posted_at", null)
    .order("created_at", { ascending })
    .limit(limit);
  return (data ?? []) as UndatedRow[];
}

/** X and LinkedIn rows, discovered or open, whose date is only the engine's estimate. */
async function roughlyDated(supabase: SupabaseClient, businessId: string, limit: number): Promise<UndatedRow[]> {
  if (limit <= 0) return [];
  const { data } = await supabase
    .from("placement_targets")
    .select("id, surface, kind, url, created_at, posted_at_precision")
    .eq("business_id", businessId)
    .in("status", ["discovered", ...OPEN_STATUSES])
    .in("surface", ["x", "linkedin"])
    .not("posted_at_precision", "is", null)
    .order("created_at", { ascending: false })
    .limit(limit);
  return ((data ?? []) as Array<UndatedRow & { posted_at_precision: string | null }>).filter((row) => row.posted_at_precision);
}

/**
 * The `dates` step of a discovery run, before the rules: the rows this run
 * (and earlier ones) stored without a date, then a backfill of open rows
 * still without one. URL first, then the APIs in that order, so new finds
 * take each source's cap before the backfill does. Writes `posted_at` (no
 * precision: exact) and `fresh_until`; nothing else of the row changes.
 */
export async function dateUndatedTargets(params: {
  supabase: SupabaseClient;
  businessId: string;
  lookup: PostDateLookup;
  now?: Date;
  newLimit?: number;
  backfillLimit?: number;
}): Promise<DatingResult> {
  const now = params.now ?? new Date();
  const fresh = await undated(params.supabase, params.businessId, ["discovered"], false, params.newLimit ?? NEW_ROWS_PER_RUN);
  const backfill = await undated(
    params.supabase,
    params.businessId,
    OPEN_STATUSES,
    true,
    params.backfillLimit ?? BACKFILL_ROWS_PER_RUN
  );
  const rows = [...fresh, ...backfill];

  const found = new Map<string, { at: string; method: string }>();
  const asked: Array<{ row: UndatedRow; request: PostDateRequest }> = [];
  for (const row of rows) {
    const byUrl = dateFromUrl(row.url, now);
    if (byUrl) {
      found.set(row.id, byUrl);
      continue;
    }
    const request = postDateRequestFor(row.url);
    if (request) asked.push({ row, request });
  }

  if (asked.length > 0) {
    const answers = await params.lookup.dateAll(asked.map((a) => a.request));
    for (const { row, request } of asked) {
      const at = answers.get(postDateKey(request));
      if (at) found.set(row.id, { at, method: `${request.source}_api` });
    }
  }

  const dated: Record<string, number> = {};

  // X and LinkedIn rows stored earlier with only the search engine's rough
  // date ("3 weeks ago", a precision set): their URL holds the exact time,
  // free, so it replaces the estimate. No API is asked for these.
  const rough = await roughlyDated(params.supabase, params.businessId, params.backfillLimit ?? BACKFILL_ROWS_PER_RUN);
  for (const row of rough) {
    const byUrl = dateFromUrl(row.url, now);
    if (!byUrl) continue;
    const { error } = await params.supabase
      .from("placement_targets")
      .update({
        posted_at: byUrl.at,
        posted_at_precision: null,
        fresh_until: freshUntil(row.kind || "thread", byUrl.at),
        updated_at: now.toISOString(),
      })
      .eq("id", row.id)
      .not("posted_at_precision", "is", null);
    if (error) throw new Error(`placement target re-dating failed: ${error.message}`);
    dated[`${byUrl.method}_redated`] = (dated[`${byUrl.method}_redated`] ?? 0) + 1;
  }

  for (const row of rows) {
    const hit = found.get(row.id);
    if (!hit) continue;
    const { error } = await params.supabase
      .from("placement_targets")
      .update({
        posted_at: hit.at,
        posted_at_precision: null,
        fresh_until: freshUntil(row.kind || "thread", hit.at),
        updated_at: now.toISOString(),
      })
      .eq("id", row.id)
      .is("posted_at", null);
    if (error) throw new Error(`placement target dating failed: ${error.message}`);
    dated[hit.method] = (dated[hit.method] ?? 0) + 1;
  }

  const nonzero = (counts: Record<string, number>) => Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0));
  return {
    newRows: fresh.length,
    backfillRows: backfill.length,
    dated,
    unknown: rows.length - found.size,
    requests: nonzero(params.lookup.stats.requests),
    skipped: nonzero(params.lookup.stats.skipped),
  };
}
