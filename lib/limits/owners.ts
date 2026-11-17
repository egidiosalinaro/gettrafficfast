import type { SupabaseClient } from "@supabase/supabase-js";
import { logUnpaidSkip, paidOwners, type UnpaidReason } from "@/lib/paid-access";
import { SPEND_CAP_CODE, checkAccountSpend } from "./spend";

/**
 * The question every per-customer cron that spends asks about an owner,
 * once per owner per run: do they pay (`paidOwners`, lib/paid-access.ts),
 * and is their account under its daily AI spend ceiling
 * (lib/limits/spend.ts)? An owner who fails either is left out of this run
 * and logged, one line each, so their stalled work is visible rather than
 * silently missing. A spend that cannot be read counts as over (fail
 * closed: the work waits for the next run); a missing table lets the owner
 * through, as everywhere else.
 */

export type SpendSkipReason = typeof SPEND_CAP_CODE | "spend_unreadable";
export type OwnerSkipReason = UnpaidReason | SpendSkipReason;

export interface SpendingOwners {
  /** True when the owner pays and is under the ceiling, else why not. */
  verdict(userId: string): Promise<true | OwnerSkipReason>;
}

export function isSpendSkip(reason: OwnerSkipReason): reason is SpendSkipReason {
  return reason === SPEND_CAP_CODE || reason === "spend_unreadable";
}

export function spendingOwners(supabase: SupabaseClient, now: Date = new Date()): SpendingOwners {
  const paid = paidOwners(supabase, now);
  const verdicts = new Map<string, Promise<true | OwnerSkipReason>>();
  return {
    verdict(userId) {
      let verdict = verdicts.get(userId);
      if (!verdict) {
        verdict = paid.verdict(userId).then(async (pays): Promise<true | OwnerSkipReason> => {
          if (pays !== true) return pays;
          const spend = await checkAccountSpend(supabase, userId, now);
          if (spend.ok) return true;
          return spend.code === SPEND_CAP_CODE ? SPEND_CAP_CODE : "spend_unreadable";
        });
        verdicts.set(userId, verdict);
      }
      return verdict;
    },
  };
}

/**
 * The line a sweep writes for an owner it left out: `cron.unpaid_skipped`
 * for one who does not pay (as before), `cron.spend_skipped` for one at
 * the spend ceiling or whose spend could not be read.
 */
export function logOwnerSkip(
  cron: string,
  fields: { user_id: string; business_id?: string | null; reason: OwnerSkipReason } & Record<string, unknown>
): void {
  if (!isSpendSkip(fields.reason)) {
    logUnpaidSkip(cron, { ...fields, reason: fields.reason });
    return;
  }
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level: fields.reason === "spend_unreadable" ? "warn" : "info",
    event: "cron.spend_skipped",
    cron,
    ...fields,
  });
  if (fields.reason === "spend_unreadable") console.warn(line);
  else console.log(line);
}

/** How many owners (and their items) a sweep left out, split by why. */
export function skipSummary(
  skipped: Map<string, { reason: OwnerSkipReason; articles: number }>,
  kind: "unpaid" | "spend"
): { owners: number; articles: number } {
  let owners = 0;
  let articles = 0;
  for (const entry of skipped.values()) {
    if (isSpendSkip(entry.reason) !== (kind === "spend")) continue;
    owners += 1;
    articles += entry.articles;
  }
  return { owners, articles };
}
