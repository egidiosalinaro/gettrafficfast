import { after } from "next/server";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { MANUAL_ACTIONS, isTargetStatus, planManualAction, type ManualActionInput } from "./workflow";
import { mapTarget, TARGET_COLUMNS, type PlacementTargetRecord } from "./read";
import { capturePublishedText } from "./published-text";
import { loadMedia, withMedia } from "./media";
import { loadReferenced, withReferenced } from "./referenced";
import { loadRemovals, withRemoval } from "./removed";
import { loadLinkSearches, withLinkSearch } from "./reply-link";

/**
 * The manual workflow on one target: I posted it, add the reply's link, it
 * was removed (and its Undo), skip, snooze, bring back (and approve, kept
 * for a tab open across a deploy). One function, so the inbox's action
 * route and the API's tools (`mark_reply_posted`, `set_reply_link`,
 * `mark_reply_removed`, `unmark_reply_removed`, `snooze_reply_target`,
 * `dismiss_reply_target`, `reopen_reply_target`) make the same move.
 *
 * Every move is planned by `planManualAction` (workflow.ts) before the row
 * is touched, and the row is touched through the caller's own client, so
 * RLS (or, for an API key, the owner-scoped client) is the access control
 * and `business_id` the scope. "I posted it" takes no link since
 * 2026-11-08; the link to the person's own reply comes later through
 * `set_published_url`, only on a posted row, checked by `checkPublishedUrl`.
 *
 * Once a link is saved, the reply's text is read back from X after the
 * response has gone (`after`, `capturePublishedText`): the owner edits
 * drafts on X before posting, and the voice the drafts learn from is what
 * he published. It never delays or fails the action; a link that changes
 * clears the text read from the old one.
 *
 * GTF saves a link it found on X through the same move (`set_published_url`,
 * reply-link-search.ts), with `requireNoLink`: only while the reply still has
 * none, so a link the person saved a moment earlier is never replaced.
 */

export const TARGET_GONE = "This post is no longer in your inbox.";

/** The answer when a found link arrives after the person saved one. */
export const LINK_ALREADY_SAVED = "This reply already has its link.";

/** The body the action route accepts, shared with the tools that make the same moves. */
export const ManualActionBody = z.object({
  action: z.enum(MANUAL_ACTIONS),
  note: z.string().trim().max(1000).optional(),
  reason: z.string().trim().max(300).optional(),
  // Checked by `checkPublishedUrl` once the target is known, so a refusal
  // is a sentence about this thread's surface, not a schema message.
  publishedUrl: z.string().nullable().optional(),
  publishedAt: z.string().datetime().optional(),
  aeoQueryId: z.string().uuid().nullable().optional(),
  placementId: z.string().uuid().nullable().optional(),
  snoozeDays: z.number().int().min(1).max(90).optional(),
});

export type ApplyManualActionResult =
  | { ok: true; target: PlacementTargetRecord }
  | { ok: false; status: 400 | 404 | 409 | 500; error: string };

export async function applyManualAction(params: {
  /** The caller's client: RLS for a session, the owner-scoped service role for an API key. */
  supabase: SupabaseClient;
  businessId: string;
  targetId: string;
  input: ManualActionInput;
  now?: Date;
  /**
   * Save only while the row has no link (a link GTF found on X): a row that
   * got one in the meantime is left as it is, and the answer is a 409.
   */
  requireNoLink?: boolean;
}): Promise<ApplyManualActionResult> {
  const { supabase, businessId, targetId: id, input } = params;

  const { data: current } = await supabase
    .from("placement_targets")
    .select("id, status, surface, url, published_url")
    .eq("id", id)
    .eq("business_id", businessId)
    .maybeSingle();
  if (!current || !isTargetStatus(current.status)) return { ok: false, status: 404, error: TARGET_GONE };

  // Read apart from the row (removed.ts): only the removal moves need it,
  // and a database without the column refuses them and nothing else.
  let removedAt: string | null = null;
  if (input.action === "mark_removed" || input.action === "unmark_removed" || input.action === "unmark_published") {
    const removals = await loadRemovals(supabase, businessId, [id]);
    if (!removals) return { ok: false, status: 500, error: "Removed replies cannot be recorded yet. Try again in a few minutes." };
    removedAt = removals.get(id)?.removedAt ?? null;
  }

  const plan = planManualAction(
    {
      status: current.status,
      surface: String(current.surface),
      url: String(current.url),
      removedAt,
      publishedUrl: typeof current.published_url === "string" ? current.published_url : null,
    },
    input,
    params.now
  );
  if (!plan.ok) return { ok: false, status: plan.httpStatus, error: plan.error };
  const patch = plan.patch;
  const savedUrl = typeof patch.published_url === "string" ? patch.published_url : null;
  const previousUrl = typeof current.published_url === "string" ? current.published_url : null;

  // The AEO query, when given, must belong to the same site: a foreign id
  // simply does not exist through this client, and the update is refused.
  if (input.aeoQueryId) {
    const { data: query } = await supabase
      .from("aeo_queries")
      .select("id")
      .eq("id", input.aeoQueryId)
      .eq("business_id", businessId)
      .maybeSingle();
    if (!query) return { ok: false, status: 400, error: "Unknown AEO query for this site" };
  }
  if (input.placementId) {
    const { data: draft } = await supabase
      .from("placements")
      .select("id")
      .eq("id", input.placementId)
      .eq("target_id", id)
      .maybeSingle();
    if (!draft) return { ok: false, status: 400, error: "Unknown draft for this target" };
  }

  if (params.requireNoLink && previousUrl?.trim()) return { ok: false, status: 409, error: LINK_ALREADY_SAVED };
  let update = supabase.from("placement_targets").update(patch).eq("id", id).eq("business_id", businessId);
  if (params.requireNoLink) update = update.is("published_url", null);
  const { data, error } = await update.select(TARGET_COLUMNS).maybeSingle();
  if (error) return { ok: false, status: 500, error: error.message };
  if (!data) return params.requireNoLink ? { ok: false, status: 409, error: LINK_ALREADY_SAVED } : { ok: false, status: 404, error: TARGET_GONE };

  // The row is the person's: their own client just updated it. The read-back
  // runs once the answer has gone, through the service role, since the
  // person's session cookies cannot be refreshed after the response.
  if (savedUrl) capturePublishedTextAfter(id, savedUrl, previousUrl);
  // The card keeps its Removed badge, or loses it, with the answer, and
  // whether GTF is looking for the reply's link on X.
  const [removals, media, referenced, searches] = await Promise.all([
    loadRemovals(supabase, businessId, [id]),
    loadMedia(supabase, businessId, [id]),
    loadReferenced(supabase, businessId, [id]),
    loadLinkSearches(supabase, [id]),
  ]);
  return {
    ok: true,
    target: mapTarget(
      withLinkSearch(withReferenced(withMedia(withRemoval(data as Record<string, unknown>, removals), media), referenced), searches)
    ),
  };
}

/**
 * Schedules the read-back of the reply's text. Whatever happens here (no
 * request scope, no service-role key), the person's action already
 * succeeded: the failure is logged and `ensurePublishedText` reads it later.
 */
export function capturePublishedTextAfter(targetId: string, url: string, previousUrl: string | null) {
  const warn = (error: unknown) =>
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "placements.published_text_not_scheduled",
        target_id: targetId,
        error: error instanceof Error ? error.message.slice(0, 300) : String(error),
      })
    );
  try {
    after(async () => {
      try {
        await capturePublishedText(createAdminClient(), targetId, url, { previousUrl });
      } catch (error) {
        warn(error);
      }
    });
  } catch (error) {
    warn(error);
  }
}
