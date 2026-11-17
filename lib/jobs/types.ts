import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Durable job execution.
 *
 * A workflow is an ordered list of named steps. Each completed step is
 * checkpointed, so a run that stops — because the function ran out of time, or
 * because a step failed and is being retried — resumes from where it got to
 * instead of starting over. Steps must therefore be safe to re-enter: a step
 * that already completed is never executed again.
 */

export type JobStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

/**
 * The priority of a job a person or an agent asked for (Generate now, Run
 * discovery, Run now on AI Visibility, a draft), ahead of the scheduled
 * work the crons enqueue at 0. It is also how a job reads as asked for:
 * the per-account daily caps count these and not the crons' own
 * (lib/limits/actions.ts).
 */
export const MANUAL_JOB_PRIORITY = 10;

export interface JobRow {
  id: string;
  user_id: string;
  article_id: string | null;
  type: string;
  input: Record<string, unknown>;
  status: JobStatus;
  current_step: string | null;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
}

export interface StepContext {
  job: JobRow;
  supabase: SupabaseClient;
  /** The job's immutable input. */
  input: Record<string, unknown>;
  /** Outputs of every step completed so far, keyed by step name. */
  outputs: Record<string, unknown>;
  signal?: AbortSignal;
  /**
   * Epoch millis by which the whole tick must be done. A step that does many
   * small units of work (one probe per query, say) reads it to stop cleanly
   * and yield with `StepIncomplete` instead of being killed mid-write.
   */
  deadline?: number;
}

export interface WorkflowStep {
  name: string;
  /** Returns the value checkpointed for this step. Must be JSON-serialisable. */
  run(ctx: StepContext): Promise<unknown>;
}

export interface Workflow {
  type: string;
  steps: WorkflowStep[];
  /**
   * Called when the job is put back in the queue because the LLM layer is
   * paused for billing (`lib/llm-billing.ts`), either before it ran or after
   * a step was refused, or because the account reached its daily AI spend
   * limit (`reason` then says so). No attempt was spent and nothing failed: this is
   * where a workflow undoes the "in progress" state it showed, so the work
   * reads as queued again. Must not throw for a missing row.
   */
  onPause?(ctx: {
    job: JobRow;
    supabase: SupabaseClient;
    outputs: Record<string, unknown>;
    /**
     * Why it was held, in words, when it is not the LLM pause: the account
     * reached its daily AI spend limit (lib/limits/spend.ts). The workflow
     * records it as the cause instead of the billing one.
     */
    reason?: string;
  }): Promise<void>;
  /** Called once, when the job has exhausted its attempts. */
  onFailure?(ctx: {
    job: JobRow;
    supabase: SupabaseClient;
    error: string;
    outputs: Record<string, unknown>;
  }): Promise<void>;
}

/**
 * Signals a failure no retry can change: a precondition the job's input does
 * not meet, a setting nobody has filled in. The job fails on this attempt,
 * with this message as its reason, instead of spending the remaining
 * attempts repeating it.
 */
export class TerminalStepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalStepError";
  }
}

/**
 * Written to `jobs.last_error` when the worker stops a paid job because its
 * owner no longer has an active subscription (lib/jobs/worker.ts). Terminal:
 * no retry, nothing reported. Workflows recognise it with
 * `isSubscriptionInactive` (an article goes back to `queued`, no email).
 */
export const JOB_SUBSCRIPTION_INACTIVE_MESSAGE =
  "Subscription inactive: this account has no active GetTrafficFast subscription, so the job was stopped. Start it again once the subscription is renewed.";

export function isSubscriptionInactive(message: string | null | undefined): boolean {
  return (message ?? "").startsWith("Subscription inactive:");
}

/** Signals a step wants the job retried later without consuming the run. */
export class RetryableStepError extends Error {
  constructor(message: string, readonly retryAfterSeconds = 60) {
    super(message);
    this.name = "RetryableStepError";
  }
}

/**
 * Signals a step made progress and has more to do: it ran out of time, or a
 * vendor asked it to wait. Not a failure — no attempt is consumed, nothing is
 * reported — the job is released and resumes at this same step, which must
 * therefore be re-enterable (it picks up whatever it has not done yet).
 */
export class StepIncomplete extends Error {
  constructor(message: string, readonly resumeAfterSeconds = 0) {
    super(message);
    this.name = "StepIncomplete";
  }
}
