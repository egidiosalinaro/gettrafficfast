import type { SupabaseClient } from "@supabase/supabase-js";
import { domainOf } from "@/lib/providers/serp/types";
import { parseAeoSettings } from "@/lib/visibility/settings";
import { parseVoiceSettings } from "@/lib/voice/settings";
import { auditDraft, type AuditContext, type PlacementVariant } from "./audit";
import { siteUrl } from "./link";
import { DRAFT_COLUMNS, mapDraft, type PlacementDraftRecord } from "./read";
import { excerptWithReferenced, loadReferenced, type ReferencedPosts } from "./referenced";
import {
  HUMAN_WRITTEN_AGENT_VERSION,
  NO_REPLY_ON_LISTICLE,
  OPEN_STATUSES,
  bestAuditStatus,
  statusAfterAudit,
  takesReply,
  type TargetStatus,
} from "./workflow";

/**
 * "Write your own": the reply a person typed in the empty box of a card
 * with no draft, stored before it goes out.
 *
 * It used to go straight to X, so nothing recorded what was posted and
 * "I posted it" had no draft to point at. Now Reply on X saves it first,
 * the way an edited draft is saved: one `placements` row, variant
 * `short_comment`, owned by the person, `agent_version` =
 * HUMAN_WRITTEN_AGENT_VERSION, and judged by the same gate (`auditDraft`)
 * as every other draft. No model is called.
 *
 * The person's client reads (RLS proves the target and the site are theirs);
 * the service role writes the row, because `placements` has no insert policy
 * for authenticated users: drafts are otherwise the drafting job's to create.
 * A second save on the same target replaces the earlier own reply rather than
 * stacking copies of it.
 */

export const OWN_REPLY_VARIANT: PlacementVariant = "short_comment";

/** The same ceiling the edit route puts on a draft. */
export const OWN_REPLY_MAX = 20_000;

type Row = Record<string, unknown>;

/** The rows the gate reads, as the routes load them. */
export interface AuditContextRows {
  target: Row;
  business: Row;
  keywords: Row[] | null;
  entities: Row[] | null;
  /**
   * What the post quotes and replies to (lib/placements/referenced.ts): read
   * beside the post by the checks that compare a reply with it, so a reply
   * about the quoted post is on topic. Absent or null: the post alone.
   */
  referenced?: ReferencedPosts | null;
}

/**
 * The gate's context for a draft on `target`: the thread, the business and
 * its domains, the expertise it may claim, and what is recorded about the
 * writer. One builder, so the edit route and the own reply judge alike.
 */
export function draftAuditContext({ target, business, keywords, entities, referenced }: AuditContextRows, now?: Date): AuditContext {
  const settings = parseAeoSettings(business.aeo_settings);
  const homepage = siteUrl(business.website_url as string | null);
  const site = homepage ? domainOf(homepage) : "";
  const voice = parseVoiceSettings(business.voice_settings);
  return {
    thread: {
      surface: target.surface as string,
      kind: (target.kind as string) || "thread",
      title: target.title as string,
      excerpt: excerptWithReferenced((target.excerpt as string | null) ?? null, referenced ?? null),
    },
    business: {
      name: (business.name as string | null) ?? "",
      domains: [site, ...settings.domains].filter(Boolean),
      brandNames: settings.brandNames,
    },
    angle: (target.qualify_angle as string | null) ?? null,
    expertise: [
      ...(keywords ?? []).map((k) => k.keyword as string),
      ...(entities ?? []).map((e) => e.name as string),
    ],
    // The notes too: an edit is judged against the same lowercase rule as the draft.
    // The confirmations only decide which dated facts are stale.
    writer: { aboutYou: voice.aboutYou, instructions: voice.instructions, confirmedFacts: voice.confirmedFacts },
    // The clock for a dated fact stated as current (lib/placements/fact-fit.ts).
    now,
  };
}

export type SaveOwnReplyResult =
  | { ok: true; draft: PlacementDraftRecord; targetStatus: TargetStatus }
  | { ok: false; status: 400 | 404 | 409 | 500; error: string };

export async function saveOwnReply(input: {
  /** The person's client: every read goes through RLS. */
  supabase: SupabaseClient;
  /** The service role, for the insert alone. */
  admin: SupabaseClient;
  userId: string;
  businessId: string;
  targetId: string;
  body: string;
  now?: Date;
}): Promise<SaveOwnReplyResult> {
  const { supabase, admin, userId, businessId, targetId } = input;
  const body = input.body.trim();
  if (!body) return { ok: false, status: 400, error: "Write your reply first." };
  if (body.length > OWN_REPLY_MAX) {
    return { ok: false, status: 400, error: `A reply is at most ${OWN_REPLY_MAX.toLocaleString("en-US")} characters.` };
  }

  const [{ data: target }, { data: business }, { data: keywords }, { data: entities }, referenced] = await Promise.all([
    supabase
      .from("placement_targets")
      .select("id, user_id, surface, kind, title, excerpt, status, qualify_angle")
      .eq("id", targetId)
      .eq("business_id", businessId)
      .maybeSingle(),
    supabase
      .from("businesses")
      .select("name, website_url, aeo_settings, voice_settings")
      .eq("id", businessId)
      .eq("user_id", userId)
      .maybeSingle(),
    supabase.from("keywords").select("keyword").eq("business_id", businessId).limit(20),
    supabase.from("entities").select("name").eq("business_id", businessId).limit(20),
    loadReferenced(supabase, businessId, [targetId]),
  ]);
  if (!target || !business || (target.user_id as string | undefined) !== userId) {
    return { ok: false, status: 404, error: "Target not found" };
  }
  if (!takesReply((target.kind as string | null) ?? "thread")) {
    return { ok: false, status: 409, error: NO_REPLY_ON_LISTICLE };
  }
  const status = target.status as TargetStatus;
  if (!OPEN_STATUSES.includes(status)) {
    return { ok: false, status: 409, error: `A ${status} post does not take a new reply.` };
  }

  const at = input.now ?? new Date();
  // A reply carries no link and names no product: nothing is placed in it.
  // A URL the person typed stays, for the gate to flag, and the card shows why.
  const audit = auditDraft(
    { variant: OWN_REPLY_VARIANT, body, linkUrl: null, claims: [] },
    draftAuditContext({ target, business, keywords, entities, referenced: referenced?.get(targetId) ?? null }, at)
  );

  // One own reply per target: a second save replaces the first.
  const { error: clearError } = await admin
    .from("placements")
    .delete()
    .eq("target_id", targetId)
    .eq("business_id", businessId)
    .eq("agent_version", HUMAN_WRITTEN_AGENT_VERSION);
  if (clearError) return { ok: false, status: 500, error: clearError.message };

  const { data: inserted, error } = await admin
    .from("placements")
    .insert({
      user_id: userId,
      business_id: businessId,
      target_id: targetId,
      variant: OWN_REPLY_VARIANT,
      body,
      link_url: null,
      claims: [],
      audit,
      audit_status: audit.status,
      agent_version: HUMAN_WRITTEN_AGENT_VERSION,
      created_at: at.toISOString(),
      updated_at: at.toISOString(),
    })
    .select(DRAFT_COLUMNS)
    .single();
  if (error || !inserted) return { ok: false, status: 500, error: error?.message ?? "Could not save the reply." };

  // The same move the drafting job makes: a post with a reply on it is
  // drafted, or waits for review when nothing on it passes. An approved one
  // is left where the person put it.
  let targetStatus = status;
  if (status === "qualified" || status === "drafted" || status === "needs_review") {
    const { data: siblings } = await supabase
      .from("placements")
      .select("audit_status")
      .eq("target_id", targetId)
      .eq("business_id", businessId);
    const statuses = (siblings ?? []).map((s) => s.audit_status as string);
    targetStatus = statusAfterAudit(bestAuditStatus(statuses.length > 0 ? statuses : [audit.status]));
    if (targetStatus !== status) {
      await supabase
        .from("placement_targets")
        .update({ status: targetStatus, updated_at: at.toISOString() })
        .eq("id", targetId)
        .eq("business_id", businessId);
    }
  }

  return { ok: true, draft: mapDraft(inserted as Row), targetStatus };
}
