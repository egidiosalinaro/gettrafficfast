import type { SupabaseClient } from "@supabase/supabase-js";
import * as Sentry from "@sentry/nextjs";
import { isLlmBillingRefusal } from "@/lib/providers/llm/types";
import {
  llmBillingAlertEmail,
  operatorEmailAddress,
  sendNotificationEmail,
} from "@/lib/notifications/email";

/**
 * What happens when the model accounts cannot pay.
 *
 * The LLM layer marks a call whose every provider refused for billing
 * (`LlmError.billingRefused`). Whoever caught it (the job worker, a cron that
 * calls a model directly) hands it here, and this module does three things,
 * all durable and all idempotent:
 *
 *   1. pauses LLM work: one `provider_pauses` row, `paused_until = now + 1h`.
 *      While it holds, the tick leaves LLM-bound jobs queued without spending
 *      an attempt and the crons skip enqueueing LLM work. When it expires the
 *      next run simply tries; a refusal renews it.
 *   2. tells Sentry once per provider per UTC day: `captureMessage`, level
 *      fatal, fingerprint `["llm-billing", provider]`.
 *   3. emails the operator once per UTC day.
 *
 * The dedupe is an insert into `operator_alerts` keyed by (alert, day): the
 * row that wins sends, every other caller that day does not. If the table
 * cannot be written (the migration not applied yet) the Sentry event is
 * still sent, since Sentry groups it by fingerprint, but the email is not,
 * because without the dedupe every tick would send one.
 *
 * Reading the pause fails open: a pause that cannot be read is no pause, so
 * a missing table never stops production. See docs/AGENT_RUNTIME.md.
 */

export const LLM_PAUSE_KIND = "llm";
export const LLM_PAUSE_MS = 60 * 60 * 1000;

/**
 * Written to `jobs.last_error` when a job is held by the pause. It contains
 * "credits are depleted", so `llmFailureKind` reads it as billing and every
 * surface shows its own "delayed" sentence, never this one.
 */
export const LLM_PAUSED_MESSAGE =
  "LLM credits are depleted on every configured provider. The job is queued and resumes automatically when billing is topped up.";

/**
 * What a person sees when a request they made waits on a model that cannot be
 * paid. A route that calls a model in the request (analyse a site, suggest
 * keywords, propose prompts) answers 503 with this, after recording the
 * refusal like the worker does.
 */
export const LLM_CREDITS_RAN_OUT_MESSAGE =
  "The AI provider's credits ran out. Try again once they're topped up.";

function log(level: "info" | "warn" | "error", fields: Record<string, unknown>) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event: "llm_billing", ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** The end of the current LLM pause, or null when LLM work may run. */
export async function llmPausedUntil(supabase: SupabaseClient, now = new Date()): Promise<Date | null> {
  try {
    const { data, error } = await supabase
      .from("provider_pauses")
      .select("paused_until")
      .eq("kind", LLM_PAUSE_KIND)
      .maybeSingle();
    if (error) {
      log("warn", { outcome: "pause_read_failed", error: error.message });
      return null;
    }
    const raw = (data as { paused_until?: string | null } | null)?.paused_until;
    if (!raw) return null;
    const until = new Date(raw);
    return Number.isFinite(until.getTime()) && until.getTime() > now.getTime() ? until : null;
  } catch (err) {
    log("warn", { outcome: "pause_read_failed", error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/**
 * Claims today's alert for `key`. True when this caller is the first today,
 * false when it was already sent, null when the dedupe could not be written.
 */
export async function claimDailyAlert(
  supabase: SupabaseClient,
  key: string,
  day: string,
  detail: string
): Promise<boolean | null> {
  try {
    const { data, error } = await supabase
      .from("operator_alerts")
      .upsert(
        { alert_key: key, day, detail: detail.slice(0, 1000) },
        { onConflict: "alert_key,day", ignoreDuplicates: true }
      )
      .select("alert_key");
    if (error) {
      log("warn", { outcome: "alert_dedupe_failed", key, error: error.message });
      return null;
    }
    return Array.isArray(data) && data.length > 0;
  } catch (err) {
    log("warn", { outcome: "alert_dedupe_failed", key, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

export interface BillingRefusalContext {
  /** Who saw it: "jobs.tick", "cron.autopilot", … */
  source: string;
  jobId?: string;
  jobType?: string;
  step?: string;
}

export interface BillingRefusalOutcome {
  pausedUntil: Date;
  /** Providers whose Sentry event this call sent (empty when already sent today). */
  reported: string[];
  emailed: boolean;
}

/**
 * Pause and alert for a billing refusal. Returns null for any other error,
 * so callers can hand it whatever they caught. Never throws.
 */
export async function recordLlmBillingRefusal(
  supabase: SupabaseClient,
  err: unknown,
  context: BillingRefusalContext,
  now = new Date()
): Promise<BillingRefusalOutcome | null> {
  if (!isLlmBillingRefusal(err)) return null;

  const providers = [...new Set(err.billingRefused)];
  const pausedUntil = new Date(now.getTime() + LLM_PAUSE_MS);
  const detail = err.message;
  const day = utcDay(now);

  try {
    const { error } = await supabase.from("provider_pauses").upsert(
      {
        kind: LLM_PAUSE_KIND,
        paused_until: pausedUntil.toISOString(),
        reason: detail.slice(0, 2000),
        providers,
        updated_at: now.toISOString(),
      },
      { onConflict: "kind" }
    );
    if (error) log("error", { outcome: "pause_write_failed", error: error.message });
  } catch (writeError) {
    log("error", {
      outcome: "pause_write_failed",
      error: writeError instanceof Error ? writeError.message : String(writeError),
    });
  }

  const reported: string[] = [];
  for (const provider of providers) {
    const claimed = await claimDailyAlert(supabase, `llm-billing:${provider}`, day, detail);
    if (claimed === false) continue;
    Sentry.captureMessage(`LLM billing refused: ${provider} cannot pay`, {
      level: "fatal",
      fingerprint: ["llm-billing", provider],
      tags: {
        llm_billing: provider,
        source: context.source,
        ...(context.jobType ? { job_type: context.jobType } : {}),
        ...(context.step ? { step: context.step } : {}),
      },
      extra: {
        providers,
        job_id: context.jobId,
        paused_until: pausedUntil.toISOString(),
        detail: detail.slice(0, 1000),
      },
    });
    reported.push(provider);
  }

  let emailed = false;
  const to = operatorEmailAddress();
  if (to && (await claimDailyAlert(supabase, "llm-billing:email", day, detail)) === true) {
    emailed = await sendNotificationEmail({
      to,
      ...llmBillingAlertEmail({ providers, detail, pausedUntil, source: context.source }),
    });
  }

  log("error", {
    outcome: "paused",
    providers,
    paused_until: pausedUntil.toISOString(),
    source: context.source,
    job_id: context.jobId,
    job_type: context.jobType,
    step: context.step,
    reported,
    emailed,
  });

  return { pausedUntil, reported, emailed };
}

/**
 * For a cron that enqueues LLM work: the pause, logged with the reason when
 * it holds, so a skipped sweep says why in the function logs.
 */
export async function skipWhileLlmPaused(
  supabase: SupabaseClient,
  cron: string,
  now = new Date()
): Promise<Date | null> {
  const until = await llmPausedUntil(supabase, now);
  if (until) {
    log("warn", { outcome: "cron_skipped", cron, paused_until: until.toISOString() });
  }
  return until;
}
