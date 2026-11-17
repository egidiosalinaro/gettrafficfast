import type { SupabaseClient } from "@supabase/supabase-js";
import { draftCapacityDenial } from "@/lib/paid-access";
import { parseVoiceSettings } from "@/lib/voice/settings";
import { findActiveDraft, findLatestDraft, shouldResumeDraft, startDraft } from "./runs";
import { NO_REPLY_ON_LISTICLE, draftPrerequisite, takesReply } from "./workflow";

/**
 * "Generate draft" for one target, up to the moment something has to run:
 * the inbox's POST /api/placements/:id/draft and the API's `draft_reply`
 * decide here, and only how long each waits for the job differs (the route
 * runs it inline for up to 105 s; the tool waits up to 25 s and lets it
 * finish after the response).
 *
 * Ownership is checked on the caller's own client before the service-role
 * job is enqueued. The About you prerequisite and the target's status are
 * checked before anything is asked for, with the sentence the job would
 * otherwise fail with. `continue` only follows a draft already asked for
 * (it spends nothing new, so it is never refused by the cap); `start` asks
 * for a new one, under the daily draft cap, and resumes an existing job
 * instead of starting a second copy.
 */

/** Statuses a draft can be written for. */
export const DRAFTABLE_STATUSES = ["qualified", "drafted", "needs_review", "approved"] as const;

/** How the job's gate verdict is reported: never "written" when every variant was blocked. */
export interface DraftAuditSummary {
  status: string | null;
  writes: number | null;
  omitted: string[];
}

export function draftAuditOf(result: unknown): DraftAuditSummary {
  const audit = (result as { audit?: { status?: string; writes?: number; omitted?: string[] } } | null)?.audit ?? null;
  return { status: audit?.status ?? null, writes: audit?.writes ?? null, omitted: audit?.omitted ?? [] };
}

export type DraftNext =
  /** Run this job now: just enqueued, waiting, or abandoned by a killed function. */
  | { kind: "run"; jobId: string }
  /** Another request holds the job; nothing new is started. */
  | { kind: "running"; jobId: string | null }
  /** `continue` with nothing ever asked for. */
  | { kind: "idle" }
  /** The newest job ended without text. */
  | { kind: "failed"; jobId: string; lastError: string | null }
  /** The newest job finished. */
  | { kind: "completed"; jobId: string; audit: DraftAuditSummary };

export type DraftRequest =
  | { ok: true; next: DraftNext }
  | {
      ok: false;
      status: 404 | 409 | 429;
      code: "not_found" | "prerequisite_missing" | "invalid_state" | "cap_reached";
      error: string;
      settingsHref?: string;
    };

export async function requestDraft(params: {
  /** The caller's client: RLS for a session, the owner-scoped service role for an API key. */
  supabase: SupabaseClient;
  /** The service role: the job queue. */
  admin: SupabaseClient;
  userId: string;
  businessId: string;
  targetId: string;
  mode: "start" | "continue";
  /**
   * "Write it anyway" after a decline: the job skips the qualifier and the
   * drafter is told the person decided.
   */
  anyway?: boolean;
}): Promise<DraftRequest> {
  const { supabase, admin, userId, businessId, targetId: id } = params;

  const [{ data: target }, { data: business }] = await Promise.all([
    supabase.from("placement_targets").select("id, status, kind").eq("id", id).eq("business_id", businessId).maybeSingle(),
    supabase.from("businesses").select("name, voice_settings").eq("id", businessId).maybeSingle(),
  ]);
  if (!target) return { ok: false, status: 404, code: "not_found", error: "Target not found" };
  // A list article has no reply box: refused before the prerequisite, the
  // cap or a job, so nothing is spent on a text nobody could post.
  if (!takesReply((target.kind as string | null) ?? "thread")) {
    return { ok: false, status: 409, code: "invalid_state", error: NO_REPLY_ON_LISTICLE };
  }

  // The reply speaks as someone who uses the product; with nothing recorded
  // about that use there is nothing honest to write. Refused here, before a
  // job is enqueued, with the sentence the job would otherwise fail with.
  const prerequisite = draftPrerequisite(
    (business?.name as string | null) ?? "the business",
    parseVoiceSettings(business?.voice_settings)
  );
  if (prerequisite) {
    return { ok: false, status: 409, code: "prerequisite_missing", error: prerequisite, settingsHref: "/settings/voice" };
  }
  if (!(DRAFTABLE_STATUSES as readonly string[]).includes(target.status as string)) {
    return { ok: false, status: 409, code: "invalid_state", error: `A ${target.status} target cannot be drafted.` };
  }
  // No angle (a row reopened after a rejection) is not a refusal: the job
  // asks the agent that owns angles for one before it writes, or, for a
  // post a person chose and for "Write it anyway", lets the drafter pick it.

  if (params.mode === "continue") {
    const active = await findActiveDraft(admin, businessId, id);
    if (active && shouldResumeDraft(active)) return { ok: true, next: { kind: "run", jobId: active.id } };
    if (active) return { ok: true, next: { kind: "running", jobId: active.id } };
    const latest = await findLatestDraft(admin, businessId, id);
    if (!latest) return { ok: true, next: { kind: "idle" } };
    if (latest.status === "pending" || latest.status === "running") {
      return { ok: true, next: { kind: "running", jobId: latest.id } };
    }
    if (latest.status === "failed") return { ok: true, next: { kind: "failed", jobId: latest.id, lastError: latest.lastError } };
    return { ok: true, next: { kind: "completed", jobId: latest.id, audit: draftAuditOf(latest.result) } };
  }

  // A new draft only: continuing or reporting on one already asked for
  // (above) spends nothing new, so it is never refused by the cap.
  const capped = await draftCapacityDenial(admin, userId);
  if (capped) return { ok: false, status: 429, code: "cap_reached", error: capped.error };

  const started = await startDraft({ supabase: admin, userId, businessId, targetId: id, anyway: params.anyway === true });
  if (started.alreadyRunning || !started.jobId) {
    const active = await findActiveDraft(admin, businessId, id);
    // Still inside the request that took the lock: say so, and do not start
    // a second copy. A job that is only waiting, or whose worker was killed,
    // is run now. That is the click the person is still looking at.
    if (!active || !shouldResumeDraft(active)) return { ok: true, next: { kind: "running", jobId: active?.id ?? null } };
    return { ok: true, next: { kind: "run", jobId: active.id } };
  }
  return { ok: true, next: { kind: "run", jobId: started.jobId } };
}
