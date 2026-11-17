import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * A posted reply that is not there any more (migration 20261110220000).
 *
 * On 10 November 2026 the owner posted replies on Reddit from a new account
 * and Reddit removed or hid every one: a new account has to post before it
 * may comment. The rows stayed `published_manually` and kept asking for a
 * link that does not exist. The same happens anywhere: a moderator removes a
 * comment, a post is deleted, an account is limited.
 *
 * What is stored: `placement_targets.removed_at` (when the person said so)
 * and `removed_reason` (optional, at most REMOVED_REASON_MAX characters),
 * beside the status, which stays `published_manually`. The reply was posted,
 * and then it was removed: both are facts, and the second is a negative
 * result the measurement needs, so it is recorded, never deleted, and the
 * row is never moved out of Posted. Only `unmark_removed` clears it, the
 * Undo for a mistaken tap.
 *
 * What changes: a removed reply never asks for its link and is not in the
 * "missing their link" count; it is not a voice example; it is not in the
 * Overview's "posted in the last 7 days"; per surface it counts as posted
 * and removed (`removalBySurface`).
 *
 * The two columns are read apart from `TARGET_COLUMNS` (`loadRemovals`),
 * the way `ai_citation` is: a select that names a column the database does
 * not have yet fails whole, and until the migration is known to be in
 * production a failed read costs the badge and nothing else.
 */

export const REMOVED_REASON_MAX = 300;

/** The reasons the card offers in one tap; anything else is typed. */
export const REMOVED_REASON_PRESETS = [
  "Removed by a moderator or the site",
  "Hidden because my account is new",
  "I deleted it",
] as const;

export interface Removal {
  removedAt: string;
  removedReason: string | null;
}

/** Whether a posted reply was marked as removed. Absent (not read) is not removed. */
export function isRemoved(row: { removedAt?: string | null }): boolean {
  return typeof row.removedAt === "string" && row.removedAt.length > 0;
}

type Row = Record<string, unknown>;

/**
 * The removed replies of a site, by target id; null when the columns cannot
 * be read. `ids` narrows the read to those rows. Bounded: a site has far
 * fewer posted replies than this.
 */
export async function loadRemovals(
  supabase: SupabaseClient,
  businessId: string,
  ids?: readonly string[]
): Promise<Map<string, Removal> | null> {
  if (ids && ids.length === 0) return new Map();
  let query = supabase
    .from("placement_targets")
    .select("id, removed_at, removed_reason")
    .eq("business_id", businessId)
    .not("removed_at", "is", null);
  query = ids ? query.in("id", [...ids]) : query.limit(1000);
  const { data, error } = await query;
  if (error) return null;
  const out = new Map<string, Removal>();
  for (const row of (data ?? []) as Row[]) {
    if (typeof row.removed_at !== "string" || !row.removed_at) continue;
    out.set(row.id as string, {
      removedAt: row.removed_at,
      removedReason: typeof row.removed_reason === "string" && row.removed_reason ? row.removed_reason : null,
    });
  }
  return out;
}

/**
 * A target row with its removal on it, as the columns `mapTarget` reads,
 * when the removals could be read. Unread, the row is left without the keys:
 * unknown, not "not removed".
 */
export function withRemoval(row: Row, removals: Map<string, Removal> | null): Row {
  if (!removals) return row;
  const removal = removals.get(row.id as string);
  return { ...row, removed_at: removal?.removedAt ?? null, removed_reason: removal?.removedReason ?? null };
}

export interface SurfaceRemoval {
  /** Replies marked as posted on the surface, removed ones included. */
  posted: number;
  /** Of those, the ones marked as removed. */
  removed: number;
  /** removed / posted; null when nothing was posted there, never 0. */
  removalRate: number | null;
}

/**
 * Per surface, how many posted replies were removed. Rates are per surface:
 * Reddit hiding a new account's comments says nothing about X. A surface
 * with no posted reply has no rate (null), not a rate of 0. Rows are the
 * site's targets with `removed_at` merged (`withRemoval`); without it,
 * nothing is known and the caller passes null instead.
 */
export function removalBySurface(rows: readonly Row[]): Record<string, SurfaceRemoval> {
  const out: Record<string, SurfaceRemoval> = {};
  for (const row of rows) {
    const surface = typeof row.surface === "string" ? row.surface : null;
    if (!surface) continue;
    const entry = (out[surface] ??= { posted: 0, removed: 0, removalRate: null });
    if (row.status !== "published_manually") continue;
    entry.posted += 1;
    if (typeof row.removed_at === "string" && row.removed_at) entry.removed += 1;
  }
  for (const entry of Object.values(out)) {
    entry.removalRate = entry.posted > 0 ? entry.removed / entry.posted : null;
  }
  return out;
}

/**
 * The line the Posted list shows when any reply was removed: per surface
 * with a posted reply, "3 of 3", in the given order. Null when none was
 * removed, or when nothing is known: the line is not there rather than
 * saying "0".
 */
export function removalSummary(
  bySurface: Record<string, SurfaceRemoval> | undefined | null,
  label: (surface: string) => string,
  order: readonly string[] = Object.keys(bySurface ?? {})
): string | null {
  if (!bySurface) return null;
  const parts = order
    .filter((surface) => (bySurface[surface]?.posted ?? 0) > 0)
    .map((surface) => ({ surface, ...bySurface[surface] }));
  if (!parts.some((part) => part.removed > 0)) return null;
  return `Posted replies marked as removed: ${parts.map((part) => `${label(part.surface)} ${part.removed} of ${part.posted}`).join(", ")}.`;
}
