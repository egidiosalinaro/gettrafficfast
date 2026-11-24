import { z } from "zod";
import { updateVoiceSettings as saveVoiceChange } from "@/lib/business/save-settings";
import { recheckDraft } from "@/lib/placements/edit";
import { promoteToNotes } from "@/lib/placements/feedback";
import { TARGET_STATUSES } from "@/lib/placements/workflow";
import { ABOUT_YOU_FACT_MAX, addAboutYouFact, confirmAboutYouFact, removeAboutYouFact } from "@/lib/voice/about-you";
import { ABOUT_YOU_MAX, ConfirmedOn, VoiceSettings } from "@/lib/voice/settings";
import { ReplyDraft } from "./replies";
import { defineTool, ToolError } from "./tool";
import { changesOf, libRefusal, partialOf } from "./write-guards";

/**
 * Settings → Voice as tools: how the site sounds when the platform writes
 * in its name, and "add to notes" on a correction. Each handler calls the
 * function the route calls (lib/business/save-settings.ts,
 * lib/placements/feedback.ts).
 */

export const updateVoiceSettings = defineTool({
  name: "update_voice_settings",
  title: "Change the voice",
  description:
    "Changes how this site sounds when the platform writes in its name: the tone preset, the person (I, we, or whatever fits), About you (the only facts about the writer a reply draft may state; drafting is refused until it is filled in), articleFacts (Facts for articles: the true things a public article may state about the writer and the business, up to 2,000 characters; articles never read About you) and the writer's own notes, which every draft follows as rules; also the daily reply goal shown as \"N of G today\" (dailyReplyGoal, 1 to 50, null for none), and xHandle: the site's X account (username, the @ optional, 1 to 15 letters, digits or underscores; stored lowercased; null clears it), which GTF needs to find the links of replies posted on X (mark_reply_posted says when it is missing). The X features run for every site when the platform reads X: there is no switch to send; an old findPostsOnX field is ignored. confirmedFacts holds the \"Still true\" days that confirm_about_you_fact writes: leave it out. Changing or removing a sentence of About you drops its confirmation. Fields left out stay as they are.",
  input: z.object(partialOf(VoiceSettings.shape)),
  output: z.object({ settings: VoiceSettings }),
  scope: "write",
  paid: false,
  async handler(ctx, input) {
    // The merge, and the refusal to replace an unreadable value with the
    // defaults, are the function the Replies page's daily goal calls too.
    const saved = await saveVoiceChange({
      supabase: ctx.client,
      userId: ctx.userId,
      businessId: ctx.businessId,
      changes: changesOf(input) as Partial<VoiceSettings>,
    });
    if (!saved.ok && saved.status === 409) {
      throw new ToolError(
        "invalid_state",
        saved.error,
        409,
        "Send every field (preset, person, aboutYou, instructions), or save them once in Settings → Voice."
      );
    }
    if (!saved.ok) throw libRefusal(saved);
    return { settings: saved.settings };
  },
});

export const promoteFeedbackToNotes = defineTool({
  name: "promote_feedback_to_notes",
  title: "Add a note to the voice",
  description:
    "Makes one correction note permanent: its reason becomes the last line of the writer's notes (Settings → Voice), which every draft follows as rules. No model is called. Promoting the same note twice adds nothing; refused with the reason when the notes are full.",
  input: z.object({ feedbackId: z.string().uuid().describe("A correction note's id, as correct_reply_draft returns it.") }),
  output: z.object({
    feedback: z.object({
      id: z.string(),
      targetId: z.string(),
      placementId: z.string().nullable(),
      reason: z.string(),
      bodyBefore: z.string().nullable(),
      bodyAfter: z.string().nullable(),
      promotedToNotes: z.boolean(),
      createdAt: z.string(),
    }),
    instructions: z.string().describe("The writer's notes as they are now."),
    appended: z.boolean().describe("False when the notes already had this line."),
  }),
  scope: "write",
  paid: false,
  owns: { feedbackId: "draft_feedback" },
  async handler(ctx, input) {
    const result = await promoteToNotes({
      supabase: ctx.client,
      admin: ctx.admin(),
      userId: ctx.userId,
      businessId: ctx.businessId,
      feedbackId: input.feedbackId,
    });
    if (!result.ok) throw libRefusal(result);
    return { feedback: result.feedback, instructions: result.instructions, appended: result.appended };
  },
});

export const addAboutYouFactTool = defineTool({
  name: "add_about_you_fact",
  title: "Add a true fact to About you",
  description:
    "\"It's true: add to About you\": appends one fact the person confirmed as true to About you (Settings → Voice), the only first-hand facts a draft may state. The existing text is kept as it is; the fact goes at the end. Date it (\"As of November 12, 2026: …\") so it is asked about once it is a month old. Never send a fact the person did not confirm. With draftId, the gate then judges that draft's text again, unchanged, and the draft with its new audit is returned. No model is called. Refused with a sentence when About you is full. Undo with remove_about_you_fact.",
  input: z.object({
    fact: z.string().trim().min(1).max(ABOUT_YOU_FACT_MAX).describe("One sentence, in the person's own words, that they confirmed is true."),
    draftId: z.string().uuid().optional().describe("A draft whose check flagged the sentence: judged again after the fact is added."),
  }),
  output: z.object({
    aboutYou: z.string().max(ABOUT_YOU_MAX).describe("About you as it is now."),
    fact: z.string().describe("The sentence as it was written: one line, ending in a full stop."),
    added: z.boolean().describe("False when About you already had this sentence."),
    draft: ReplyDraft.optional().describe("The draft judged again, when draftId was given: its audit is the new verdict."),
    targetStatus: z.enum(TARGET_STATUSES).optional(),
  }),
  scope: "write",
  paid: false,
  owns: { draftId: "placements" },
  async handler(ctx, input) {
    const result = await addAboutYouFact({ supabase: ctx.client, userId: ctx.userId, businessId: ctx.businessId, fact: input.fact });
    if (!result.ok) throw libRefusal(result);
    const out = { aboutYou: result.aboutYou, fact: result.fact, added: result.changed };
    if (!input.draftId) return out;
    const checked = await recheckDraft({ supabase: ctx.client, businessId: ctx.businessId, draftId: input.draftId });
    if (!checked.ok) throw libRefusal(checked);
    return { ...out, draft: checked.draft, targetStatus: checked.targetStatus };
  },
});

export const removeAboutYouFactTool = defineTool({
  name: "remove_about_you_fact",
  title: "Remove a fact from About you",
  description:
    "The undo of add_about_you_fact: removes that exact sentence from About you, if it is there, and nothing else. With ifAboutYouIs (the aboutYou the add returned), it is refused when About you has changed since. Judges no draft again: call edit_reply_draft for that.",
  input: z.object({
    fact: z.string().trim().min(1).max(ABOUT_YOU_FACT_MAX).describe("The sentence as add_about_you_fact returned it."),
    ifAboutYouIs: z.string().max(ABOUT_YOU_MAX).optional().describe("About you as the add left it: refused (409) when it is not that any more."),
  }),
  output: z.object({
    aboutYou: z.string().max(ABOUT_YOU_MAX).describe("About you as it is now."),
    removed: z.boolean().describe("False when the sentence was not there."),
  }),
  scope: "write",
  paid: false,
  async handler(ctx, input) {
    const result = await removeAboutYouFact({
      supabase: ctx.client,
      userId: ctx.userId,
      businessId: ctx.businessId,
      fact: input.fact,
      ifAboutYouIs: input.ifAboutYouIs,
    });
    if (!result.ok) throw libRefusal(result);
    return { aboutYou: result.aboutYou, removed: result.changed };
  },
});

export const confirmAboutYouFactTool = defineTool({
  name: "confirm_about_you_fact",
  title: "Mark a fact in About you as still true",
  description:
    "\"Still true\" on Today: records that a dated sentence of About you (one of get_voice_settings' staleFacts, or get_today's fact_stale items) is still true today. The day is stored apart from the text (settings.confirmedFacts); About you is not changed, so no draft reads the date. A fact is stale 30 days after the later of its own date and this confirmation, so it is not asked about for another 30 days and a draft may state it as current. Editing or removing the sentence drops its confirmation. Send the sentence exactly as staleFacts gives it; refused (409) when it is no longer in About you as it was, or carries no date. Never confirm a fact the person did not confirm. Undo: the same call with undo.previousConfirmedOn set to the previousConfirmedOn it answered (null removes the confirmation).",
  input: z.object({
    sentence: z.string().trim().min(1).max(ABOUT_YOU_MAX).describe("The sentence as staleFacts quotes it."),
    undo: z
      .object({ previousConfirmedOn: ConfirmedOn.nullable().describe("previousConfirmedOn as the confirmation answered it.") })
      .optional()
      .describe("Undo a confirmation: its entry goes back to previousConfirmedOn, removed when null."),
  }),
  output: z.object({
    fact: z.string().describe("The sentence of About you, exactly as written there: a confirmation never changes it."),
    confirmedOn: ConfirmedOn.nullable().describe("The day it counts as confirmed now (YYYY-MM-DD, UTC); null when it is not."),
    previousConfirmedOn: ConfirmedOn.nullable().describe("The day it was confirmed before this call; null when never. What an undo sends back."),
    changed: z.boolean().describe("False when nothing changed (already confirmed today, or nothing to undo)."),
  }),
  scope: "write",
  paid: false,
  async handler(ctx, input) {
    const result = await confirmAboutYouFact({
      supabase: ctx.client,
      userId: ctx.userId,
      businessId: ctx.businessId,
      sentence: input.sentence,
      undo: input.undo,
    });
    if (!result.ok) throw libRefusal(result);
    return { fact: result.fact, confirmedOn: result.confirmedOn, previousConfirmedOn: result.previousConfirmedOn, changed: result.changed };
  },
});

export const WRITE_VOICE_TOOLS = [
  updateVoiceSettings,
  promoteFeedbackToNotes,
  addAboutYouFactTool,
  removeAboutYouFactTool,
  confirmAboutYouFactTool,
] as const;
