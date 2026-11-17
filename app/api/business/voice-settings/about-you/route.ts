import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { NO_BUSINESS_RESPONSE, selectedBusinessId } from "@/lib/tenancy";
import { recheckDraft } from "@/lib/placements/edit";
import { ABOUT_YOU_FACT_MAX, addAboutYouFact, confirmAboutYouFact, removeAboutYouFact } from "@/lib/voice/about-you";
import { ABOUT_YOU_MAX, ConfirmedOn } from "@/lib/voice/settings";

/**
 * "It's true: add to About you" (lib/voice/about-you.ts), the screen's side
 * of `add_about_you_fact` and `remove_about_you_fact`.
 *
 * POST `{ fact, draftId? }` appends one fact the person confirmed; with a
 * draft, its text is judged again, unchanged, and the draft comes back with
 * the new audit. The draft is looked up first, so a draft that is not this
 * site's adds nothing. DELETE `{ fact, ifAboutYouIs? }` is the Undo.
 *
 * PATCH `{ sentence }` is "Still true" on Today (2026-11-14,
 * `confirm_about_you_fact`): the day that dated sentence was confirmed is
 * recorded in `confirmedFacts`, so it is not asked about for another 30
 * days. About you is not written: the sentence stays as the person wrote
 * it. Its Undo is PATCH `{ sentence, undo: { previousConfirmedOn } }`, the
 * value the confirmation answered: that one entry is put back (removed when
 * null).
 */

const AddBody = z.object({
  fact: z.string().trim().min(1).max(ABOUT_YOU_FACT_MAX),
  draftId: z.string().uuid().optional(),
});

const ConfirmBody = z.object({
  sentence: z.string().trim().min(1).max(ABOUT_YOU_MAX),
  undo: z.object({ previousConfirmedOn: ConfirmedOn.nullable() }).optional(),
});

const RemoveBody = z.object({
  fact: z.string().trim().min(1).max(ABOUT_YOU_FACT_MAX),
  ifAboutYouIs: z.string().max(ABOUT_YOU_MAX).optional(),
});

function invalid(error: z.ZodError) {
  return NextResponse.json(
    { error: error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ") },
    { status: 400 }
  );
}

async function caller() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { supabase, user: null, businessId: null } as const;
  return { supabase, user, businessId: await selectedBusinessId(supabase, user.id) } as const;
}

export async function POST(request: NextRequest) {
  const { supabase, user, businessId } = await caller();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!businessId) return NextResponse.json(NO_BUSINESS_RESPONSE, { status: 409 });

  const parsed = AddBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return invalid(parsed.error);

  if (parsed.data.draftId) {
    const { data: draft } = await supabase
      .from("placements")
      .select("id")
      .eq("id", parsed.data.draftId)
      .eq("business_id", businessId)
      .maybeSingle();
    if (!draft) return NextResponse.json({ error: "Draft not found" }, { status: 404 });
  }

  const added = await addAboutYouFact({ supabase, userId: user.id, businessId, fact: parsed.data.fact });
  if (!added.ok) return NextResponse.json({ error: added.error }, { status: added.status });
  const out = { aboutYou: added.aboutYou, fact: added.fact, added: added.changed };
  if (!parsed.data.draftId) return NextResponse.json(out);

  const checked = await recheckDraft({ supabase, businessId, draftId: parsed.data.draftId });
  if (!checked.ok) return NextResponse.json({ ...out, error: checked.error }, { status: checked.status });
  return NextResponse.json({ ...out, draft: checked.draft, targetStatus: checked.targetStatus });
}

export async function DELETE(request: NextRequest) {
  const { supabase, user, businessId } = await caller();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!businessId) return NextResponse.json(NO_BUSINESS_RESPONSE, { status: 409 });

  const parsed = RemoveBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return invalid(parsed.error);

  const removed = await removeAboutYouFact({
    supabase,
    userId: user.id,
    businessId,
    fact: parsed.data.fact,
    ifAboutYouIs: parsed.data.ifAboutYouIs,
  });
  if (!removed.ok) return NextResponse.json({ error: removed.error }, { status: removed.status });
  return NextResponse.json({ aboutYou: removed.aboutYou, removed: removed.changed });
}

export async function PATCH(request: NextRequest) {
  const { supabase, user, businessId } = await caller();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!businessId) return NextResponse.json(NO_BUSINESS_RESPONSE, { status: 409 });

  const parsed = ConfirmBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return invalid(parsed.error);

  const confirmed = await confirmAboutYouFact({
    supabase,
    userId: user.id,
    businessId,
    sentence: parsed.data.sentence,
    undo: parsed.data.undo,
  });
  if (!confirmed.ok) return NextResponse.json({ error: confirmed.error }, { status: confirmed.status });
  return NextResponse.json({
    fact: confirmed.fact,
    confirmedOn: confirmed.confirmedOn,
    previousConfirmedOn: confirmed.previousConfirmedOn,
    changed: confirmed.changed,
  });
}
