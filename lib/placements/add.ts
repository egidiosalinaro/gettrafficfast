import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DAILY_DRAFT_CAP, draftCapacityDenial } from "@/lib/paid-access";
import { parseVoiceSettings } from "@/lib/voice/settings";
import { addPostByHand, type AddOutcome } from "./manual";
import type { PlacementTargetRecord } from "./read";
import { startDraft } from "./runs";
import { draftPrerequisite } from "./workflow";

/**
 * "Add a post from X", whole: the post into the site's inbox
 * (`addPostByHand`, manual.ts), then its draft started. The inbox's
 * POST /api/placements/add and the API's `add_x_post` both call this.
 *
 * The draft is enqueued here, not run: the card appears at once and follows
 * the job the way "Generate draft" does, and the worker tick finishes it if
 * nobody follows it. The About you prerequisite is checked first, with the
 * same sentence: the post is kept, and nothing is enqueued that would fail.
 * The daily draft cap likewise keeps the post and holds only the draft.
 */

/** The add's input, shared by the route and the tool. */
export const AddXPostBody = z.object({
  url: z.string().max(2_000),
  // Only needed when X will not hand the post over. X Premium posts run to 25,000 characters.
  text: z.string().max(25_000).nullable().optional(),
});

export interface AddedDraft {
  started: boolean;
  jobId: string | null;
  error: string | null;
  settingsHref?: string;
}

export type AddXPostResult =
  | { ok: false; code: "not_x_post" | "text_needed"; error: string }
  | { ok: true; outcome: AddOutcome; textFrom: "x" | "pasted" | "stored"; target: PlacementTargetRecord; draft: AddedDraft };

export async function addXPost(params: {
  /** The caller's client: RLS for a session, the owner-scoped service role for an API key. */
  supabase: SupabaseClient;
  /** The service role: the target insert and the job queue. */
  admin: SupabaseClient;
  userId: string;
  businessId: string;
  url: string;
  pastedText?: string | null;
}): Promise<AddXPostResult> {
  const { supabase, admin, userId, businessId } = params;
  const added = await addPostByHand({
    supabase,
    admin,
    userId,
    businessId,
    url: params.url,
    pastedText: params.pastedText ?? null,
  });
  if (!added.ok) return added;

  let draft: AddedDraft = { started: false, jobId: null, error: null };
  if (added.draftable) {
    const { data: business } = await supabase
      .from("businesses")
      .select("name, voice_settings")
      .eq("id", businessId)
      .maybeSingle();
    const prerequisite = draftPrerequisite(
      (business?.name as string | null) ?? "the business",
      parseVoiceSettings(business?.voice_settings)
    );
    if (prerequisite) {
      draft = { started: false, jobId: null, error: prerequisite, settingsHref: "/settings/voice" };
    } else if (await draftCapacityDenial(admin, userId)) {
      // The post is kept; only the draft waits for the daily cap to reopen.
      draft = {
        started: false,
        jobId: null,
        error: `You have reached today's limit of ${DAILY_DRAFT_CAP} drafts. The post is saved; start its draft tomorrow.`,
      };
    } else {
      const started = await startDraft({ supabase: admin, userId, businessId, targetId: added.target.id });
      draft = { started: true, jobId: started.jobId, error: null };
    }
  }

  return { ok: true, outcome: added.outcome, textFrom: added.textFrom, target: added.target, draft };
}
