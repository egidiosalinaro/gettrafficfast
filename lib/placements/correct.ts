import { randomUUID } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createBudget } from "@/lib/agents/contract";
import { draftCorrectAgent, type DraftCorrectOutput } from "@/lib/agents/draft-correct";
import { runAgent, supabaseRecorder } from "@/lib/agents/runner";
import { LLM_CREDITS_RAN_OUT_MESSAGE, recordLlmBillingRefusal } from "@/lib/llm-billing";
import { isLlmBillingRefusal, llmFailureKind } from "@/lib/providers/llm/types";
import { domainOf } from "@/lib/providers/serp/types";
import { parseAeoSettings } from "@/lib/visibility/settings";
import { parseVoiceSettings } from "@/lib/voice/settings";
import { staleFacts } from "@/lib/voice/staleness";
import { auditDraft, withReading, type AuditResult, type PlacementVariant } from "./audit";
import { recordFeedback, recordRewrite } from "./feedback";
import { MAX_DRAFT_IMAGES, draftImagePlan, draftImagesRecord, loadMedia, withImages } from "./media";
import { loadReferenced, quotedImageInputs } from "./referenced";
import { placeOwnLink, siteUrl } from "./link";
import { draftAuditContext } from "./own-reply";
import { parseReading } from "./reading";
import { loadRecentReplies, recentFacts } from "./recent-facts";
import { DRAFT_COLUMNS, mapDraft, type PlacementDraftRecord } from "./read";
import { OPEN_STATUSES, bestAuditStatus, draftPrerequisite, statusAfterAudit, type TargetStatus } from "./workflow";

/**
 * "Fix with a note": the owner says why a draft is wrong, and gets it
 * rewritten that way now, judged by the same gate.
 *
 * In order: the draft, its post and the site are read through the person's
 * client (RLS and `business_id` prove they are theirs); the note is stored
 * (`draft_feedback`, before anything is paid, so a failed rewrite still
 * keeps it and the daily cap counts it); ONE model call rewrites the text
 * (`draft-correct`, $0.05 budget, little thinking, recorded in `agent_runs`);
 * the link is placed and the gate run exactly as an edit is (`placeOwnLink`,
 * `auditDraft` with `draftAuditContext`); the row is saved through the
 * person's client the way the edit route saves it, the post moves like an
 * edited one, and the rewrite is written on the note.
 *
 * Nothing is saved when the rewrite fails: the draft stays as it was, and
 * the note stays without `body_after`. A billing refusal is recorded like
 * the worker records it (pause, one alert) and told as one sentence.
 * See docs/PLACEMENTS.md, "Corrections".
 */

/** Ceiling on the one call: a short rewrite costs well under a cent. */
export const CORRECTION_BUDGET_USD = 0.05;

export const CORRECTION_FAILED_MESSAGE =
  "The rewrite failed, so the draft is unchanged. Your note is saved; try again.";
export const CORRECTION_UNAVAILABLE_MESSAGE =
  "The AI provider did not answer, so the draft is unchanged. Your note is saved; try again in a minute.";
export const NOTE_NOT_SAVED_MESSAGE = "Your note could not be saved, so nothing was rewritten. Try again.";

type Row = Record<string, unknown>;

export type CorrectDraftResult =
  | {
      ok: true;
      draft: PlacementDraftRecord;
      audit: AuditResult;
      targetStatus: TargetStatus;
      feedbackId: string;
    }
  | {
      ok: false;
      status: 404 | 409 | 500 | 503;
      error: string;
      /** Where to fix a missing prerequisite. */
      settingsHref?: string;
      /** Set once the note is stored: it is kept even when the rewrite is not. */
      feedbackId?: string;
    };

function log(level: "warn" | "error", fields: Record<string, unknown>) {
  const line = JSON.stringify({ level, event: "placement.correct", ...fields });
  if (level === "error") console.error(line);
  else console.warn(line);
}

export async function correctDraft(input: {
  /** The person's client: every read and the draft's update go through RLS. */
  supabase: SupabaseClient;
  /** The service role: the agent run record and the note's rewrite. */
  admin: SupabaseClient;
  userId: string;
  businessId: string;
  draftId: string;
  /** Already validated (FeedbackReason). */
  reason: string;
  /** The text as the person edited it, when they did; else the stored body. */
  body?: string | null;
  signal?: AbortSignal;
  now?: Date;
}): Promise<CorrectDraftResult> {
  const { supabase, admin, userId, businessId, draftId, reason } = input;

  const { data: draft } = await supabase
    .from("placements")
    .select("id, user_id, target_id, variant, body, link_url, audit")
    .eq("id", draftId)
    .eq("business_id", businessId)
    .maybeSingle();
  if (!draft || (draft.user_id as string | undefined) !== userId) {
    return { ok: false, status: 404, error: "Draft not found" };
  }
  const targetId = draft.target_id as string;

  const [{ data: target }, { data: business }, { data: keywords }, { data: entities }, mediaByTarget, referencedByTarget] = await Promise.all([
    supabase
      .from("placement_targets")
      .select("id, user_id, surface, kind, title, excerpt, author, status, qualify_angle")
      .eq("id", targetId)
      .eq("business_id", businessId)
      .maybeSingle(),
    supabase
      .from("businesses")
      .select("name, niche, website_url, aeo_settings, voice_settings, content_language")
      .eq("id", businessId)
      .eq("user_id", userId)
      .maybeSingle(),
    supabase.from("keywords").select("keyword").eq("business_id", businessId).limit(20),
    supabase.from("entities").select("name").eq("business_id", businessId).limit(20),
    // The post's images, read apart from the row (media.ts): the rewrite
    // sees them as the drafter did.
    loadMedia(supabase, businessId, [targetId]),
    // What the post quotes and replies to (referenced.ts): the rewrite reads
    // it as the drafter did, and the gate judges with it.
    loadReferenced(supabase, businessId, [targetId]),
  ]);
  if (!target || !business || (target.user_id as string | undefined) !== userId) {
    return { ok: false, status: 404, error: "Target not found" };
  }

  const status = target.status as TargetStatus;
  if (!OPEN_STATUSES.includes(status)) {
    return {
      ok: false,
      status: 409,
      error:
        status === "published_manually"
          ? "This reply is posted, and its text is the record of what went out, so it is not rewritten."
          : `A ${status} post takes no correction.`,
    };
  }

  const homepage = siteUrl(business.website_url as string | null);
  const name = ((business.name as string | null) ?? "").trim() || (homepage ? domainOf(homepage) : "") || "the business";
  const voice = parseVoiceSettings(business.voice_settings);
  // A rewrite is a model writing as the owner, like a draft: with nothing
  // recorded about the writer there is nothing honest to write.
  const prerequisite = draftPrerequisite(name, voice);
  if (prerequisite) return { ok: false, status: 409, error: prerequisite, settingsHref: "/settings/voice" };

  const variant = draft.variant as PlacementVariant;
  const surface = target.surface as string;
  const before = input.body?.trim() || (draft.body as string);
  // What the drafter thought the post meant, kept beside the draft's audit.
  const storedReading = parseReading((draft.audit as { reading?: unknown } | null)?.reading);

  const stored = await recordFeedback(supabase, {
    userId,
    businessId,
    targetId,
    placementId: draftId,
    reason,
    bodyBefore: before,
    now: input.now,
  });
  if (!stored.ok) {
    // The note is the record of the call and what the daily cap counts:
    // without it, nothing is paid for.
    log("error", { outcome: "note_not_saved", draft_id: draftId, error: stored.error });
    return { ok: false, status: 500, error: NOTE_NOT_SAVED_MESSAGE };
  }
  const feedbackId = stored.id;

  // One clock for the request: which dated facts are stale for the rewrite,
  // and for the gate that judges it.
  const clock = input.now ?? new Date();
  const imagePlan = draftImagePlan(mediaByTarget?.get(targetId) ?? { media: null, unread: null });
  const referenced = referencedByTarget?.get(targetId) ?? null;
  const quotedImages = quotedImageInputs(referenced, MAX_DRAFT_IMAGES - imagePlan.images.length);
  // Which About you sentences the last ten replies used, this post's own
  // drafts aside: the rewrite is told not to use them again, and the gate's
  // advisory check "Repeats a recent fact" judges it (12 November 2026).
  // Two reads through the person's client; nothing read back from X.
  const recent = recentFacts(await loadRecentReplies(supabase, { businessId, excludeTargetId: targetId }), voice.aboutYou, clock);
  let rewritten: DraftCorrectOutput;
  try {
    rewritten = await runAgent(
      draftCorrectAgent,
      {
        business: { name, site: homepage, niche: (business.niche as string | null) ?? null },
        thread: {
          surface,
          kind: (target.kind as string) || "thread",
          title: (target.title as string) || "(untitled)",
          excerpt: (target.excerpt as string | null) ?? "",
          author: (target.author as string | null) ?? null,
        },
        referenced,
        variant,
        draft: before,
        reason,
        aboutYou: voice.aboutYou,
        notes: voice.instructions,
        reading: storedReading,
        staleFacts: staleFacts(voice.aboutYou, clock, { confirmations: voice.confirmedFacts }).map(({ sentence, dateLabel }) => ({ sentence, dateLabel })),
        recentFacts: recent,
        images: [...imagePlan.images, ...quotedImages],
        unseenImages: imagePlan.unseen,
      },
      {
        userId,
        businessId,
        language: (business.content_language as string | null) ?? "en",
        runId: randomUUID(),
        budget: createBudget(CORRECTION_BUDGET_USD),
        signal: input.signal,
      },
      // agent_runs has no insert policy for users: the run is recorded by
      // the service role, with the user and the site on the row.
      supabaseRecorder(admin)
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isLlmBillingRefusal(err)) {
      await recordLlmBillingRefusal(admin, err, { source: "api.placements.drafts.correct" });
      return { ok: false, status: 503, error: LLM_CREDITS_RAN_OUT_MESSAGE, feedbackId };
    }
    log("error", { outcome: "rewrite_failed", draft_id: draftId, feedback_id: feedbackId, error: message.slice(0, 500) });
    if (llmFailureKind(message) === "unavailable") {
      return { ok: false, status: 503, error: CORRECTION_UNAVAILABLE_MESSAGE, feedbackId };
    }
    return { ok: false, status: 500, error: CORRECTION_FAILED_MESSAGE, feedbackId };
  }

  // Saved the way an edit is: the link placed by code where the variant
  // carries one, then the same gate with the same context.
  const settings = parseAeoSettings(business.aeo_settings);
  const placed = placeOwnLink({
    body: rewritten.body,
    variant,
    surface,
    requested: (draft.link_url as string | null) ?? null,
    homepage,
    names: [(business.name as string | null) ?? "", ...settings.brandNames],
  });
  // The gate, told the note: a rewrite that quotes it, answers it or keeps
  // what it ruled out is refused. The reading the correction leaves
  // standing replaces the stored one; with none returned, the old one stays.
  // What the rewrite saw of the post's images replaces what the draft saw.
  const audit = withImages(
    withReading(
      auditDraft(
        { variant, body: placed.body, linkUrl: placed.linkUrl, claims: rewritten.claims },
        { ...draftAuditContext({ target, business, keywords, entities, referenced }, clock), correction: reason, recentFacts: recent }
      ),
      rewritten.reading ?? storedReading
    ),
    draftImagesRecord(imagePlan, rewritten.images)
  );

  const at = clock.toISOString();
  const { data: updated, error } = await supabase
    .from("placements")
    .update({
      body: placed.body,
      link_url: placed.linkUrl,
      claims: rewritten.claims,
      audit,
      audit_status: audit.status,
      updated_at: at,
    })
    .eq("id", draftId)
    .eq("business_id", businessId)
    .select(DRAFT_COLUMNS)
    .maybeSingle();
  if (error) return { ok: false, status: 500, error: error.message, feedbackId };
  if (!updated) return { ok: false, status: 404, error: "Draft not found", feedbackId };

  // A post waiting in needs_review moves on once one of its drafts passes;
  // one already approved is left alone. The same move as an edit.
  let targetStatus = status;
  if (status === "drafted" || status === "needs_review") {
    const { data: siblings } = await supabase
      .from("placements")
      .select("audit_status")
      .eq("target_id", targetId)
      .eq("business_id", businessId);
    const statuses = ((siblings ?? []) as Row[]).map((s) => s.audit_status as string);
    targetStatus = statusAfterAudit(bestAuditStatus(statuses.length > 0 ? statuses : [audit.status]));
    if (targetStatus !== status) {
      await supabase
        .from("placement_targets")
        .update({ status: targetStatus, updated_at: at })
        .eq("id", targetId)
        .eq("business_id", businessId);
    }
  }

  await recordRewrite(admin, { id: feedbackId, userId, businessId, bodyAfter: placed.body });

  const saved = mapDraft(updated as Row);
  return { ok: true, draft: saved, audit: saved.audit, targetStatus, feedbackId };
}
