import type { SupabaseClient } from "@supabase/supabase-js";
import type { XAccount, XApiClient } from "@/lib/providers/x/api";
import { isMissingRelation } from "@/lib/supabase/errors";
import { X_ACCOUNT_METRICS_TABLE } from "./reply-stats-read";
import { X_ACCOUNT_CALL_WORST_USD, X_ACCOUNT_MAX_SITES_PER_RUN, meteredXCall, type MeteredRefusal } from "./x-budget";
import { ownXHandle } from "./x-handle";

/**
 * The public numbers of each site's own X account (followers, following,
 * posts, listed), read once a day inside the daily X run
 * (lib/placements/x-daily.ts) and stored as a dated snapshot per site in
 * `x_account_metrics` (migration 20261113110000).
 *
 * Which account: the one the site's saved reply links name (`ownXHandle`).
 * A site with no linked X reply has none and is skipped: nothing is asked
 * of the person and nothing is guessed.
 *
 * What it costs: one user lookup (`GET /2/users/by/username/:username`) per
 * site and day, $0.01 at worst (X_USER_LOOKUP_USD_PER_USER), through
 * `meteredXCall` (the ledger, the monthly cap, the billing pause). At most
 * X_ACCOUNT_MAX_SITES_PER_RUN lookups a run, the sites read longest ago
 * first; a site read today is not read again, so a second run the same day
 * costs nothing, and two sites posting from one account share one lookup.
 *
 * Honest numbers: a number X did not return is null; a handle X answered
 * with no account for (renamed, suspended) gets a row of nulls, because
 * "asked, and nothing came back" is the measurement. A failed call stores
 * nothing: nothing was measured, and the next run asks again. Any refusal
 * stops the run (one timeout, never ten, inside the cron's minute).
 */

export interface AccountRefreshOutcome {
  /** Sites taking part (opted in, owner pays). */
  considered: number;
  /** Of those, read already today: not asked again. */
  alreadyToday: number;
  /** Of those, with no linked reply on X: no account to read. */
  noHandle: number;
  /** Lookups made: one per account. */
  asked: number;
  /** Lookups X answered with no account: stored as a row of nulls. */
  missing: number;
  /** Snapshots written: one per site. */
  stored: number;
  costUsd: number;
  stopped: MeteredRefusal | null;
  note: string | null;
}

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function log(level: "info" | "warn" | "error", fields: Record<string, unknown>) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event: "x_account_metrics", ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

/** Sites not read today, the ones read longest ago (or never) first: the run rotates when it is capped. */
export function pickSitesToRead<S extends { id: string }>(sites: readonly S[], lastRead: ReadonlyMap<string, string>, today: string): S[] {
  return sites
    .filter((site) => lastRead.get(site.id) !== today)
    .map((site, index) => ({ site, index, last: lastRead.get(site.id) ?? "" }))
    .sort((a, b) => a.last.localeCompare(b.last) || a.index - b.index)
    .map((entry) => entry.site);
}

/**
 * Reads today's account numbers for `sites` (the ones that opted in, owners
 * who pay: the caller decides). `admin` is the service role. Never throws:
 * the outcome says what happened.
 */
export async function refreshXAccountMetrics(params: {
  admin: SupabaseClient;
  client: XApiClient | null;
  sites: ReadonlyArray<{ id: string; user_id: string }>;
  now?: Date;
  signal?: AbortSignal;
}): Promise<AccountRefreshOutcome> {
  const now = params.now ?? new Date();
  const day = utcDay(now);
  const outcome: AccountRefreshOutcome = {
    considered: params.sites.length,
    alreadyToday: 0,
    noHandle: 0,
    asked: 0,
    missing: 0,
    stored: 0,
    costUsd: 0,
    stopped: null,
    note: null,
  };
  if (params.sites.length === 0) return outcome;

  // When each site was last read. A table that is not there yet stops the
  // run before anything is paid for: a number that cannot be stored is
  // money spent on nothing.
  const since = utcDay(new Date(now.getTime() - 30 * 86_400_000));
  const { data, error } = await params.admin
    .from(X_ACCOUNT_METRICS_TABLE)
    .select("business_id, day")
    .in("business_id", params.sites.map((s) => s.id))
    .gte("day", since)
    .limit(2000);
  if (error) {
    outcome.note = isMissingRelation(error)
      ? "x_account_metrics is not there yet (migration 20261113110000 not applied): nothing asked."
      : `x_account_metrics could not be read: ${error.message}`;
    log(isMissingRelation(error) ? "warn" : "error", { outcome: "unreadable", error: error.message });
    return outcome;
  }
  const lastRead = new Map<string, string>();
  for (const row of (data ?? []) as Array<{ business_id: string; day: string }>) {
    const at = String(row.day).slice(0, 10);
    if (at > (lastRead.get(row.business_id) ?? "")) lastRead.set(row.business_id, at);
  }
  const toRead = pickSitesToRead(params.sites, lastRead, day);
  outcome.alreadyToday = params.sites.length - toRead.length;

  const fetchedAt = now.toISOString();
  const byHandle = new Map<string, XAccount | null>();
  const snapshots: Record<string, unknown>[] = [];
  let attempts = 0;
  for (const site of toRead) {
    const handle = await ownXHandle(params.admin, site.id);
    if (!handle) {
      outcome.noHandle += 1;
      continue;
    }
    if (!byHandle.has(handle)) {
      if (attempts >= X_ACCOUNT_MAX_SITES_PER_RUN) break;
      attempts += 1;
      const called = await meteredXCall({
        supabase: params.admin,
        client: params.client,
        worstCaseUsd: X_ACCOUNT_CALL_WORST_USD,
        now,
        run: (client) => client.userByUsername(handle, params.signal),
      });
      if (!called.ok) {
        outcome.note = called.message;
        log("warn", { outcome: "refused", business_id: site.id, reason: called.reason, message: called.message });
        // Any refusal stops the run: the cap, a pause, a rate limit and a
        // refused token hold for every account, and a timeout must not be
        // waited out ten times inside the cron's minute. What was read is
        // stored; the rest is asked tomorrow.
        outcome.stopped = called.reason;
        break;
      }
      outcome.asked += 1;
      outcome.costUsd = Math.round((outcome.costUsd + called.result.costUsd) * 10_000) / 10_000;
      if (!called.result.account) outcome.missing += 1;
      byHandle.set(handle, called.result.account);
    }
    const account = byHandle.get(handle) ?? null;
    const m = account?.metrics;
    snapshots.push({
      business_id: site.id,
      user_id: site.user_id,
      day,
      handle: account?.handle ?? handle,
      followers: m?.followers ?? null,
      following: m?.following ?? null,
      posts: m?.posts ?? null,
      listed: m?.listed ?? null,
      fetched_at: fetchedAt,
    });
  }

  if (snapshots.length === 0) return outcome;
  const { data: stored, error: storeError } = await params.admin
    .from(X_ACCOUNT_METRICS_TABLE)
    .upsert(snapshots, { onConflict: "business_id,day" })
    .select("business_id");
  if (storeError) {
    outcome.note = `x_account_metrics upsert failed: ${storeError.message}`;
    log("error", { outcome: "store_failed", error: storeError.message });
    return outcome;
  }
  outcome.stored = stored?.length ?? 0;
  return outcome;
}
