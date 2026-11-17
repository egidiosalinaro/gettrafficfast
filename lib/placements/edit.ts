import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { domainOf } from "@/lib/providers/serp/types";
import { isCompanySource } from "@/lib/domain/source-matching";
import { parseAeoSettings } from "@/lib/visibility/settings";
import { auditDraft, withReading, type DraftClaim, type PlacementVariant } from "./audit";
import { parseDraftImages, withImages } from "./media";
import { parseReading } from "./reading";
import { loadReferenced } from "./referenced";
import { linkTheName, ownLinkIn, siteUrl, variantCarriesLink } from "./link";
import { DRAFT_COLUMNS, mapDraft, type PlacementDraftRecord } from "./read";
import { draftAuditContext } from "./own-reply";
import { bestAuditStatus, statusAfterAudit, type TargetStatus } from "./workflow";

/**
 * Editing a draft: the inbox's PATCH /api/placements/drafts/:id and the
 * API's `edit_reply_draft`. The gate runs again on every save, so the
 * checklist shown beside the text always describes the text: a reviewer
 * who fixes the one failing line sees it turn green, and a reviewer who
 * adds a second link sees it turn red. The audit is deterministic and free,
 * so there is no reason not to run it every time.
 *
 * A reply carries no link and names no product, so a save never adds one:
 * the link field is ignored and a URL the person pasted stays, for the gate
 * to refuse. In the variants that do carry the link (the list entry and the
 * article) it is placed by code, not typed by hand: the link field names the
 * page (empty means the site itself), and on save the URL is put on the
 * first mention of the business in the text, in the form the surface
 * renders, unless the text already carries a link to the site.
 */

export const EDIT_BODY_MAX = 20_000;

/** The edit's input, shared by the route and the tool. */
export const EditDraftBody = z.object({
  body: z.string().trim().min(1).max(EDIT_BODY_MAX),
  linkUrl: z.string().trim().url().max(2000).nullable().optional(),
});

export type EditDraftResult =
  | { ok: true; draft: PlacementDraftRecord; targetStatus: TargetStatus }
  | { ok: false; status: 404 | 500; error: string };

export async function editDraft(params: {
  /** The caller's client: RLS for a session, the owner-scoped service role for an API key. */
  supabase: SupabaseClient;
  businessId: string;
  draftId: string;
  body: string;
  linkUrl?: string | null;
  now?: Date;
}): Promise<EditDraftResult> {
  const { supabase, businessId, draftId: id } = params;

  const { data: draft } = await supabase
    .from("placements")
    .select("id, target_id, variant, claims, audit")
    .eq("id", id)
    .eq("business_id", businessId)
    .maybeSingle();
  if (!draft) return { ok: false, status: 404, error: "Draft not found" };

  const [{ data: target }, { data: business }, { data: keywords }, { data: entities }, referenced] = await Promise.all([
    supabase
      .from("placement_targets")
      .select("id, surface, kind, title, excerpt, status, qualify_angle")
      .eq("id", draft.target_id as string)
      .eq("business_id", businessId)
      .maybeSingle(),
    supabase.from("businesses").select("name, website_url, aeo_settings, voice_settings").eq("id", businessId).maybeSingle(),
    supabase.from("keywords").select("keyword").eq("business_id", businessId).limit(20),
    supabase.from("entities").select("name").eq("business_id", businessId).limit(20),
    // What the post quotes and answers: judged with the post, as the draft was.
    loadReferenced(supabase, businessId, [draft.target_id as string]),
  ]);
  if (!target || !business) return { ok: false, status: 404, error: "Target not found" };

  const settings = parseAeoSettings(business.aeo_settings);
  const homepage = siteUrl(business.website_url as string | null);
  const site = homepage ? domainOf(homepage) : "";
  const ours = (url: string) => Boolean(site) && isCompanySource(domainOf(url), site);

  // The link, where the variant carries one: what the person typed if it is
  // the site's own, else the one the text already carries, else the
  // homepage. Then placed on the name. A reply never gets one inserted: the
  // 21 replies published with the name and its link read as adverts. A URL
  // the person pasted stays, and the gate refuses the draft until it is gone.
  let body = params.body;
  let linkUrl = params.linkUrl ?? null;
  if (!variantCarriesLink(draft.variant as PlacementVariant, target.surface as string)) {
    linkUrl = null;
  } else {
    if (!linkUrl) linkUrl = ownLinkIn(body, site) ?? homepage;
    if (linkUrl && ours(linkUrl) && !ownLinkIn(body, site)) {
      body = linkTheName(body, [(business.name as string | null) ?? "", ...settings.brandNames], linkUrl, target.surface as string);
    }
  }

  // The post has not changed, so how it was read stays beside the new verdict,
  // and so does what the drafter saw of its images (and the check that says).
  const stored = draft.audit as { reading?: unknown; images?: unknown } | null;
  const audit = withImages(
    withReading(
      auditDraft(
        {
          variant: draft.variant as PlacementVariant,
          body,
          linkUrl,
          claims: Array.isArray(draft.claims) ? (draft.claims as DraftClaim[]) : [],
        },
        draftAuditContext(
          { target, business, keywords, entities, referenced: referenced?.get(draft.target_id as string) ?? null },
          params.now ?? new Date()
        )
      ),
      parseReading(stored?.reading)
    ),
    parseDraftImages(stored?.images)
  );

  const now = (params.now ?? new Date()).toISOString();
  const { data: updated, error } = await supabase
    .from("placements")
    .update({ body, link_url: linkUrl, audit, audit_status: audit.status, updated_at: now })
    .eq("id", id)
    .eq("business_id", businessId)
    .select(DRAFT_COLUMNS)
    .maybeSingle();
  if (error) return { ok: false, status: 500, error: error.message };
  if (!updated) return { ok: false, status: 404, error: "Draft not found" };

  // A target waiting in needs_review moves on once one of its drafts passes;
  // one already approved or published is left alone.
  let targetStatus = target.status as TargetStatus;
  if (["drafted", "needs_review"].includes(targetStatus)) {
    const { data: siblings } = await supabase
      .from("placements")
      .select("audit_status")
      .eq("target_id", draft.target_id as string);
    targetStatus = statusAfterAudit(bestAuditStatus((siblings ?? []).map((s) => s.audit_status as string)));
    await supabase
      .from("placement_targets")
      .update({ status: targetStatus, updated_at: now })
      .eq("id", draft.target_id as string)
      .eq("business_id", businessId);
  }

  return { ok: true, draft: mapDraft(updated as Record<string, unknown>), targetStatus };
}

/**
 * "Check again" on the text as it is stored: the gate judges the same body
 * and link once more, against the voice as it is now. Nothing is rewritten.
 * What "It's true: add to About you" runs after the fact is saved, so the
 * draft's checklist says whether the confirmed fact settled it
 * (lib/voice/about-you.ts).
 */
export async function recheckDraft(params: {
  supabase: SupabaseClient;
  businessId: string;
  draftId: string;
  now?: Date;
}): Promise<EditDraftResult> {
  const { data: draft } = await params.supabase
    .from("placements")
    .select("id, body, link_url")
    .eq("id", params.draftId)
    .eq("business_id", params.businessId)
    .maybeSingle();
  if (!draft) return { ok: false, status: 404, error: "Draft not found" };
  return editDraft({
    supabase: params.supabase,
    businessId: params.businessId,
    draftId: params.draftId,
    body: String(draft.body ?? ""),
    linkUrl: (draft.link_url as string | null) ?? null,
    now: params.now,
  });
}
