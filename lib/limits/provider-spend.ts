import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The ledger of what a paid provider costs the platform, per calendar month
 * (UTC): `provider_spend`, migration 20261111120000.
 *
 * Not the account's AI spend (lib/limits/spend.ts, per customer, model cost,
 * rolling 24 hours): this is the platform's bill with one vendor, against a
 * hard monthly cap the operator sets. One row per (provider, month); a new
 * month is a new row, so the rollover needs no job.
 *
 * Two moves around every call:
 *   1. `reserveProviderSpend` adds the call's WORST case to the month, in one
 *      conditional UPDATE (`reserve_provider_spend`), and refuses when that
 *      would cross the cap. Two callers racing cannot both slip under it.
 *   2. `settleProviderSpend` corrects the reservation to the estimate of what
 *      the call returned, and counts the call and its posts.
 *
 * The rule for money: fail closed. A ledger that cannot be read or written
 * refuses the call; a cost must never switch itself on because a table is
 * missing. The service role is the only client that can use it (RLS).
 */

export const PROVIDER_SPEND_TABLE = "provider_spend";

/** The first day of `now`'s calendar month, UTC, as `YYYY-MM-01`. */
export function monthOf(now: Date): string {
  return `${now.toISOString().slice(0, 7)}-01`;
}

/** The first instant of the next calendar month, UTC: when the cap resets. */
export function nextMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

export interface ProviderMonthSpend {
  month: string;
  costUsd: number;
  calls: number;
  posts: number;
}

export type ProviderSpendReading = { ok: true; spend: ProviderMonthSpend } | { ok: false; error: string };

/** The month's spend for `provider`; a month with no row is a real $0 (nothing was called). */
export async function readProviderSpend(
  supabase: SupabaseClient,
  provider: string,
  now: Date = new Date()
): Promise<ProviderSpendReading> {
  const month = monthOf(now);
  try {
    const { data, error } = await supabase
      .from(PROVIDER_SPEND_TABLE)
      .select("cost_usd, calls, posts")
      .eq("provider", provider)
      .eq("month", month)
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    const row = data as { cost_usd?: unknown; calls?: unknown; posts?: unknown } | null;
    return {
      ok: true,
      spend: {
        month,
        costUsd: Number(row?.cost_usd ?? 0),
        calls: Number(row?.calls ?? 0),
        posts: Number(row?.posts ?? 0),
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export type Reservation =
  | { ok: true; month: string; reservedUsd: number; totalUsd: number }
  | { ok: false; reason: "cap"; month: string }
  | { ok: false; reason: "unreadable"; month: string; error: string };

/**
 * Reserves `amountUsd` of this month's cap for one call. Refused (`cap`)
 * when the month's spend plus the amount would exceed `capUsd`; refused
 * (`unreadable`) when the ledger cannot be written, which is never a
 * licence to call.
 */
export async function reserveProviderSpend(
  supabase: SupabaseClient,
  params: { provider: string; amountUsd: number; capUsd: number; now?: Date }
): Promise<Reservation> {
  const month = monthOf(params.now ?? new Date());
  try {
    const { data, error } = await supabase.rpc("reserve_provider_spend", {
      p_provider: params.provider,
      p_month: month,
      p_amount: params.amountUsd,
      p_cap: params.capUsd,
    });
    if (error) return { ok: false, reason: "unreadable", month, error: error.message };
    if (data === null || data === undefined) return { ok: false, reason: "cap", month };
    return { ok: true, month, reservedUsd: params.amountUsd, totalUsd: Number(data) };
  } catch (err) {
    return { ok: false, reason: "unreadable", month, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Settles a reservation: the month moves by `actualUsd - reservedUsd`
 * (never below $0) and counts one call and its posts. A failed call that
 * was billed nothing settles with `actualUsd` 0 and gives the whole
 * reservation back. Never throws: a settle that cannot be written leaves the
 * worst case recorded, which errs on the side of the cap.
 */
export async function settleProviderSpend(
  supabase: SupabaseClient,
  params: { provider: string; month: string; reservedUsd: number; actualUsd: number; posts: number; calls?: number }
): Promise<boolean> {
  try {
    const { error } = await supabase.rpc("settle_provider_spend", {
      p_provider: params.provider,
      p_month: params.month,
      p_adjust: Math.round((params.actualUsd - params.reservedUsd) * 10_000) / 10_000,
      p_calls: params.calls ?? 1,
      p_posts: params.posts,
    });
    if (error) {
      console.warn(JSON.stringify({ ts: new Date().toISOString(), level: "warn", event: "provider_spend", outcome: "settle_failed", provider: params.provider, error: error.message }));
      return false;
    }
    return true;
  } catch (err) {
    console.warn(JSON.stringify({ ts: new Date().toISOString(), level: "warn", event: "provider_spend", outcome: "settle_failed", provider: params.provider, error: err instanceof Error ? err.message : String(err) }));
    return false;
  }
}
