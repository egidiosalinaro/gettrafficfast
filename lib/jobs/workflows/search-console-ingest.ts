import {
  ingestBusinessSearchConsole,
  loadConnection,
  markConnectionError,
} from "@/lib/analytics/search-console";
import type { Workflow } from "@/lib/jobs/types";
import { measureDuePushes } from "@/lib/lifecycle/push-store";

/**
 * One Search Console ingest for one site.
 *
 * The daily cron still sweeps every connected business. This job exists so a
 * first property selection does not wait until 07:00 UTC: the OAuth callback
 * and "choose this property" enqueue the same work the sweep would have done
 * tonight, and the worker (or runJobNow while the user is waiting) executes
 * it. One step: ingest is already windowed and idempotent.
 */

export const SEARCH_CONSOLE_INGEST = "search-console-ingest";

export const searchConsoleIngestWorkflow: Workflow = {
  type: SEARCH_CONSOLE_INGEST,
  steps: [
    {
      name: "ingest",
      run: async (ctx) => {
        const businessId =
          typeof ctx.input.businessId === "string" ? ctx.input.businessId : "";
        if (!businessId) throw new Error("search-console-ingest needs businessId");
        const result = await ingestBusinessSearchConsole({
          supabase: ctx.supabase,
          businessId,
        });
        // Push page 3's after-values, once the new days are in (free).
        if (result.status === "ingested") {
          await measureDuePushes(ctx.supabase, businessId).catch(() => undefined);
        }
        return result;
      },
    },
  ],
  onFailure: async ({ supabase, job, error }) => {
    const businessId =
      typeof job.input.businessId === "string" ? job.input.businessId : null;
    if (!businessId) return;
    const connection = await loadConnection({ supabase, businessId });
    if (connection) {
      await markConnectionError({
        supabase,
        connectionId: connection.id,
        message: error,
      });
    }
  },
};
