import type { Workflow } from "@/lib/jobs/types";

/**
 * The close-accounts trial's job type, kept registered only so a stored row
 * of it still names a known workflow (docs/PLACEMENTS.md, "Close accounts").
 *
 * The trial (2026-11-14 to 16, one site, its own cron every three hours) is
 * over: since 2026-11-24 the close accounts are searched for every site as
 * the `close` step of the daily `x-post-discovery` job
 * (lib/jobs/workflows/x-discovery.ts). Nothing enqueues this type any more;
 * a row still queued from the trial finishes without a call.
 */

export const X_CLOSE_TRIAL = "x-close-trial";

export const xCloseTrialWorkflow: Workflow = {
  type: X_CLOSE_TRIAL,
  steps: [
    {
      name: "search",
      async run() {
        return { skipped: "the close accounts are searched by the daily X run (x-post-discovery)" };
      },
    },
  ],
};
