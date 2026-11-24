import { z } from "zod";
import { loadContentView, NEXT_TOPICS_MAX, NEXT_TOPICS_SHOWN } from "@/lib/calendar/content";
import { CONTENT_STATUSES, WEEKDAYS } from "@/lib/calendar/content-plan";
import { INTENT_DESCRIPTION, TOPIC_INTENTS } from "@/lib/keywords/intent";
import { TOPIC_SOURCES } from "@/lib/keywords/source";
import { AUTOPILOT_REASON_CODES } from "@/lib/automation/run-status";
import { defineTool } from "./tool";

/**
 * Content (`/content`) as a tool, read by the function GET /api/content
 * reads (lib/calendar/content.ts): the Autopilot state and the topics the
 * screen shows above and under its calendar, with today and the week in
 * words (the screen draws those on the calendar; list_calendar lists every
 * article). Free.
 *
 * Every action of the screen is a tool already: a topic is added with
 * add_keywords and removed with delete_keywords, an article is read with
 * get_article, rewritten with generate_article, re-checked with
 * resettle_article, published with publish_article, moved with
 * reschedule_article, taken off with unschedule_article and retried with
 * retry_article; the full lists are list_calendar, list_keywords,
 * list_duplicate_keywords and list_question_ideas.
 */

const ContentArticleView = z.object({
  id: z.string().describe("The article's id: get_article reads it."),
  day: z.string().nullable().describe("Its calendar day, YYYY-MM-DD (UTC)."),
  title: z.string().nullable().describe("The written title, else the keyword it is written for."),
  keyword: z.string(),
  status: z
    .enum(CONTENT_STATUSES)
    .describe(
      "In the screen's words: published; scheduled (queued); writing (generating); written (generated, not on the site yet); waiting (needs_review: held for the owner, see reasons); skipped (failed: writing failed, retry_article puts it back); other (a state this build does not know, see articleStatus)."
    ),
  articleStatus: z.string().describe("The lifecycle state as stored: queued, generating, generated, needs_review, published, failed."),
  publishedUrl: z.string().nullable(),
  reasons: z.array(z.string()).describe("For waiting: why it was held, as the screen says it; never empty then. Empty otherwise."),
  lastError: z.string().nullable().describe("For skipped: the last error recorded."),
});

export const getContent = defineTool({
  name: "get_content",
  title: "Get Content",
  description:
    "Content, the screen whose first view is the calendar of every article (/content; an article opens there at /content?article=<id>), in one read: whether Autopilot is on and what its last run did for this site (and, when it left days empty or skipped the site, why, in words), today's article (title, status in words, why it waits when it does), this week Monday to Sunday (one row a day, null when the day is empty), the next topics Autopilot picks from, in its order (a week at a time, what the week lacks of the mix of comparison, platform how-to and problem pieces first, then by score), with where each came from (autopilot, question asked in a public thread, added by hand, or not recorded for topics older than 2026-11-14) and the kind of search it answers, and the counts behind the screen's links: topics, topics held back for overlapping, groups of overlapping topics, questions people ask not yet added (null while Autopilot adds them on its own), all articles. Days are UTC. Reads the site's own rows: no model is asked.",
  input: z.object({
    topics: z
      .number()
      .int()
      .min(0)
      .max(NEXT_TOPICS_MAX)
      .default(NEXT_TOPICS_SHOWN)
      .describe(`How many next topics to list; the screen shows ${NEXT_TOPICS_SHOWN}.`),
  }),
  output: z.object({
    today: z.string().describe("The UTC day the answer was built for."),
    site: z.object({ name: z.string().nullable(), host: z.string().nullable() }),
    autopilot: z.boolean().describe("Autopilot on: it schedules a topic a day and adds questions people ask (3 a day at most) on its own."),
    autopilotRun: z
      .object({
        state: z
          .enum(["not_run_yet", "working", "stalled", "skipped"])
          .describe(
            "not_run_yet: on, but the daily run (06:00 UTC) has not reached this site since it was turned on; working: the last run did what the calendar needed; stalled: it did less, see message and reasons; skipped: the site was skipped whole (no active plan)."
          ),
        message: z.string().describe("The state in one sentence, as the Content screen says it."),
        lastRun: z
          .object({
            at: z.string().describe("When the last run finished for this site (ISO, UTC)."),
            scheduled: z.number().describe("Articles it put on the calendar."),
            topicsAdded: z.number().describe("Topics its top-up bought."),
            questionsAdded: z.number().describe("Questions people ask it added to the pool."),
            emptyDays: z.number().nullable().describe("Days from tomorrow to bufferDays ahead still without an article after the run; null when the run did not get that far."),
            bufferDays: z.number(),
            reasons: z
              .array(z.object({ code: z.enum(AUTOPILOT_REASON_CODES), message: z.string() }))
              .describe(
                "Why it did less than the calendar needed; empty when it did not. no_plan: no active plan, the site was skipped; ai_limit / ai_paused: new topics wait, scheduling went on; pool_overlaps: topics not scheduled because each overlaps one already covered; no_new_topics: the top-up found nothing new; days_empty: no topic left for the empty days; failed: the run stopped with an error and is tried again next run. add_keywords adds topics; schedule_keywords schedules one by hand."
              ),
          })
          .nullable(),
      })
      .nullable()
      .describe("Null while Autopilot is off for this site. Every site of an account has its own Autopilot setting."),
    todayArticle: ContentArticleView.nullable().describe("Null: nothing is on the calendar today."),
    week: z.array(
      z.object({
        day: z.string(),
        weekday: z.enum(WEEKDAYS),
        isToday: z.boolean(),
        article: ContentArticleView.nullable().describe("Null: an empty day."),
      })
    ),
    nextTopics: z.array(
      z.object({
        id: z.string().describe("The keyword's id: delete_keywords removes it, schedule_keywords puts it on the calendar."),
        keyword: z.string(),
        source: z
          .enum(TOPIC_SOURCES)
          .describe("question: asked in a public thread; autopilot: bought by Autopilot's top-up; manual: added by a person or their key; unknown: added before 2026-11-14, not recorded."),
        sourceUrl: z.string().nullable().describe("For a question, one thread that asks it."),
        starred: z.boolean(),
        intent: z.enum(TOPIC_INTENTS).describe(INTENT_DESCRIPTION),
      })
    ),
    topicsTotal: z.number().describe("Topics Autopilot can pick from."),
    topicsHeldBack: z.number().describe("Topics in the pool Autopilot never picks: each overlaps one already scheduled, written or published."),
    overlapGroups: z.number().describe("Groups of near-duplicate topics; list_duplicate_keywords lists them."),
    questionsWaiting: z
      .number()
      .nullable()
      .describe("Questions people ask not yet a topic (list_question_ideas). Null while Autopilot is on: it adds them itself."),
    articlesTotal: z.number().describe("Every article of the site, in any state; list_calendar lists them."),
  }),
  scope: "read",
  paid: false,
  async handler(ctx, input) {
    const read = await loadContentView(ctx.client, ctx.businessId, { topicLimit: input.topics });
    if (!read.ok) throw new Error(`content: ${read.error}`);
    return read.view;
  },
});

export const CONTENT_READ_TOOLS = [getContent] as const;
