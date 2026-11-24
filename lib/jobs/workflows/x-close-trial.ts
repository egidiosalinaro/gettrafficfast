import { xApiClientFromEnv } from "@/lib/providers/x/api";
import {
  X_CLOSE_SOURCE,
  closeTrialGate,
  closeTrialRecord,
  closeWindowStart,
  lastCloseSearchAt,
  searchXCloseAccounts,
} from "@/lib/placements/x-close";
import type { Workflow } from "@/lib/jobs/types";
import { loadBusiness } from "./placement-discovery";
import { xFindSteps } from "./x-discovery";

/**
 * The close-accounts trial for one site, one run (docs/PLACEMENTS.md,
 * "Close accounts trial"):
 *
 *   search   — one or two recent searches over the accounts the site replies
 *              to most, since the last run (three hours at most), under the
 *              monthly cap (lib/placements/x-close.ts). Checkpointed.
 *   rules, qualify, draft — the daily X search's own steps, on the rows
 *              found via `x_close`.
 *   measure  — the run's numbers in one record (this step's output in
 *              `job_steps`) and one log line, `event: "x_close_trial"`.
 *
 * Re-checks the gate when it runs, so a job queued before the trial's end
 * searches nothing after it.
 */

export const X_CLOSE_TRIAL = "x-close-trial";

function businessIdOf(input: Record<string, unknown>): string {
  const businessId = typeof input.businessId === "string" ? input.businessId : "";
  if (!businessId) throw new Error(`${X_CLOSE_TRIAL} needs businessId`);
  return businessId;
}

export const xCloseTrialWorkflow: Workflow = {
  type: X_CLOSE_TRIAL,
  steps: [
    {
      name: "search",
      async run(ctx) {
        const businessId = businessIdOf(ctx.input);
        const now = new Date();
        const gate = closeTrialGate(businessId, now);
        if (!gate.ok) return { skipped: gate.reason };
        const business = await loadBusiness(ctx.supabase, businessId);
        if (!business) return { skipped: "business not found" };
        const client = xApiClientFromEnv();
        if (!client) return { skipped: "the X API is not turned on for this deployment" };
        const windowStart = closeWindowStart(await lastCloseSearchAt(ctx.supabase, businessId, X_CLOSE_TRIAL, ctx.job.id), now);
        const outcome = await searchXCloseAccounts({ supabase: ctx.supabase, client, business, windowStart, now, signal: ctx.signal });
        return { ...outcome, notes: outcome.notes.slice(0, 10) };
      },
    },
    ...xFindSteps(X_CLOSE_SOURCE),
    {
      name: "measure",
      async run(ctx) {
        const record = closeTrialRecord(ctx.outputs);
        console.log(
          JSON.stringify({
            ts: new Date().toISOString(),
            level: "info",
            event: "x_close_trial",
            business_id: businessIdOf(ctx.input),
            job_id: ctx.job.id,
            ...record,
          })
        );
        return record;
      },
    },
  ],
};
