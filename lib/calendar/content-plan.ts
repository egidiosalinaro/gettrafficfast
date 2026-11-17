import { keywordScore, withoutOverlapping } from "@/lib/automation/autopilot";
import { holdReasons, REASON_NOT_RECORDED } from "@/lib/content/hold-reasons";
import { intentOf, mixOrder, type TopicIntent } from "@/lib/keywords/intent";
import type { SiteTopics } from "@/lib/keywords/overlap";
import { topicSource, type TopicSource } from "@/lib/keywords/source";

/**
 * What the Content screen (`/content`) and `get_content` say, as pure
 * functions of the site's rows and a day: today's article, the week, and the
 * topics Autopilot picks from next. Pure and parser-free, so the screen's
 * words are tested without a browser and the tool cannot say another thing.
 *
 * Days are UTC days, the calendar's own (`articles.scheduled_date`, which
 * the generation cron reads as "due"), and the week runs Monday to Sunday.
 */

/** An article's state as the screen words it. */
export const CONTENT_STATUSES = ["published", "scheduled", "writing", "written", "waiting", "skipped", "other"] as const;
export type ContentStatus = (typeof CONTENT_STATUSES)[number];

export const CONTENT_STATUS_LABEL: Record<Exclude<ContentStatus, "other">, string> = {
  published: "Published",
  scheduled: "Scheduled",
  writing: "Writing",
  written: "Written",
  waiting: "Waiting",
  skipped: "Skipped",
};

/**
 * The lifecycle state (lib/domain/lifecycle.ts) in the screen's words:
 * queued is scheduled, generating is writing, generated is written (not on
 * the site yet), needs_review waits for the owner, failed is a day skipped
 * (writing failed three times). A state this build does not know is
 * "other", shown as stored, never folded into a known one.
 */
export function contentStatus(status: string): ContentStatus {
  switch (status) {
    case "published":
      return "published";
    case "queued":
      return "scheduled";
    case "generating":
      return "writing";
    case "generated":
      return "written";
    case "needs_review":
      return "waiting";
    case "failed":
      return "skipped";
    default:
      return "other";
  }
}

/** "Published", or the stored state in words for one this build does not know. */
export function contentStatusLabel(status: ContentStatus, stored: string): string {
  if (status !== "other") return CONTENT_STATUS_LABEL[status];
  const words = stored.replaceAll("_", " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Unknown";
}

/** A calendar row with what the screen reads of it. */
export interface PlanArticle {
  id: string;
  /** YYYY-MM-DD, or null for a row with no day. */
  scheduledDate: string | null;
  status: string;
  /** The written article's title; null before it is written. */
  title: string | null;
  /** The keyword it is written for; "" when the keyword was removed. */
  keyword: string;
  publishedUrl: string | null;
  lastError: string | null;
  qualityReport?: unknown;
}

export interface ContentArticle {
  id: string;
  day: string | null;
  /** The written title, else the keyword, else null (a legacy row with neither). */
  title: string | null;
  keyword: string;
  status: ContentStatus;
  /** The lifecycle state as stored. */
  articleStatus: string;
  publishedUrl: string | null;
  /** For a waiting article, why it was held (lib/content/hold-reasons.ts); never empty. */
  reasons: string[];
  /** For a skipped article, the last error recorded; null otherwise. */
  lastError: string | null;
}

export function contentArticle(article: PlanArticle): ContentArticle {
  const status = contentStatus(article.status);
  const reasons = status === "waiting" ? holdReasons({ qualityReport: article.qualityReport, lastError: article.lastError }) : [];
  return {
    id: article.id,
    day: article.scheduledDate ? article.scheduledDate.slice(0, 10) : null,
    title: article.title?.trim() || article.keyword.trim() || null,
    keyword: article.keyword,
    status,
    articleStatus: article.status,
    publishedUrl: article.publishedUrl,
    reasons: status === "waiting" && reasons.length === 0 ? [REASON_NOT_RECORDED] : reasons,
    lastError: status === "skipped" ? article.lastError : null,
  };
}

/** Today as the calendar counts it: the UTC day. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function addDays(day: string, offset: number): string {
  const at = new Date(`${day}T00:00:00.000Z`);
  return new Date(at.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
}

export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/** The seven days, Monday first, of the week holding `today` (YYYY-MM-DD). */
export function weekDays(today: string): string[] {
  const weekday = new Date(`${today}T00:00:00.000Z`).getUTCDay(); // 0 is Sunday
  const monday = addDays(today, -((weekday + 6) % 7));
  return WEEKDAYS.map((_, i) => addDays(monday, i));
}

export interface ContentDay {
  day: string;
  weekday: (typeof WEEKDAYS)[number];
  isToday: boolean;
  /** Null: nothing is on the calendar that day. */
  article: ContentArticle | null;
}

/**
 * Monday to Sunday of today's week, one row a day. A site has one article a
 * day; a day that holds two (rows from before that rule) shows the first.
 */
export function describeWeek(articles: readonly PlanArticle[], today: string): ContentDay[] {
  return weekDays(today).map((day, i) => {
    const found = articles.find((a) => a.scheduledDate?.slice(0, 10) === day);
    return { day, weekday: WEEKDAYS[i], isToday: day === today, article: found ? contentArticle(found) : null };
  });
}

/** A pool row with what the topic list reads of it. */
export interface PoolTopic {
  id: string;
  keyword: string;
  opportunity: string | null;
  difficulty: number | null;
  searchVolume: number | null;
  source: unknown;
  sourceUrl: string | null;
  starred: boolean;
  createdAt: string | null;
  /** `keywords.intent` as stored; absent or null for a row from before intents were. */
  intent?: unknown;
}

export interface ContentTopic {
  id: string;
  keyword: string;
  source: TopicSource;
  /** For a question, one thread that asks it. */
  sourceUrl: string | null;
  starred: boolean;
  /** The kind of search it answers (lib/keywords/intent.ts); the rules' verdict for a topic stored before intents were. */
  intent: TopicIntent;
}

export interface NextTopics {
  /** What Autopilot would pick from, best first, at most `limit`. */
  topics: ContentTopic[];
  /** Every topic Autopilot can pick from. */
  total: number;
  /** In the pool, but a near-duplicate of one already scheduled, written or published: never picked. */
  heldBack: number;
}

/**
 * The pool in the order Autopilot picks from it: a week at a time, first
 * what the week lacks of the mix (`WEEKLY_MIX`, lib/keywords/intent.ts),
 * then by `keywordScore` (the sweep's own: opportunity, then ease, then
 * volume; oldest first on a tie), without the topics it refuses for
 * overlapping one already on the calendar or published
 * (`withoutOverlapping`). The order is the one a week with nothing booked
 * yet would get; the sweep also counts what the calendar already holds.
 * Nothing is estimated here: the score reads the stored fields, and a
 * question (no fields) scores as the sweep scores it.
 */
export function nextTopics(input: { pool: readonly PoolTopic[]; topics: SiteTopics; limit: number }): NextTopics {
  const time = (value: string | null) => (value ? new Date(value).getTime() || 0 : 0);
  const scored = [...input.pool]
    .sort((a, b) => time(a.createdAt) - time(b.createdAt))
    .map((topic) => ({
      id: topic.id,
      topic,
      score: keywordScore({ opportunity: topic.opportunity, difficulty: topic.difficulty, searchVolume: topic.searchVolume }),
      intent: intentOf(topic.intent, topic.keyword),
    }));
  const { schedulable, refused } = withoutOverlapping(input.topics, scored);
  return {
    topics: mixOrder(schedulable)
      .slice(0, Math.max(0, input.limit))
      .map(({ topic, intent }) => ({
        id: topic.id,
        keyword: topic.keyword,
        source: topicSource(topic.source),
        sourceUrl: topicSource(topic.source) === "question" ? topic.sourceUrl : null,
        starred: topic.starred,
        intent,
      })),
    total: schedulable.length,
    heldBack: refused.length,
  };
}
