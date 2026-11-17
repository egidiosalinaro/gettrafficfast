import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { clampText } from "@/lib/content/text";
import { INSTRUCTIONS_MAX, VoiceSettings } from "@/lib/voice/settings";

/**
 * The owner's corrections on placement drafts (`draft_feedback`).
 *
 * When a draft is wrong the owner says why in a sentence ("too generic",
 * "sounds like AI", "never start with It's", "use one of my real numbers").
 * Two things follow: the draft is rewritten once following the note
 * (lib/placements/correct.ts), and the note is kept here, so later drafts can
 * be told what was already corrected (`recentFeedback`) and so the owner can
 * make a note permanent in Settings → Voice (`promoteToNotes`).
 *
 * A row is written before the model is called. A rewrite that failed is
 * still a note the owner gave; `body_after` stays null for it, which reads
 * "not rewritten", never an empty string. See docs/PLACEMENTS.md,
 * "Corrections".
 */

export const FEEDBACK_TABLE = "draft_feedback";

/** Shortest note that says something: "meh" is a note, "x" is a slip. */
export const REASON_MIN = 3;
/** The same ceiling the table's check constraint holds. */
export const REASON_MAX = 300;
/** How much of one note a draft prompt carries. */
export const PROMPT_REASON_MAX = 200;
/** Notes handed to a draft prompt when the caller names no limit. */
export const RECENT_FEEDBACK_DEFAULT = 10;
/** Never more than this many notes in one prompt, whatever the caller asks. */
export const RECENT_FEEDBACK_MAX = 50;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Characters as Postgres counts them (`char_length`), not UTF-16 units. */
function charLength(text: string): number {
  return Array.from(text).length;
}

/**
 * The note as the API accepts it: trimmed, 3 to 300 characters. The
 * messages are what the person reads under the box.
 */
export const FeedbackReason = z
  .string({ error: "Say what is wrong with the draft." })
  .trim()
  .refine((value) => charLength(value) >= REASON_MIN, {
    message: `Say what is wrong in at least ${REASON_MIN} characters.`,
  })
  .refine((value) => charLength(value) <= REASON_MAX, {
    message: `Keep the note under ${REASON_MAX} characters.`,
  });

export interface DraftFeedbackRecord {
  id: string;
  targetId: string;
  placementId: string | null;
  reason: string;
  bodyBefore: string | null;
  /** The rewrite that was saved; null when none was. */
  bodyAfter: string | null;
  promotedToNotes: boolean;
  createdAt: string;
}

const FEEDBACK_COLUMNS = "id, target_id, placement_id, reason, body_before, body_after, promoted_to_notes, created_at";

type Row = Record<string, unknown>;

function mapFeedback(row: Row): DraftFeedbackRecord {
  return {
    id: row.id as string,
    targetId: row.target_id as string,
    placementId: (row.placement_id as string | null) ?? null,
    reason: row.reason as string,
    bodyBefore: (row.body_before as string | null) ?? null,
    bodyAfter: (row.body_after as string | null) ?? null,
    promotedToNotes: row.promoted_to_notes === true,
    createdAt: row.created_at as string,
  };
}

function warn(fields: Record<string, unknown>) {
  console.warn(JSON.stringify({ level: "warn", event: "draft_feedback", ...fields }));
}

export type RecordFeedbackResult = { ok: true; id: string } | { ok: false; error: string };

/**
 * Stores one correction. Called with the person's own client: the insert
 * policy proves the business and the target are theirs.
 */
export async function recordFeedback(
  supabase: SupabaseClient,
  input: {
    userId: string;
    businessId: string;
    targetId: string;
    placementId: string | null;
    reason: string;
    bodyBefore: string | null;
    now?: Date;
  }
): Promise<RecordFeedbackResult> {
  const { data, error } = await supabase
    .from(FEEDBACK_TABLE)
    .insert({
      user_id: input.userId,
      business_id: input.businessId,
      target_id: input.targetId,
      placement_id: input.placementId,
      reason: input.reason,
      body_before: input.bodyBefore,
      created_at: (input.now ?? new Date()).toISOString(),
    })
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: error?.message ?? "the row was not written" };
  return { ok: true, id: (data as Row).id as string };
}

/**
 * The rewrite that was saved, on the row of the note that asked for it.
 * Service role, after the caller checked ownership; the row is still matched
 * on its user and business. Never throws: the draft is already saved.
 */
export async function recordRewrite(
  admin: SupabaseClient,
  input: { id: string; userId: string; businessId: string; bodyAfter: string }
): Promise<boolean> {
  const { error } = await admin
    .from(FEEDBACK_TABLE)
    .update({ body_after: input.bodyAfter })
    .eq("id", input.id)
    .eq("user_id", input.userId)
    .eq("business_id", input.businessId);
  if (error) {
    warn({ outcome: "body_after_not_written", id: input.id, error: error.message });
    return false;
  }
  return true;
}

/** One note as a prompt carries it: one line, at most 200 characters. */
export function promptReason(reason: string): string {
  return clampText(reason, PROMPT_REASON_MAX);
}

/** The same note whatever its case and spacing. */
function noteKey(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * The newest distinct notes, as the prompt carries them: each clamped to 200
 * characters, duplicates dropped case-insensitively (the newest copy kept),
 * at most `limit`. Pure, so the rule is tested without a database.
 */
export function distinctReasons(reasons: readonly string[], limit: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const reason of reasons) {
    if (out.length >= limit) break;
    const line = promptReason(reason ?? "");
    const key = noteKey(line);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

/**
 * The last `limit` distinct notes the owner gave on this business's drafts,
 * newest first, for a draft prompt. `string[]`, each at most 200 characters.
 *
 * Fails open: a read error (the table not migrated yet, a timeout) is logged
 * and gives no notes, because a draft written without them is still a draft
 * and a drafting job must not stop on bookkeeping.
 */
export async function recentFeedback(
  supabase: SupabaseClient,
  businessId: string,
  { limit = RECENT_FEEDBACK_DEFAULT }: { limit?: number } = {}
): Promise<string[]> {
  const wanted = Math.max(0, Math.min(Math.floor(Number.isFinite(limit) ? limit : 0), RECENT_FEEDBACK_MAX));
  if (wanted === 0 || !businessId) return [];
  // Read past the limit so a note repeated five times does not crowd out
  // the others; bounded, so the read stays one small query.
  const { data, error } = await supabase
    .from(FEEDBACK_TABLE)
    .select("reason, created_at")
    .eq("business_id", businessId)
    .order("created_at", { ascending: false })
    .limit(wanted * 5);
  if (error) {
    warn({ outcome: "recent_read_failed", business_id: businessId, error: error.message });
    return [];
  }
  return distinctReasons(((data ?? []) as Row[]).map((row) => String(row.reason ?? "")), wanted);
}

/** The business's notes as rows, newest first: what a settings view lists. */
export async function listFeedback(
  supabase: SupabaseClient,
  businessId: string,
  { limit = 50 }: { limit?: number } = {}
): Promise<{ ok: true; feedback: DraftFeedbackRecord[] } | { ok: false; error: string }> {
  const { data, error } = await supabase
    .from(FEEDBACK_TABLE)
    .select(FEEDBACK_COLUMNS)
    .eq("business_id", businessId)
    .order("created_at", { ascending: false })
    .limit(Math.max(1, Math.min(limit, 100)));
  if (error) return { ok: false, error: error.message };
  return { ok: true, feedback: ((data ?? []) as Row[]).map(mapFeedback) };
}

/**
 * Corrections this user asked for in the last 24 hours, across their sites.
 * Every row counts, rewritten or not: the row is written before the model is
 * called, so this is the number of calls asked for. Throws when the count
 * cannot be read: an unreadable count must not become an unlimited budget.
 */
export async function correctionsToday(
  supabase: SupabaseClient,
  userId: string,
  now: Date = new Date()
): Promise<number> {
  const since = new Date(now.getTime() - DAY_MS).toISOString();
  const { count, error } = await supabase
    .from(FEEDBACK_TABLE)
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("created_at", since);
  if (error) throw new Error(`Could not count today's corrections: ${error.message}`);
  return count ?? 0;
}

/** A note as one line of the notes: whitespace collapsed, newlines gone. */
export function noteLine(reason: string): string {
  return reason.replace(/\s+/g, " ").trim();
}

export type AppendNoteResult =
  | { ok: true; instructions: string; appended: boolean }
  | { ok: false; error: string };

/**
 * The notes with `reason` as a new last line. Unchanged (`appended` false)
 * when a line already says the same thing, whatever its case, so promoting
 * twice never writes the line twice. Refused with a sentence when the result
 * would not fit in INSTRUCTIONS_MAX.
 */
export function appendNote(instructions: string, reason: string): AppendNoteResult {
  const line = noteLine(reason);
  if (!line) return { ok: false, error: "There is no note to add." };
  const current = instructions.trimEnd();
  const present = current.split("\n").some((existing) => noteKey(existing.replace(/^\s*[-*•]\s*/, "")) === noteKey(line));
  if (present) return { ok: true, instructions, appended: false };
  const next = current.trim() ? `${current}\n${line}` : line;
  if (next.length > INSTRUCTIONS_MAX) {
    return {
      ok: false,
      error: `Your notes are full: with this line they would be ${next.length} characters, and they hold ${INSTRUCTIONS_MAX}. Shorten them in Settings → Voice, then add it again.`,
    };
  }
  return { ok: true, instructions: next, appended: true };
}

export type PromoteResult =
  | { ok: true; instructions: string; appended: boolean; feedback: DraftFeedbackRecord }
  | { ok: false; status: 404 | 409 | 500; error: string };

/**
 * Makes one note permanent: the reason becomes the last line of the writer's
 * notes (`businesses.voice_settings.instructions`, Settings → Voice), which
 * every draft prompt carries as rules, and the row is marked promoted.
 *
 * Reads and the settings write go through the person's client (RLS proves
 * both rows are theirs); only the flag is written by the service role. The
 * stored settings are validated strictly (`VoiceSettings`), not through the
 * tolerant reader: an unreadable value would otherwise come back as the
 * defaults and the write would erase what the owner had. The notes are
 * written before the flag, so a flag never says "in your notes" for a line
 * that is not there; a second promote finds the line and adds nothing.
 */
export async function promoteToNotes(input: {
  supabase: SupabaseClient;
  admin: SupabaseClient;
  userId: string;
  businessId: string;
  feedbackId: string;
  now?: Date;
}): Promise<PromoteResult> {
  const { supabase, admin, userId, businessId, feedbackId } = input;

  const [{ data: row }, { data: business }] = await Promise.all([
    supabase
      .from(FEEDBACK_TABLE)
      .select(FEEDBACK_COLUMNS)
      .eq("id", feedbackId)
      .eq("business_id", businessId)
      .eq("user_id", userId)
      .maybeSingle(),
    supabase
      .from("businesses")
      .select("id, voice_settings")
      .eq("id", businessId)
      .eq("user_id", userId)
      .maybeSingle(),
  ]);
  if (!row) return { ok: false, status: 404, error: "Note not found" };
  if (!business) return { ok: false, status: 404, error: "Business not found" };

  const stored = VoiceSettings.safeParse((business as Row).voice_settings ?? {});
  if (!stored.success) {
    return {
      ok: false,
      status: 409,
      error: "Your voice settings could not be read. Open Settings → Voice, save them once, then add this note again.",
    };
  }

  const appended = appendNote(stored.data.instructions, String((row as Row).reason ?? ""));
  if (!appended.ok) return { ok: false, status: 409, error: appended.error };

  if (appended.appended) {
    const next = VoiceSettings.safeParse({ ...stored.data, instructions: appended.instructions });
    if (!next.success) {
      return { ok: false, status: 409, error: next.error.issues[0]?.message ?? "The notes would not be valid." };
    }
    const { error } = await supabase
      .from("businesses")
      .update({ voice_settings: next.data, updated_at: (input.now ?? new Date()).toISOString() })
      .eq("id", businessId)
      .eq("user_id", userId);
    if (error) return { ok: false, status: 500, error: error.message };
  }

  const { error: flagError } = await admin
    .from(FEEDBACK_TABLE)
    .update({ promoted_to_notes: true })
    .eq("id", feedbackId)
    .eq("business_id", businessId)
    .eq("user_id", userId);
  if (flagError) warn({ outcome: "promoted_flag_not_written", id: feedbackId, error: flagError.message });

  return {
    ok: true,
    instructions: appended.instructions,
    appended: appended.appended,
    feedback: { ...mapFeedback(row as Row), promotedToNotes: !flagError },
  };
}
