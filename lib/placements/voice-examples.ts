import type { SupabaseClient } from "@supabase/supabase-js";
import { clampText } from "@/lib/content/text";
import { promotesBusiness, withoutTells } from "./audit";
import { variantNamesBusiness } from "./link";
import { ensurePublishedText } from "./published-text";
import type { PlacementVariant } from "./workflow";

/**
 * The replies the owner actually posted, handed back to the writer as the
 * voice to match.
 *
 * On 9 November 2026 the X reply the drafter wrote ("It's tough to tell if
 * these tools work…") read as a model's, and the owner fixed it by adding a
 * line of his own: "I'm not good at doing the test I'm just thinking out
 * loud ahahah". The reply he had posted an hour earlier was the shape he
 * wanted ("Not naive at all. I'm getting 200+ impressions on my blog now,
 * still zero clicks. …"). A description of a voice is not a voice; what he
 * posted is.
 *
 * What is read: the targets this business marked as posted
 * (`placement_targets.status = 'published_manually'`), the thread's own
 * surface first, then the most recent. The text is what he really posted
 * when the reply link captured it (`published_text`), else the draft he
 * chose (`selected_placement_id`), which carries his edits because an edit
 * is saved before Reply on X. A target with neither is skipped: nothing is
 * guessed. Before picking, the newest posted replies that have an X link and
 * no text yet are read back from X (`ensurePublishedText`, at most
 * PUBLISHED_TEXT_READS per draft), so a reply he edited on X teaches his
 * published words and not the draft; the posted card shows that text as
 * "What you posted".
 *
 * What is left out, because it is not a voice to copy:
 * - a reply that names the business, carries a URL, has the "I use X for
 *   that" line or speaks as the maker (`promotesBusiness`): the 21 replies
 *   posted between 28 September and 8 October 2026 were all that advert;
 * - inside a reply, every sentence the gate deletes as a model's tell
 *   (`withoutTells`), so the AI half of an edited reply is not taught back
 *   and the owner's own line is; a reply with nothing left is skipped;
 * - the article and the list entry: they name the project by design;
 * - a reply marked as removed from the site (`removed_at`, since
 *   2026-11-10, lib/placements/removed.ts). Its words may have been fine
 *   (Reddit hides every comment of a new account), but a reply nobody could
 *   read is no proof of a good one, and the reason is free text, so no
 *   removal is told apart from another. Undoing the removal brings it back.
 *
 * Cost: at most VOICE_EXAMPLE_LIMIT examples, the reply clamped to
 * VOICE_EXAMPLE_REPLY_CHARS and the thread to VOICE_EXAMPLE_THREAD_CHARS,
 * so the section is at most about 2,500 characters (~700 input tokens) on a
 * short-reply call, and nothing when he has posted nothing. Two indexed
 * reads, no model call, and at most PUBLISHED_TEXT_READS free oEmbed reads
 * run together, each cut off at 6 s: a few seconds at worst, no money.
 */

export const VOICE_EXAMPLE_LIMIT = 5;
export const VOICE_EXAMPLE_REPLY_CHARS = 280;
export const VOICE_EXAMPLE_THREAD_CHARS = 200;
/** Posted targets read per draft: enough for five after the filters, bounded. */
export const VOICE_EXAMPLE_POOL = 25;
/**
 * Posted replies read back from X per draft, newest first, when their link
 * is saved and their text is not. The rest wait for the next draft: the
 * backlog fills two at a time without slowing one draft by more than one
 * oEmbed timeout.
 */
export const PUBLISHED_TEXT_READS = 2;
/** Fewer words than this left after the tells are deleted is not a reply. */
const MIN_WORDS = 3;

export interface VoiceExample {
  /** What the thread said, clamped. */
  thread: string;
  /** What the owner posted, in his words, clamped. */
  reply: string;
}

/** A posted target as read: `published_text` is optional until every row has the column. */
export interface PostedTarget {
  id: string;
  surface: string;
  title: string | null;
  excerpt: string | null;
  published_at: string | null;
  selected_placement_id: string | null;
  /** Read so the text can be filled in (`ensurePublishedText`); always `published_manually` here. */
  status?: string | null;
  /** The link to the posted reply, when the person saved it. */
  published_url?: string | null;
  published_text?: string | null;
  /** Set when the reply was marked as removed from the site; such a reply is never an example. */
  removed_at?: string | null;
}

export interface PostedDraft {
  id: string;
  variant: string;
  body: string;
}

/**
 * The examples, from rows already read. Pure, so the order and the filters
 * are tested without a database. Deterministic: the same rows always give
 * the same examples in the same order, so the prompt does not change from
 * one draft to the next until a new reply is posted.
 */
export function pickVoiceExamples(
  targets: readonly PostedTarget[],
  drafts: readonly PostedDraft[],
  options: { surface: string; names: string[]; excludeTargetId?: string; limit?: number }
): VoiceExample[] {
  const byId = new Map(drafts.map((draft) => [draft.id, draft]));
  const ordered = targets
    .filter((target) => target.id !== options.excludeTargetId && !target.removed_at)
    .sort((a, b) => {
      const surface = Number(b.surface === options.surface) - Number(a.surface === options.surface);
      if (surface !== 0) return surface;
      const when = (b.published_at ?? "").localeCompare(a.published_at ?? "");
      return when !== 0 ? when : a.id.localeCompare(b.id);
    });

  const examples: VoiceExample[] = [];
  for (const target of ordered) {
    if (examples.length >= (options.limit ?? VOICE_EXAMPLE_LIMIT)) break;
    const posted = target.published_text?.trim();
    const draft = target.selected_placement_id ? byId.get(target.selected_placement_id) : undefined;
    const usable = draft && !variantNamesBusiness(draft.variant as PlacementVariant) ? draft.body.trim() : "";
    const text = posted || usable;
    if (!text || promotesBusiness(text, options.names)) continue;
    const reply = withoutTells(text, "short_comment");
    if (reply.split(/\s+/).filter(Boolean).length < MIN_WORDS) continue;
    const thread = (target.excerpt ?? "").trim() || (target.title ?? "").trim();
    examples.push({
      thread: clampText(thread, VOICE_EXAMPLE_THREAD_CHARS),
      reply: clampText(reply, VOICE_EXAMPLE_REPLY_CHARS),
    });
  }
  return examples;
}

const TARGET_COLUMNS = "id, surface, title, excerpt, status, published_at, published_url, selected_placement_id";

/**
 * The examples for one draft. Never throws: a draft is written without
 * examples rather than not written.
 *
 * `supabase` is the drafting job's client, which is the service role (the
 * worker and the inline draft route both run jobs with it). The rows are
 * read scoped to `businessId`, so they are this business's before
 * `ensurePublishedText` writes the text it reads onto them by id. The
 * `published_text` column is read when it exists; on a database without it
 * the read falls back to the chosen draft alone and nothing is read from X,
 * since there would be nowhere to store it.
 */
export async function loadVoiceExamples(
  supabase: SupabaseClient,
  params: { businessId: string; targetId: string; surface: string; names: string[] }
): Promise<VoiceExample[]> {
  const { targets, drafts } = await readPostedReplies(supabase, { businessId: params.businessId, readBack: true });
  return pickVoiceExamples(targets, drafts, {
    surface: params.surface,
    names: params.names,
    excludeTargetId: params.targetId,
  });
}

/**
 * The posted replies and their chosen drafts, as read for the examples.
 * Also what the recent-facts history reads (lib/placements/recent-facts.ts),
 * so the two share one read. `readBack`: fill in from X the text of the
 * newest posted replies that lack it (the drafting job only; it writes with
 * the service role). Never throws: nothing read is empty lists.
 */
export async function readPostedReplies(
  supabase: SupabaseClient,
  params: { businessId: string; readBack: boolean }
): Promise<{ targets: PostedTarget[]; drafts: PostedDraft[] }> {
  const none = { targets: [], drafts: [] };
  const read = (columns: string, keepRemoved: boolean) => {
    const query = supabase
      .from("placement_targets")
      .select(columns)
      .eq("business_id", params.businessId)
      .eq("status", "published_manually");
    // Removed replies are left out in the read, so they do not take places
    // in the pool, and again in `pickVoiceExamples`.
    return (keepRemoved ? query : query.is("removed_at", null))
      .order("published_at", { ascending: false })
      .limit(VOICE_EXAMPLE_POOL);
  };
  // Newest schema first; each fallback drops a column a database may not
  // have yet (`removed_at`, then `published_text`).
  let result = await read(`${TARGET_COLUMNS}, published_text, removed_at`, false);
  if (result.error) result = await read(`${TARGET_COLUMNS}, published_text`, true);
  const hasTextColumn = !result.error;
  if (result.error) result = await read(TARGET_COLUMNS, true);
  if (result.error || !result.data) return none;
  let targets = (result.data as unknown as PostedTarget[]).filter((target) => !target.removed_at);
  if (targets.length === 0) return none;

  if (hasTextColumn && params.readBack) {
    // Newest first, as read: the newest replies missing their text are the
    // ones read from X. Free, bounded, and it never throws.
    targets = await ensurePublishedText(
      supabase,
      targets.map((target) => ({
        ...target,
        published_url: target.published_url ?? null,
        published_text: target.published_text ?? null,
      })),
      { max: PUBLISHED_TEXT_READS }
    );
  }

  const ids = [...new Set(targets.map((target) => target.selected_placement_id).filter((id): id is string => Boolean(id)))];
  let drafts: PostedDraft[] = [];
  if (ids.length > 0) {
    const { data, error } = await supabase
      .from("placements")
      .select("id, variant, body")
      .eq("business_id", params.businessId)
      .in("id", ids);
    if (!error && data) drafts = data as unknown as PostedDraft[];
  }
  return { targets, drafts };
}
