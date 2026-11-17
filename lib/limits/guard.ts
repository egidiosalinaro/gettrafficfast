import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { checkAccountAction } from "./actions";
import { SPEND_CAP_CODE, SPEND_UNREADABLE_MESSAGE, checkAccountSpend } from "./spend";
import { billingDisabled } from "@/lib/billing-mode";

/**
 * The account's limits, asked before a paid action starts: the daily AI
 * spend ceiling (lib/limits/spend.ts) and, for an action that has one, the
 * per-account daily cap (lib/limits/actions.ts). One decision for the
 * screens' routes (`requireAccountCapacity`, after `requirePaidAccess`) and
 * for the tools (`accountCapacityDenial`, in lib/tools/runner.ts), so the
 * two surfaces cannot disagree. The worker and the crons ask the spend half
 * on their own (lib/jobs/worker.ts, lib/limits/owners.ts).
 */

export interface AccountCapacityDenial {
  status: 429 | 503;
  /** `spend_cap_reached`, `cap_reached`, or `unavailable` when a count could not be read. */
  code: typeof SPEND_CAP_CODE | "cap_reached" | "unavailable";
  message: string;
  /** For the spend ceiling: when the rolling window lets spending through again. */
  retryAt?: Date;
}

/**
 * Null when the account may start `action` (a tool's name, or null for a
 * paid action with no account cap of its own: drafts, corrections), else
 * why not. `client` reads `agent_runs`, `account_limits` and the counts
 * with an explicit user filter: the service role, or a function that builds
 * it (one that cannot be built is a spend that cannot be read, and refuses).
 * Never the person's session client: `agent_runs.cost_usd` is not selectable
 * by the customer's role.
 */
export async function accountCapacityDenial(
  clientOrBuild: SupabaseClient | (() => SupabaseClient),
  userId: string,
  action: string | null,
  now: Date = new Date()
): Promise<AccountCapacityDenial | null> {
  let client: SupabaseClient;
  try {
    client = typeof clientOrBuild === "function" ? clientOrBuild() : clientOrBuild;
  } catch (error) {
    console.error(
      JSON.stringify({ level: "error", event: "spend.unreadable", user_id: userId, error: error instanceof Error ? error.message.slice(0, 300) : String(error) })
    );
    return { status: 503, code: "unavailable", message: SPEND_UNREADABLE_MESSAGE };
  }
  const spend = await checkAccountSpend(client, userId, now);
  if (!spend.ok) {
    if (spend.code === SPEND_CAP_CODE) {
      return { status: 429, code: SPEND_CAP_CODE, message: spend.message, retryAt: spend.freesAt };
    }
    return { status: 503, code: "unavailable", message: spend.message };
  }
  if (!action) return null;
  const capped = await checkAccountAction(client, userId, action, now);
  if (capped.ok) return null;
  if (capped.code === "cap_reached") return { status: 429, code: "cap_reached", message: capped.message };
  return { status: 503, code: "unavailable", message: capped.message };
}

/**
 * `accountCapacityDenial` as a route's response: `{ error, code, href }`,
 * with the sentence the person reads and the page that shows the plan's usage.
 * `extra` adds fields a screen reads (the draft card's `kind`).
 *
 * `admin` builds the service role (`createAdminClient`), never the person's
 * session client: the spend is `agent_runs.cost_usd`, a column the customer's
 * own role cannot select (migration 20261114160000_hide_costs_from_customers),
 * so a session client would read every spend as unreadable and refuse every
 * paid action. `userId` is the signed-in person the route already checked;
 * every query filters on it.
 */
export async function requireAccountCapacity(
  admin: () => SupabaseClient,
  userId: string,
  action: string | null,
  extra: Record<string, unknown> = {},
  now: Date = new Date()
): Promise<NextResponse | null> {
  const denial = await accountCapacityDenial(admin, userId, action, now);
  if (!denial) return null;
  const headers: Record<string, string> = {};
  if (denial.retryAt) headers["Retry-After"] = String(Math.max(1, Math.ceil((denial.retryAt.getTime() - now.getTime()) / 1000)));
  return NextResponse.json(
    {
      error: denial.message,
      code: denial.code,
      // No Billing page to point at on a deployment without billing (lib/billing-mode.ts).
      ...(denial.code === SPEND_CAP_CODE && !billingDisabled() ? { href: "/settings/billing" } : {}),
      ...extra,
    },
    { status: denial.status, headers }
  );
}
