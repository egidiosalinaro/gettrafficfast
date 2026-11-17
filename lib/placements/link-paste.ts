import type { SupabaseClient } from "@supabase/supabase-js";
import { readXPost } from "@/lib/providers/x/oembed";
import { matchReplyLinks, postedReplyText, type LinkCandidate, type LinkMatch } from "./link-match";
import { replyLinkKey, replyLinkSurface } from "./published-url";
import { loadRemovals } from "./removed";

/**
 * "Paste your reply links", the read half: which posted reply each pasted
 * link belongs to (`matchReplyLinks`). It decides and stores nothing. The
 * route (`POST /api/placements/match-links`) answers these matches to the
 * page, which saves the sure ones through the action route
 * (`set_published_url`); the `paste_reply_links` tool saves them through
 * the same action. A link that is not sure is a question with its
 * candidates, never a guess.
 *
 * A reply on X is read through X's public oEmbed (free, keyless, 6 s
 * timeout, at most MAX_LINKS_PER_PASTE reads a call) so its text can be
 * compared with the drafts that were posted. Through the caller's own
 * client: RLS (or the owner-scoped service role) is the access control,
 * `business_id` the scope.
 */
export async function matchPastedReplyLinks(params: {
  supabase: SupabaseClient;
  businessId: string;
  links: readonly string[];
}): Promise<{ ok: true; matches: LinkMatch[] } | { ok: false; error: string }> {
  const { supabase, businessId } = params;
  const { data: rows, error } = await supabase
    .from("placement_targets")
    .select("id, surface, url, published_url, selected_placement_id")
    .eq("business_id", businessId)
    .eq("status", "published_manually");
  if (error) return { ok: false, error: error.message };

  const posted = (rows ?? []) as Array<{
    id: string;
    surface: string;
    url: string;
    published_url: string | null;
    selected_placement_id: string | null;
  }>;
  const removals = await loadRemovals(supabase, businessId);
  const waiting = posted.filter((row) => !(row.published_url ?? "").trim() && !removals?.get(row.id));
  const taken = new Set(posted.map((row) => (row.published_url ? replyLinkKey(row.published_url) : null)).filter((k): k is string => Boolean(k)));

  const ids = waiting.map((row) => row.id);
  const { data: drafts } = ids.length
    ? await supabase.from("placements").select("id, target_id, body").in("target_id", ids).order("created_at", { ascending: true })
    : { data: [] };
  const draftsByTarget = new Map<string, Array<{ id: string; body: string }>>();
  for (const draft of (drafts ?? []) as Array<{ id: string; target_id: string; body: string }>) {
    const list = draftsByTarget.get(draft.target_id) ?? [];
    list.push({ id: draft.id, body: draft.body });
    draftsByTarget.set(draft.target_id, list);
  }
  const candidates: LinkCandidate[] = waiting.map((row) => ({
    id: row.id,
    surface: row.surface,
    url: row.url,
    replyText: postedReplyText({ selectedPlacementId: row.selected_placement_id, drafts: draftsByTarget.get(row.id) ?? [] }),
  }));

  const links = params.links.map((link) => link.trim()).filter(Boolean);
  const readTexts: Record<string, string | null> = {};
  await Promise.all(
    links
      .filter((link) => replyLinkSurface(link) === "x")
      .map(async (link) => {
        readTexts[link] = (await readXPost(link))?.text ?? null;
      })
  );

  return { ok: true, matches: matchReplyLinks({ links, readTexts, candidates, taken }) };
}
