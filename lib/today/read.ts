import type { SupabaseClient } from "@supabase/supabase-js";
import { todayViewCounts, viewCounts, type TodayViewId } from "@/lib/placements/inbox-view";
import { loadAiCitations, loadToday, loadTodayReplies, readAllCountRows, viewRowOf } from "@/lib/placements/read";
import { loadRemovals, withRemoval } from "@/lib/placements/removed";
import { linkFinding, X_RECENT_SEARCH_MS } from "@/lib/placements/reply-link";
import { replyLinkFinderFor } from "@/lib/placements/reply-link-search";
import { dayIn, todayLinks, type TodayLinks, type TodayReply } from "@/lib/placements/today";
import { parseVoiceSettings } from "@/lib/voice/settings";
import { staleFacts } from "@/lib/voice/staleness";
import { alsoTodayItems, type AlsoTodayItem, type HeldArticle, type PushProposal } from "./also-today";

/**
 * The Today screen as one read (2026-11-14): `GET /api/today` answers it and
 * `get_today` returns it, so the screen and an agent see the same list.
 *
 * - `progress`: "N of G replies" and where today's links stand, from
 *   `loadToday` (the rule of the count and the Today sheet) and `todayLinks`.
 * - `counts`: the rows of each tab (To do, Posted, Archive), by the rules
 *   the inbox counts with (`viewCounts` over every row, read in pages).
 * - `alsoToday`: what else needs a gesture today (./also-today.ts).
 *
 * Through the caller's client: RLS is the access control, `business_id`
 * the scope. Nothing here calls a model or a paid API. Whether GTF looks for
 * links on X needs the platform's X ledger, read with `admin` only when a
 * reply without a link could be looked for.
 */

export interface TodayScreen {
  progress: {
    posted: number;
    goal: number | null;
    timeZone: string;
    /** Null with no reply today, or when today's list could not be read. */
    links: TodayLinks | null;
  };
  /** Null when the rows could not be counted: unknown, not zero. */
  counts: Record<TodayViewId, number> | null;
  alsoToday: AlsoTodayItem[];
}

type Row = Record<string, unknown>;

/** At most this many held or failed articles are read: more than a screen holds. */
const ARTICLES_MAX = 20;
/** At most this many posted replies without a link are checked for a stopped search. */
const UNLINKED_MAX = 50;

/** Held and failed articles of the site, newest day first. Null when they could not be read. */
async function loadHeldArticles(supabase: SupabaseClient, businessId: string): Promise<HeldArticle[] | null> {
  const { data, error } = await supabase
    .from("articles")
    .select("id, status, scheduled_date, last_error, quality_report, keywords!articles_keyword_id_fkey ( keyword )")
    .eq("business_id", businessId)
    .in("status", ["needs_review", "failed"])
    // An article ignored on Today stays on the Content board only.
    .is("dismissed_at", null)
    .order("scheduled_date", { ascending: false })
    .limit(ARTICLES_MAX);
  if (error) return null;
  return ((data ?? []) as Row[]).map((row) => {
    const joined = row.keywords as { keyword?: string } | Array<{ keyword?: string }> | null;
    const keyword = (Array.isArray(joined) ? joined[0] : joined)?.keyword ?? "";
    return {
      id: String(row.id),
      status: String(row.status ?? ""),
      scheduledDate: String(row.scheduled_date ?? ""),
      keyword,
      lastError: row.last_error,
      qualityReport: row.quality_report,
    };
  });
}

/** Push page 3 proposals waiting for the person (docs/LIFECYCLE.md). Empty when they could not be read. */
async function loadPushProposals(supabase: SupabaseClient, businessId: string): Promise<PushProposal[]> {
  const { data, error } = await supabase
    .from("article_pushes")
    .select("id, article_id, main_query, links, new_title, new_meta_description, articles!inner ( title:canonical->>title )")
    .eq("business_id", businessId)
    .eq("status", "proposed")
    .order("created_at", { ascending: false })
    .limit(10);
  if (error) return [];
  return ((data ?? []) as Row[]).map((row) => {
    const joined = row.articles as { title?: string | null } | Array<{ title?: string | null }> | null;
    const title = (Array.isArray(joined) ? joined[0] : joined)?.title ?? "";
    const links = Array.isArray(row.links) ? (row.links as Array<{ status?: string }>) : [];
    return {
      id: String(row.id),
      articleId: String(row.article_id),
      title,
      mainQuery: String(row.main_query ?? ""),
      proposedLinks: links.filter((l) => l.status === "proposed").length,
      newTitle: Boolean(row.new_title || row.new_meta_description),
    };
  });
}

/**
 * Posted replies on X of the last 7 days with no link and not removed, with
 * their link searches: the candidates for "paste its link".
 */
async function loadUnlinkedReplies(supabase: SupabaseClient, businessId: string, now: Date): Promise<TodayReply[]> {
  const { data, error } = await supabase
    .from("placement_targets")
    .select("id, status, surface, published_at")
    .eq("business_id", businessId)
    .eq("status", "published_manually")
    .eq("surface", "x")
    .is("published_url", null)
    .gte("published_at", new Date(now.getTime() - X_RECENT_SEARCH_MS).toISOString())
    .order("published_at", { ascending: false })
    .limit(UNLINKED_MAX);
  if (error) return [];
  const rows = (data ?? []) as Row[];
  const removals = await loadRemovals(
    supabase,
    businessId,
    rows.map((row) => row.id as string)
  );
  // Removals unreadable: nothing is offered rather than a reply that may be gone.
  if (!removals) return [];
  const live = rows.map((row) => withRemoval(row, removals)).filter((row) => !row.removed_at);
  return (await loadTodayReplies(supabase, businessId, live, null)) ?? [];
}

/** How many rows each tab holds; null when the rows could not be read. */
async function loadTabCounts(supabase: SupabaseClient, businessId: string, now: Date): Promise<Record<TodayViewId, number> | null> {
  const [counted, removals, citations] = await Promise.all([
    readAllCountRows(supabase, businessId),
    loadRemovals(supabase, businessId),
    loadAiCitations(supabase, businessId),
  ]);
  if (counted.error) return null;
  const rows = counted.data.map((row) => viewRowOf(withRemoval(row, removals), citations));
  return todayViewCounts(viewCounts(rows, now.getTime()));
}

export async function loadTodayScreen(
  supabase: SupabaseClient,
  businessId: string,
  options: {
    /** The service role, for the platform's X ledger; called only when it matters. */
    admin: () => SupabaseClient;
    timeZone?: string | null;
    now?: Date;
  }
): Promise<TodayScreen> {
  const now = options.now ?? new Date();
  const [today, counts, articles, unlinked, business, pushes] = await Promise.all([
    loadToday(supabase, businessId, { timeZone: options.timeZone, now }),
    loadTabCounts(supabase, businessId, now),
    loadHeldArticles(supabase, businessId),
    loadUnlinkedReplies(supabase, businessId, now),
    supabase.from("businesses").select("voice_settings").eq("id", businessId).maybeSingle(),
    loadPushProposals(supabase, businessId),
  ]);

  // "GTF is looking" only when a reply of today could be looked for and the finder is on.
  const couldLook = (today.replies ?? []).some(
    (reply) =>
      !reply.publishedUrl &&
      "linkSearch" in reply &&
      linkFinding({ ...reply, status: "published_manually", removedAt: null }, { finderOn: true, now: now.getTime() })?.state === "looking"
  );
  const finderOn = couldLook ? await replyLinkFinderFor(options.admin(), supabase, businessId, now) : false;
  const voice = parseVoiceSettings((business.data as { voice_settings?: unknown } | null)?.voice_settings);

  return {
    progress: {
      posted: today.posted,
      goal: today.goal,
      timeZone: today.timeZone,
      links: todayLinks(today.replies, { finderOn, now: now.getTime() }),
    },
    counts,
    alsoToday: alsoTodayItems({
      articles: articles ?? [],
      today: dayIn(now.toISOString(), today.timeZone),
      replies: unlinked,
      staleFacts: staleFacts(voice.aboutYou, now, { confirmations: voice.confirmedFacts }),
      now: now.getTime(),
      pushes,
    }),
  };
}
