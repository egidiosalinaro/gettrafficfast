import type { SupabaseClient } from "@supabase/supabase-js";
import { parseAutomationSettings } from "@/lib/automation/settings";
import { describeAutopilotRun, readAutopilotRun, type AutopilotRunView } from "@/lib/automation/run-status";
import { businessHostname } from "@/lib/domain/business-display";
import { countOverlapClusters, loadSiteTopics } from "@/lib/keywords/overlap";
import { loadQuestionIdeas } from "@/lib/keywords/read";
import {
  describeWeek,
  nextTopics,
  utcDay,
  weekDays,
  type ContentArticle,
  type ContentDay,
  type ContentTopic,
  type PlanArticle,
  type PoolTopic,
} from "./content-plan";

/**
 * Content (`/content`) for one site, as GET /api/content answers it and
 * `get_content` reads it: the Autopilot state, today's article, the week,
 * the topics Autopilot picks from next, and the counts behind the links to
 * the rest (topics, overlapping topics, questions people ask). The screen
 * shows the Autopilot state and the topics around its calendar, which reads
 * the articles itself (GET /api/calendar/get); today and the week are for
 * `get_content`, in words.
 *
 * Reads only, through the caller's client (RLS, or the owner-scoped service
 * role), every one filtered by `business_id`: the site, this week's
 * articles, the free pool, the site's topics (keywords, articles, stored
 * results pages), and, while Autopilot is off, the question ideas. No body
 * is read and no model or provider is asked: free.
 */

/** How many next topics the screen lists before "All topics". */
export const NEXT_TOPICS_SHOWN = 5;
export const NEXT_TOPICS_MAX = 50;

export interface ContentView {
  /** The UTC day the view was built for, YYYY-MM-DD. */
  today: string;
  site: { name: string | null; host: string | null };
  autopilot: boolean;
  /**
   * What Autopilot's last run did for this site, and why it did less than
   * the calendar needed when it did (lib/automation/run-status.ts). Null
   * while Autopilot is off.
   */
  autopilotRun: AutopilotRunView | null;
  /** The article on today's calendar day; null when the day is empty. */
  todayArticle: ContentArticle | null;
  /** Monday to Sunday of today's week. */
  week: ContentDay[];
  nextTopics: ContentTopic[];
  /** Topics Autopilot can pick from, beyond the ones listed. */
  topicsTotal: number;
  /** Topics in the pool that overlap one already written or scheduled: never picked. */
  topicsHeldBack: number;
  /** Groups of near-duplicate topics ("Overlapping topics"). */
  overlapGroups: number;
  /**
   * Questions people ask, not yet a topic, while Autopilot is off (a person
   * adds them). Null while it is on: it adds them on its own, so they are
   * not counted here.
   */
  questionsWaiting: number | null;
  /** Every article of the site, any state (`get_content`; the screen draws them on its calendar). */
  articlesTotal: number;
}

export type ContentRead = { ok: true; view: ContentView } | { ok: false; error: string };

type Row = Record<string, unknown>;
const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
const num = (value: unknown): number | null =>
  value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);

function joinedKeyword(row: Row): string {
  const joined = row.keywords as { keyword?: unknown } | Array<{ keyword?: unknown }> | null | undefined;
  const first = Array.isArray(joined) ? joined[0] : joined;
  return typeof first?.keyword === "string" ? first.keyword : "";
}

export async function loadContentView(
  supabase: SupabaseClient,
  businessId: string,
  options: { now?: Date; topicLimit?: number } = {}
): Promise<ContentRead> {
  const today = utcDay(options.now ?? new Date());
  const days = weekDays(today);

  const [business, weekRows, pool, topics] = await Promise.all([
    supabase.from("businesses").select("name, website_url, automation_settings").eq("id", businessId).maybeSingle(),
    supabase
      .from("articles")
      .select(
        `id, scheduled_date, status, published_url, last_error, quality_report, keyword_id,
         title:canonical->>title,
         keywords!articles_keyword_id_fkey ( keyword )`
      )
      .eq("business_id", businessId)
      .gte("scheduled_date", days[0])
      .lte("scheduled_date", days[6])
      .order("scheduled_date", { ascending: true }),
    supabase
      .from("keywords")
      .select("id, keyword, opportunity, difficulty, search_volume, source, source_url, is_starred, created_at, intent")
      .eq("business_id", businessId)
      .is("article_id", null)
      .eq("status", "available"),
    loadSiteTopics(supabase, businessId, { serp: true }),
  ]);

  const failed = business.error ?? weekRows.error ?? pool.error;
  if (failed) return { ok: false, error: failed.message };
  if (!topics.ok) return { ok: false, error: String((topics.error as { message?: string })?.message ?? topics.error) };

  const site = (business.data ?? {}) as Row;
  const autopilot = parseAutomationSettings(site.automation_settings).enabled;
  const autopilotRun = autopilot ? describeAutopilotRun({ enabled: true, run: await readAutopilotRun(supabase, businessId) }) : null;

  // While Autopilot is on it adds the questions itself; reading them here
  // would only say how many it has not reached yet.
  let questionsWaiting: number | null = null;
  if (!autopilot) {
    const ideas = await loadQuestionIdeas(supabase, businessId);
    if (ideas.ok) questionsWaiting = ideas.questions.length;
    else console.error("Error reading question ideas for Content:", ideas.error);
  }

  const articles: PlanArticle[] = ((weekRows.data ?? []) as Row[]).map((row) => ({
    id: String(row.id),
    scheduledDate: str(row.scheduled_date),
    status: String(row.status ?? ""),
    title: str(row.title),
    keyword: joinedKeyword(row),
    publishedUrl: str(row.published_url),
    lastError: str(row.last_error),
    qualityReport: row.quality_report ?? null,
  }));
  const week = describeWeek(articles, today);

  const free: PoolTopic[] = ((pool.data ?? []) as Row[]).flatMap((row) => {
    const keyword = str(row.keyword);
    if (!keyword) return [];
    return [
      {
        id: String(row.id),
        keyword,
        opportunity: str(row.opportunity),
        difficulty: num(row.difficulty),
        searchVolume: num(row.search_volume),
        source: row.source ?? null,
        sourceUrl: str(row.source_url),
        starred: row.is_starred === true,
        createdAt: str(row.created_at),
        intent: row.intent ?? null,
      },
    ];
  });
  const limit = Math.max(0, Math.min(options.topicLimit ?? NEXT_TOPICS_SHOWN, NEXT_TOPICS_MAX));
  const next = nextTopics({ pool: free, topics, limit });

  return {
    ok: true,
    view: {
      today,
      site: { name: str(site.name), host: businessHostname(str(site.website_url)) },
      autopilot,
      autopilotRun,
      todayArticle: week.find((d) => d.isToday)?.article ?? null,
      week,
      nextTopics: next.topics,
      topicsTotal: next.total,
      topicsHeldBack: next.heldBack,
      overlapGroups: countOverlapClusters(topics),
      questionsWaiting,
      articlesTotal: topics.articles.length,
    },
  };
}
