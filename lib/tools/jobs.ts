import { after } from "next/server";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runJobNow } from "@/lib/jobs/worker";
import { PLACEMENT_DRAFT } from "@/lib/jobs/workflows/placement-draft";
import { draftFailureForCard } from "@/lib/placements/draft-progress";
import { draftAuditOf } from "@/lib/placements/generate";
import { llmFailureKind } from "@/lib/providers/llm/types";
import { defineTool, ToolError } from "./tool";

/**
 * Jobs as the API sees them: drafting and discovery are durable jobs
 * (lib/jobs/), and a tool that starts one answers `{ jobId, status }` after
 * waiting up to 25 s; `get_job` says how it ended.
 *
 * The wait never cuts the job short. The job runs with the same budget the
 * screens give it, and the call answers when the job is done or the wait is
 * over, whichever comes first; a job still running then goes on after the
 * response (`after`), and the worker tick resumes it if even that is cut.
 * Cutting a model call at 25 s would pay for the call and throw the answer
 * away.
 */

/** The longest a tool waits for a job before answering with its status. */
export const MAX_WAIT_SECONDS = 25;

export const WaitSeconds = z
  .number()
  .int()
  .min(0)
  .max(MAX_WAIT_SECONDS)
  .default(MAX_WAIT_SECONDS)
  .describe(`How long to wait for the job before answering, 0 to ${MAX_WAIT_SECONDS} seconds. It keeps running either way.`);

/**
 * Runs the job with its full `budgetMs` and returns once it finished or
 * `waitMs` passed. Never throws: a run that fails records its failure on
 * the job, which is what `get_job` reads.
 */
export async function runJobWithin(
  admin: SupabaseClient,
  jobId: string,
  options: { budgetMs: number; waitMs: number }
): Promise<void> {
  let finished = false;
  const run = runJobNow(admin, jobId, options.budgetMs)
    .catch((error) => {
      console.error(
        JSON.stringify({
          level: "error",
          event: "tool.job_run_failed",
          job_id: jobId,
          error: error instanceof Error ? error.message.slice(0, 300) : String(error),
        })
      );
    })
    .then(() => {
      finished = true;
    });

  if (options.waitMs > 0) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([run, new Promise<void>((resolve) => (timer = setTimeout(resolve, options.waitMs)))]);
    if (timer) clearTimeout(timer);
  }
  if (finished) return;
  try {
    // Keeps the function alive until the run ends (bounded by maxDuration).
    after(() => run);
  } catch (error) {
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "tool.job_not_kept_alive",
        job_id: jobId,
        error: error instanceof Error ? error.message.slice(0, 300) : String(error),
      })
    );
  }
}

export const JobFailure = z.object({
  kind: z.enum(["declined", "paused", "failed"]).describe("declined: the drafter judged the post not worth a reply; paused: the AI provider; failed: anything else."),
  message: z.string(),
});

export const JobView = z.object({
  jobId: z.string(),
  type: z.string(),
  status: z.enum(["pending", "running", "completed", "failed", "cancelled"]),
  createdAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  failure: JobFailure.nullable().describe("Set when status is failed."),
  audit: z
    .object({ status: z.string().nullable(), writes: z.number().nullable(), omitted: z.array(z.string()) })
    .nullable()
    .describe("For a finished draft: the gate's verdict on what was written."),
  result: z.record(z.string(), z.unknown()).nullable(),
});
export type JobViewOutput = z.infer<typeof JobView>;

type Row = Record<string, unknown>;

/** A job other than a draft, stopped by the AI provider: the same no-vendor sentences as drafting's. */
export const JOB_PAUSED_BILLING = "This job is paused: the AI provider's credits ran out. Start it again once they are topped up.";
export const JOB_PAUSED_UNAVAILABLE = "This job is paused: the AI provider is not answering right now. Start it again in a few minutes.";

function failureOf(type: string, lastError: string | null): z.infer<typeof JobFailure> {
  if (type === PLACEMENT_DRAFT) {
    const { kind, text } = draftFailureForCard(lastError);
    return { kind, message: text };
  }
  const text = (lastError ?? "").trim();
  // No vendor's wording, whatever the job (docs/PLACEMENTS.md).
  const llm = llmFailureKind(text);
  if (llm === "billing") return { kind: "paused", message: JOB_PAUSED_BILLING };
  if (llm === "unavailable") return { kind: "paused", message: JOB_PAUSED_UNAVAILABLE };
  return { kind: "failed", message: text.slice(0, 500) || "The job failed." };
}

export function mapJob(row: Row): JobViewOutput {
  const type = String(row.type ?? "");
  const status = JobView.shape.status.safeParse(row.status);
  const failed = row.status === "failed";
  const result = row.result && typeof row.result === "object" && !Array.isArray(row.result) ? (row.result as Row) : null;
  return {
    jobId: row.id as string,
    type,
    status: status.success ? status.data : "pending",
    createdAt: (row.created_at as string | null) ?? null,
    finishedAt: (row.finished_at as string | null) ?? null,
    failure: failed ? failureOf(type, (row.last_error as string | null) ?? null) : null,
    audit: type === PLACEMENT_DRAFT && row.status === "completed" ? draftAuditOf(result) : null,
    result,
  };
}

/** One job of the site, through the caller's client; null when it is not there. */
export async function readJob(client: SupabaseClient, businessId: string, jobId: string): Promise<JobViewOutput | null> {
  const { data } = await client
    .from("jobs")
    .select("id, type, status, last_error, result, created_at, finished_at")
    .eq("id", jobId)
    .eq("business_id", businessId)
    .maybeSingle();
  return data ? mapJob(data as Row) : null;
}

export const getJob = defineTool({
  name: "get_job",
  title: "Get a job",
  description:
    "How a job started by draft_reply or run_reply_discovery stands: pending, running, completed or failed, with the failure in words (a decline says why) and, for a finished draft, the gate's verdict. Poll it every few seconds after a tool answered with a jobId; read the drafts with get_reply_target.",
  input: z.object({ jobId: z.string().uuid() }),
  output: z.object({ job: JobView }),
  scope: "read",
  paid: false,
  owns: { jobId: "jobs" },
  async handler(ctx, input) {
    const job = await readJob(ctx.client, ctx.businessId, input.jobId);
    if (!job) throw new ToolError("not_found", "No job with that jobId on this site.", 404);
    return { job };
  },
});

export const JOB_TOOLS = [getJob] as const;
