import type { SupabaseClient } from "@supabase/supabase-js";
import * as Sentry from "@sentry/nextjs";
import { abortAt, isAbortError } from "@/lib/providers/llm/bound";
import { LlmError, isLlmBillingRefusal } from "@/lib/providers/llm/types";
import { LLM_PAUSE_MS, LLM_PAUSED_MESSAGE, llmPausedUntil, recordLlmBillingRefusal } from "@/lib/llm-billing";
import { hasPaidAccess } from "@/lib/paid-access";
import { SPEND_CAP_CODE, checkAccountSpend, spendHeldMessage } from "@/lib/limits/spend";
import { getWorkflow, isLlmBoundJob, isPaidJob } from "./registry";
import {
  JOB_SUBSCRIPTION_INACTIVE_MESSAGE,
  JobRow,
  RetryableStepError,
  StepContext,
  StepIncomplete,
  TerminalStepError,
} from "./types";

/**
 * The worker.
 *
 * Claims jobs atomically (FOR UPDATE SKIP LOCKED in `claim_jobs`), executes
 * their steps in order while there is time left, and checkpoints as it goes.
 * When the clock runs out it releases the job so the next tick picks it up —
 * work already done is never repeated.
 */

/** Leave room for the runtime to finish writes before the function is killed. */
const DEFAULT_TIME_BUDGET_MS = 45_000;
const SAFETY_MARGIN_MS = 5_000;

/**
 * A job held by the LLM billing pause comes back as "yielded": it is queued,
 * unfinished and not failed, which is what every caller already understands
 * by that word. The tick counts it separately as `paused`.
 */
export type JobOutcome = "completed" | "failed" | "retrying" | "yielded";

/**
 * The LLM pause as one tick sees it: read once (`until` undefined means not
 * read yet), and set the moment a step is refused, so the jobs after it in
 * the same tick are held without a call.
 */
export interface PauseState {
  until: Date | null | undefined;
  held: number;
}

export function freshPauseState(): PauseState {
  return { until: undefined, held: 0 };
}

/**
 * A sentence written for the person, and a provider account that cannot pay,
 * are outcomes recorded on the job. Sentry is for what the code did not expect.
 */
export function shouldReportStepError(err: unknown): boolean {
  if (err instanceof TerminalStepError) return false;
  if (err instanceof LlmError && !err.report) return false;
  return true;
}

export interface TickOptions {
  workerId?: string;
  maxJobs?: number;
  timeBudgetMs?: number;
}

export interface TickResult {
  claimed: number;
  outcomes: Record<JobOutcome, number>;
  /** Jobs put back in the queue by the LLM billing pause (counted in `yielded` too). */
  paused: number;
  /** When the LLM pause ends, if one held during this tick. */
  pausedUntil: string | null;
}

function log(level: "info" | "warn" | "error", fields: Record<string, unknown>) {
  const line = JSON.stringify({ ts: new Date().toISOString(), event: "jobs", ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

/** Exponential, capped: 1m, 2m, 4m, 8m … */
function backoffSeconds(attempt: number): number {
  return Math.min(60 * 2 ** Math.max(0, attempt - 1), 1800);
}

async function loadCompletedOutputs(
  supabase: SupabaseClient,
  jobId: string
): Promise<Record<string, unknown>> {
  const { data } = await supabase
    .from("job_steps")
    .select("step, output, status")
    .eq("job_id", jobId)
    .eq("status", "completed");

  const outputs: Record<string, unknown> = {};
  for (const row of data ?? []) outputs[row.step as string] = row.output;
  return outputs;
}

export async function runJob(
  supabase: SupabaseClient,
  job: JobRow,
  deadline: number,
  signal?: AbortSignal,
  pause: PauseState = freshPauseState()
): Promise<JobOutcome> {
  // Fires before the platform kills the function, so a call that is still
  // going is aborted and the lock is released here, not five minutes later
  // by the claim query.
  const timed = abortAt(deadline, SAFETY_MARGIN_MS, signal);
  try {
    return await runSteps(supabase, job, deadline, timed.signal, pause);
  } finally {
    timed.cancel();
  }
}

/**
 * Puts a job back in the queue until the LLM pause ends. Not a failure and
 * not an attempt: the claim's increment is given back, nothing is reported,
 * and the workflow undoes whatever "in progress" state it showed.
 */
async function holdForPause(
  supabase: SupabaseClient,
  job: JobRow,
  workflow: ReturnType<typeof getWorkflow>,
  outputs: Record<string, unknown>,
  until: Date,
  step: string | null,
  pause: PauseState
): Promise<JobOutcome> {
  await supabase
    .from("jobs")
    .update({
      status: "pending",
      ...(step ? { current_step: step } : {}),
      run_after: until.toISOString(),
      locked_by: null,
      locked_at: null,
      attempts: Math.max(0, job.attempts - 1),
      last_error: LLM_PAUSED_MESSAGE,
      updated_at: new Date().toISOString(),
    })
    .eq("id", job.id);

  if (workflow.onPause) {
    try {
      await workflow.onPause({ job, supabase, outputs });
    } catch (pauseError) {
      log("error", {
        job_id: job.id,
        outcome: "on_pause_threw",
        error: pauseError instanceof Error ? pauseError.message : String(pauseError),
      });
    }
  }

  pause.held += 1;
  log("warn", {
    job_id: job.id,
    type: job.type,
    step,
    outcome: "paused",
    reason: "llm_billing",
    resume_at: until.toISOString(),
  });
  return "yielded";
}

/** When a paid job whose owner's subscription could not be read is tried again. */
const SUBSCRIPTION_RECHECK_MS = 5 * 60 * 1000;

/**
 * Stops a paid job whose owner no longer pays: failed on this attempt with
 * JOB_SUBSCRIPTION_INACTIVE_MESSAGE, no retry, nothing sent to Sentry. It is
 * an account state, not a defect. `onFailure` runs so the workflow can undo
 * what it showed (an article goes back to `queued`, without an email).
 */
async function failForSubscription(
  supabase: SupabaseClient,
  job: JobRow,
  workflow: ReturnType<typeof getWorkflow>,
  outputs: Record<string, unknown>
): Promise<JobOutcome> {
  const at = new Date().toISOString();
  await supabase
    .from("jobs")
    .update({
      status: "failed",
      last_error: JOB_SUBSCRIPTION_INACTIVE_MESSAGE,
      finished_at: at,
      updated_at: at,
      locked_by: null,
      locked_at: null,
    })
    .eq("id", job.id);

  if (workflow.onFailure) {
    try {
      await workflow.onFailure({ job, supabase, error: JOB_SUBSCRIPTION_INACTIVE_MESSAGE, outputs });
    } catch (cleanupError) {
      log("error", {
        job_id: job.id,
        outcome: "on_failure_threw",
        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    }
  }

  log("warn", { job_id: job.id, type: job.type, user_id: job.user_id, outcome: "failed", reason: "subscription_inactive" });
  return "failed";
}

/**
 * A paid job whose owner's subscription, or today's spend, could not be
 * read: neither run (it might not be paid for, or be over the limit) nor
 * failed (it might be fine). Back to the queue for a few minutes, the
 * attempt given back.
 */
async function holdUnverified(
  supabase: SupabaseClient,
  job: JobRow,
  error: unknown,
  reason: "subscription_unreadable" | "spend_unreadable" = "subscription_unreadable"
): Promise<JobOutcome> {
  await supabase
    .from("jobs")
    .update({
      status: "pending",
      run_after: new Date(Date.now() + SUBSCRIPTION_RECHECK_MS).toISOString(),
      locked_by: null,
      locked_at: null,
      attempts: Math.max(0, job.attempts - 1),
      updated_at: new Date().toISOString(),
    })
    .eq("id", job.id);
  log("warn", {
    job_id: job.id,
    type: job.type,
    user_id: job.user_id,
    outcome: "yielded",
    reason,
    error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
  });
  return "yielded";
}

/**
 * Puts a paid job back in the queue until the account's daily AI spend
 * window frees (lib/limits/spend.ts). Like the LLM pause: not a failure and
 * not an attempt, nothing reported, and the workflow undoes the "in
 * progress" state it showed, with the reason as its cause.
 */
async function holdForSpend(
  supabase: SupabaseClient,
  job: JobRow,
  workflow: ReturnType<typeof getWorkflow>,
  outputs: Record<string, unknown>,
  until: Date,
  message: string
): Promise<JobOutcome> {
  await supabase
    .from("jobs")
    .update({
      status: "pending",
      run_after: until.toISOString(),
      locked_by: null,
      locked_at: null,
      attempts: Math.max(0, job.attempts - 1),
      last_error: message,
      updated_at: new Date().toISOString(),
    })
    .eq("id", job.id);

  if (workflow.onPause) {
    try {
      await workflow.onPause({ job, supabase, outputs, reason: message });
    } catch (pauseError) {
      log("error", {
        job_id: job.id,
        outcome: "on_pause_threw",
        error: pauseError instanceof Error ? pauseError.message : String(pauseError),
      });
    }
  }

  log("warn", {
    job_id: job.id,
    type: job.type,
    user_id: job.user_id,
    outcome: "yielded",
    reason: "spend_cap_reached",
    resume_at: until.toISOString(),
  });
  return "yielded";
}

async function runSteps(
  supabase: SupabaseClient,
  job: JobRow,
  deadline: number,
  signal: AbortSignal,
  pause: PauseState
): Promise<JobOutcome> {
  const workflow = getWorkflow(job.type);
  const outputs = await loadCompletedOutputs(supabase, job.id);
  const now = () => new Date().toISOString();

  // A paid job runs only for an owner who pays, checked when it runs, not
  // only when it was queued: an account that lapsed after queueing (or a
  // retry days later) would otherwise be paid for by us. The same rule as
  // the screens' paywall (`hasPaidAccess`, lib/paid-access.ts).
  if (isPaidJob(job.type)) {
    let paid: boolean;
    try {
      paid = await hasPaidAccess(supabase, job.user_id);
    } catch (error) {
      return holdUnverified(supabase, job, error);
    }
    if (!paid) return failForSubscription(supabase, job, workflow, outputs);

    // The account's daily AI spend ceiling (lib/limits/spend.ts), checked
    // when the job runs and on every resume: an account at its limit has
    // its job held until the rolling window frees, no attempt spent; a
    // spend that cannot be read holds it for a few minutes (fail closed for
    // money, without failing the work). A missing table lets it run.
    const spend = await checkAccountSpend(supabase, job.user_id);
    if (!spend.ok) {
      if (spend.code === SPEND_CAP_CODE) {
        return holdForSpend(supabase, job, workflow, outputs, spend.freesAt, spendHeldMessage(spend.freesAt));
      }
      return holdUnverified(supabase, job, spend.detail, "spend_unreadable");
    }
  }

  // The model accounts cannot pay: a job that needs a model waits in the
  // queue rather than spending an attempt (and whatever paid lookups come
  // before its first model call) on a refusal.
  if (isLlmBoundJob(job.type)) {
    if (pause.until === undefined) pause.until = await llmPausedUntil(supabase);
    if (pause.until && pause.until.getTime() > Date.now()) {
      return holdForPause(supabase, job, workflow, outputs, pause.until, job.current_step, pause);
    }
  }

  for (const step of workflow.steps) {
    if (step.name in outputs) continue;

    // Out of time: hand the job back so the next tick resumes here.
    if (Date.now() > deadline - SAFETY_MARGIN_MS) {
      await supabase
        .from("jobs")
        .update({
          status: "pending",
          current_step: step.name,
          locked_by: null,
          locked_at: null,
          // The yield is not a failed attempt.
          attempts: Math.max(0, job.attempts - 1),
          updated_at: now(),
        })
        .eq("id", job.id);
      log("info", { job_id: job.id, type: job.type, step: step.name, outcome: "yielded" });
      return "yielded";
    }

    await supabase
      .from("jobs")
      .update({ current_step: step.name, updated_at: now() })
      .eq("id", job.id);

    await supabase.from("job_steps").upsert(
      {
        job_id: job.id,
        step: step.name,
        status: "running",
        attempt: job.attempts,
        started_at: now(),
        error: null,
      },
      { onConflict: "job_id,step" }
    );

    const ctx: StepContext = {
      job,
      supabase,
      input: job.input ?? {},
      outputs,
      signal,
      deadline: deadline - SAFETY_MARGIN_MS,
    };

    const startedAt = Date.now();
    try {
      const output = (await step.run(ctx)) ?? null;

      await supabase
        .from("job_steps")
        .update({ status: "completed", output, finished_at: now() })
        .eq("job_id", job.id)
        .eq("step", step.name);

      outputs[step.name] = output;
      log("info", {
        job_id: job.id,
        type: job.type,
        step: step.name,
        ms: Date.now() - startedAt,
        outcome: "step_completed",
      });
    } catch (err) {
      if (signal.aborted || isAbortError(err)) {
        // The clock ran out mid-call. Releasing here is what the platform
        // kill used to skip: the job goes back to the queue, the attempt is
        // not spent, and nothing is reported. The step row stays "running"
        // because the work is unfinished, not failed.
        await supabase
          .from("jobs")
          .update({
            status: "pending",
            current_step: step.name,
            locked_by: null,
            locked_at: null,
            attempts: Math.max(0, job.attempts - 1),
            updated_at: now(),
          })
          .eq("id", job.id);
        log("info", {
          job_id: job.id,
          type: job.type,
          step: step.name,
          outcome: "yielded",
          reason: "deadline",
        });
        return "yielded";
      }

      if (err instanceof StepIncomplete) {
        // Same handling as running out of time between steps: the job goes
        // back to the queue at this step, the attempt is not counted, and the
        // step row stays "running" because it is.
        await supabase
          .from("jobs")
          .update({
            status: "pending",
            current_step: step.name,
            run_after: new Date(Date.now() + err.resumeAfterSeconds * 1000).toISOString(),
            locked_by: null,
            locked_at: null,
            attempts: Math.max(0, job.attempts - 1),
            updated_at: now(),
          })
          .eq("id", job.id);
        log("info", {
          job_id: job.id,
          type: job.type,
          step: step.name,
          outcome: "yielded",
          reason: err.message,
          resume_in_s: err.resumeAfterSeconds,
        });
        return "yielded";
      }

      const message = err instanceof Error ? err.message : String(err);

      if (isLlmBillingRefusal(err)) {
        // Every model account refused to pay. Retrying spends attempts on
        // the same refusal and failing tells the customer something broke;
        // instead the layer is paused, the operator is told once a day, and
        // this job waits in the queue. The step stays "running": unfinished,
        // not failed, with the reason on record.
        await supabase
          .from("job_steps")
          .update({ error: message.slice(0, 2000) })
          .eq("job_id", job.id)
          .eq("step", step.name);
        const recorded = await recordLlmBillingRefusal(supabase, err, {
          source: "jobs.worker",
          jobId: job.id,
          jobType: job.type,
          step: step.name,
        });
        pause.until = recorded?.pausedUntil ?? new Date(Date.now() + LLM_PAUSE_MS);
        return holdForPause(supabase, job, workflow, outputs, pause.until, step.name, pause);
      }

      const retryable = err instanceof RetryableStepError;
      // A missing key, an empty account, a precondition the input does not
      // meet: these fail the same way on every retry. Spending the remaining
      // attempts only repeats the Sentry event.
      const terminal = err instanceof TerminalStepError || (err instanceof LlmError && !err.retryable);
      const exhausted = terminal || (!retryable && job.attempts >= job.max_attempts);

      await supabase
        .from("job_steps")
        .update({ status: "failed", error: message.slice(0, 2000), finished_at: now() })
        .eq("job_id", job.id)
        .eq("step", step.name);

      if (shouldReportStepError(err)) {
        Sentry.captureException(err, {
          tags: { job_type: job.type, step: step.name, exhausted: String(exhausted) },
          extra: { job_id: job.id, attempt: job.attempts },
        });
      }

      if (exhausted) {
        await supabase
          .from("jobs")
          .update({
            status: "failed",
            last_error: message.slice(0, 2000),
            finished_at: now(),
            updated_at: now(),
            locked_by: null,
            locked_at: null,
          })
          .eq("id", job.id);

        if (workflow.onFailure) {
          try {
            await workflow.onFailure({ job, supabase, error: message, outputs });
          } catch (cleanupError) {
            log("error", {
              job_id: job.id,
              outcome: "on_failure_threw",
              error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
            });
          }
        }

        log("error", { job_id: job.id, type: job.type, step: step.name, outcome: "failed", error: message });
        return "failed";
      }

      const delay = retryable
        ? (err as RetryableStepError).retryAfterSeconds
        : backoffSeconds(job.attempts);

      await supabase
        .from("jobs")
        .update({
          status: "pending",
          last_error: message.slice(0, 2000),
          run_after: new Date(Date.now() + delay * 1000).toISOString(),
          locked_by: null,
          locked_at: null,
          updated_at: now(),
        })
        .eq("id", job.id);

      log("warn", {
        job_id: job.id,
        type: job.type,
        step: step.name,
        outcome: "retrying",
        retry_in_s: delay,
        error: message,
      });
      return "retrying";
    }
  }

  await supabase
    .from("jobs")
    .update({
      status: "completed",
      current_step: null,
      result: outputs,
      finished_at: now(),
      updated_at: now(),
      locked_by: null,
      locked_at: null,
    })
    .eq("id", job.id);

  log("info", { job_id: job.id, type: job.type, outcome: "completed" });
  return "completed";
}

export async function tick(
  supabase: SupabaseClient,
  options: TickOptions = {}
): Promise<TickResult> {
  const workerId = options.workerId ?? `worker-${crypto.randomUUID().slice(0, 8)}`;
  const maxJobs = options.maxJobs ?? 3;
  const deadline = Date.now() + (options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS);

  const { data, error } = await supabase.rpc("claim_jobs", {
    p_worker: workerId,
    p_limit: maxJobs,
  });

  if (error) throw new Error(`Failed to claim jobs: ${error.message}`);

  const jobs = (data ?? []) as JobRow[];
  const outcomes: Record<JobOutcome, number> = {
    completed: 0,
    failed: 0,
    retrying: 0,
    yielded: 0,
  };
  const pause = freshPauseState();

  for (const job of jobs) {
    if (Date.now() > deadline - SAFETY_MARGIN_MS) {
      // Release what we cannot start, so it is picked up promptly.
      await supabase
        .from("jobs")
        .update({
          status: "pending",
          locked_by: null,
          locked_at: null,
          attempts: Math.max(0, job.attempts - 1),
        })
        .eq("id", job.id);
      outcomes.yielded++;
      continue;
    }
    outcomes[await runJob(supabase, job, deadline, undefined, pause)]++;
  }

  return {
    claimed: jobs.length,
    outcomes,
    paused: pause.held,
    pausedUntil: pause.until ? pause.until.toISOString() : null,
  };
}

/**
 * Runs one specific job inline, for paths where the user is waiting (a manual
 * "generate now"). Same execution, same checkpoints — only the trigger differs.
 */
export async function runJobNow(
  supabase: SupabaseClient,
  jobId: string,
  timeBudgetMs = DEFAULT_TIME_BUDGET_MS
): Promise<JobOutcome | "not_found"> {
  const { data } = await supabase
    .from("jobs")
    .select("id, user_id, article_id, type, input, status, current_step, attempts, max_attempts, last_error")
    .eq("id", jobId)
    .maybeSingle();

  if (!data) return "not_found";

  await supabase
    .from("jobs")
    .update({
      status: "running",
      locked_by: "inline",
      locked_at: new Date().toISOString(),
      attempts: (data.attempts ?? 0) + 1,
    })
    .eq("id", jobId);

  return runJob(supabase, { ...(data as JobRow), attempts: (data.attempts ?? 0) + 1 }, Date.now() + timeBudgetMs);
}
