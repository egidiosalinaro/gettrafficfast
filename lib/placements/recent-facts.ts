import type { SupabaseClient } from "@supabase/supabase-js";
import { clampText } from "@/lib/content/text";
import {
  RECENT_FACTS_MAX,
  RECENT_QUOTES_MAX,
  RECENT_QUOTE_MAX,
  RECENT_REPLIES_MAX,
  type RecentFacts,
} from "@/lib/voice/fact-rules";
import { factsUsed } from "./fact-fit";
export { REPEAT_MIN, repeatedFacts, type FactRepeat } from "./fact-repeats";
import { variantNamesBusiness } from "./link";
import { readPostedReplies, type PostedDraft, type PostedTarget } from "./voice-examples";
import type { PlacementVariant } from "./workflow";

/**
 * A fact used recently is not used again.
 *
 * The case, 12 November 2026, on the GetTrafficFast site: About you held
 * one usable fact, the owner's blog numbers ("… articles sit around position
 * 30-40"), and 5 of the last 17 drafts said "position 30-40". The latest,
 * under @hank_ships's post about being called a grifter: "i'm still trying to
 * get my blog articles past position 30-40, so i know the grind is real".
 * It passed every check. "is that the only thing it can say?"
 *
 * So the drafting job reads the business's last RECENT_REPLIES_MAX replies,
 * one per post (the text he posted when he posted one, else the drafts),
 * traces which About you sentences each used (`factsUsed`,
 * lib/placements/fact-fit.ts), and:
 *
 * - tells the drafter and the correction which facts those were
 *   (`recentFactsRule`, lib/voice/fact-rules.ts);
 * - hands the same list to the gate, whose advisory check "Repeats a recent
 *   fact" fails a draft that uses a sentence already in REPEAT_MIN or more
 *   of them (`repeatedFacts`).
 *
 * Cost: the posted replies are the read the voice examples already make
 * (`readPostedReplies`); the drafts are one indexed read of at most
 * DRAFT_POOL short rows. No model call, no money.
 */

/** Draft rows read: up to three variants a post, so enough for ten posts. */
export const DRAFT_POOL = 40;

export interface RecentReply {
  targetId: string;
  /** When it was posted, else when it was drafted (ISO). */
  at: string;
  text: string;
}

interface DraftRow {
  target_id: string;
  variant: string;
  body: string;
  created_at: string | null;
}

/**
 * The recent replies, newest first, one per post, from rows already read.
 * Pure. A posted reply is what he posted (`published_text`), else the draft
 * he chose; a post not posted is its reply drafts together (the list entry
 * and the article name the project by design and are left out). The post
 * being drafted is excluded.
 */
export function recentRepliesFrom(
  posted: { targets: readonly PostedTarget[]; drafts: readonly PostedDraft[] },
  drafts: readonly DraftRow[],
  options: { excludeTargetId?: string; limit?: number } = {}
): RecentReply[] {
  const replies = new Map<string, RecentReply>();
  for (const row of drafts) {
    if (row.target_id === options.excludeTargetId || variantNamesBusiness(row.variant as PlacementVariant)) continue;
    const body = (row.body ?? "").trim();
    if (!body) continue;
    const current = replies.get(row.target_id);
    const at = row.created_at ?? "";
    replies.set(row.target_id, current ? { ...current, text: `${current.text}\n${body}`, at: current.at > at ? current.at : at } : { targetId: row.target_id, at, text: body });
  }
  const chosen = new Map(posted.drafts.map((draft) => [draft.id, draft]));
  for (const target of posted.targets) {
    if (target.id === options.excludeTargetId || target.removed_at) continue;
    const draft = target.selected_placement_id ? chosen.get(target.selected_placement_id) : undefined;
    const text = target.published_text?.trim() || (draft && !variantNamesBusiness(draft.variant as PlacementVariant) ? draft.body.trim() : "") || replies.get(target.id)?.text || "";
    if (!text) continue;
    replies.set(target.id, { targetId: target.id, at: target.published_at ?? replies.get(target.id)?.at ?? "", text });
  }
  return [...replies.values()]
    .sort((a, b) => b.at.localeCompare(a.at) || a.targetId.localeCompare(b.targetId))
    .slice(0, options.limit ?? RECENT_REPLIES_MAX);
}

/** Which About you sentences the replies used, in how many, and how they wrote them; the most used first. */
export function recentFacts(replies: readonly RecentReply[], aboutYou: string, now: Date): RecentFacts {
  const recent = replies.slice(0, RECENT_REPLIES_MAX);
  const order: string[] = [];
  const bySentence = new Map<string, { count: number; quotes: string[] }>();
  for (const reply of recent) {
    for (const use of factsUsed(reply.text, aboutYou, { now })) {
      let entry = bySentence.get(use.sentence);
      if (!entry) {
        entry = { count: 0, quotes: [] };
        bySentence.set(use.sentence, entry);
        order.push(use.sentence);
      }
      entry.count += 1;
      const quote = clampText(use.quote, RECENT_QUOTE_MAX);
      if (entry.quotes.length < RECENT_QUOTES_MAX && !entry.quotes.some((q) => q.toLowerCase() === quote.toLowerCase())) entry.quotes.push(quote);
    }
  }
  const facts = order
    .map((sentence, index) => ({ sentence, index, ...bySentence.get(sentence)! }))
    .sort((a, b) => b.count - a.count || a.index - b.index)
    .slice(0, RECENT_FACTS_MAX)
    .map(({ sentence, count, quotes }) => ({ sentence, count, quotes }));
  return { replies: recent.length, facts };
}

/**
 * The recent replies for one draft. Never throws: a read that fails is an
 * empty history, and the draft is written without the list. `readBack` as
 * in `readPostedReplies`; the posted replies already read for the voice
 * examples can be passed in (`posted`) so they are not read twice.
 */
export async function loadRecentReplies(
  supabase: SupabaseClient,
  params: {
    businessId: string;
    excludeTargetId: string;
    posted?: { targets: PostedTarget[]; drafts: PostedDraft[] };
  }
): Promise<RecentReply[]> {
  try {
    const readDrafts = async () =>
      supabase
        .from("placements")
        .select("target_id, variant, body, created_at")
        .eq("business_id", params.businessId)
        .order("created_at", { ascending: false })
        .limit(DRAFT_POOL);
    const [posted, drafted] = await Promise.all([
      params.posted ?? readPostedReplies(supabase, { businessId: params.businessId, readBack: false }),
      readDrafts(),
    ]);
    const drafts = drafted.error || !drafted.data ? [] : (drafted.data as unknown as DraftRow[]);
    return recentRepliesFrom(posted, drafts, { excludeTargetId: params.excludeTargetId });
  } catch {
    return [];
  }
}
