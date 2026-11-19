import { z } from "zod";
import {
  dismissFailedArticles,
  MAX_BULK_SCHEDULE,
  MAX_DISMISS,
  ownerMove,
  rescheduleArticle,
  rescheduleDateRefusal,
  retryArticle,
  scheduleKeywords,
  sessionMove,
  unscheduleArticle,
} from "@/lib/calendar/manage";
import { defineTool, ToolError } from "./tool";
import { libRefusal } from "./write-guards";

/**
 * The calendar's writes as tools (`/calendar`). Each handler calls the
 * function the calendar's route calls (lib/calendar/manage.ts). The runner
 * has already checked the key's scopes, the site, that every keyword or
 * article id is this site's (`owns`), and, for scheduling, the paywall.
 */

const ArticleId = z.string().uuid().describe("A calendar article's id.");
const Day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "a day as YYYY-MM-DD")
  .describe("A UTC day, YYYY-MM-DD, today or later.");

export const scheduleKeywordsTool = defineTool({
  name: "schedule_keywords",
  title: "Add keywords to the calendar",
  description: `Puts keywords of this site on the calendar, one article per day on the site's first free days after today, in order; each becomes an article the daily generation writes (and publishes) on its day. Keywords already on the calendar are skipped. A keyword whose near-duplicate is already scheduled, being written or published (or was scheduled earlier in this call) is never scheduled: it stays in the pool and is listed in overlapping with the topic it overlaps, because two articles on one topic compete with each other; list_duplicate_keywords shows the clusters. Up to ${MAX_BULK_SCHEDULE} at once. Needs an active subscription, like the screen.`,
  input: z.object({
    keywordIds: z
      .array(z.string().uuid())
      .min(1)
      .max(MAX_BULK_SCHEDULE)
      .describe(`1 to ${MAX_BULK_SCHEDULE} keyword ids of this site.`),
  }),
  output: z.object({
    added: z.number(),
    skipped: z.number().describe("Keywords not scheduled: already on the calendar, or overlapping (those are detailed in overlapping)."),
    articles: z.array(z.object({ articleId: z.string(), keywordId: z.string(), scheduledDate: z.string() })),
    overlapping: z
      .array(
        z.object({
          keywordId: z.string(),
          keyword: z.string(),
          reason: z.string().describe("Why it was left out, in words."),
          duplicateOf: z.object({
            keywordId: z.string().nullable(),
            keyword: z.string().nullable(),
            status: z.string().nullable(),
            articleId: z.string().nullable(),
            articleTitle: z.string().nullable(),
            publishedUrl: z.string().nullable(),
          }),
        })
      )
      .describe("Keywords left in the pool because a near-duplicate is already scheduled, being written or published."),
    message: z.string(),
  }),
  scope: "write",
  paid: false,
  requiresSubscription: true,
  owns: { keywordIds: "keywords" },
  async handler(ctx, input) {
    const keywordIds = [...new Set(input.keywordIds)];
    const result = await scheduleKeywords({
      supabase: ctx.client,
      userId: ctx.userId,
      businessId: ctx.businessId,
      keywordIds,
    });
    if (!result.ok) throw libRefusal(result);
    return {
      added: result.added,
      skipped: keywordIds.length - result.added,
      articles: result.articles,
      overlapping: result.overlapping.map((o) => ({
        keywordId: o.keywordId,
        keyword: o.keyword,
        reason: o.reason,
        duplicateOf: {
          keywordId: o.duplicateOf.keywordId,
          keyword: o.duplicateOf.keyword,
          status: o.duplicateOf.status,
          articleId: o.duplicateOf.articleId,
          articleTitle: o.duplicateOf.articleTitle,
          publishedUrl: o.duplicateOf.publishedUrl,
        },
      })),
      message: result.message,
    };
  },
});

export const rescheduleArticleTool = defineTool({
  name: "reschedule_article",
  title: "Move an article",
  description:
    "Moves one of this site's calendar articles to another day, today or later. If an article is already on that day, the two swap days: a site has one article per day.",
  input: z.object({ articleId: ArticleId, date: Day }),
  output: z.object({ articleId: z.string(), scheduledDate: z.string() }),
  scope: "write",
  paid: false,
  owns: { articleId: "articles" },
  async handler(ctx, input) {
    const refused = rescheduleDateRefusal(input.date);
    if (refused) throw new ToolError("invalid_input", refused, 400);
    // A session moves through the person's own client (move_article reads
    // auth.uid()); an API key has no user JWT, so the service role runs the
    // same move naming the owner the key was verified for.
    const move = ctx.via === "session" ? sessionMove(ctx.client) : ownerMove(ctx.admin(), ctx.userId);
    const result = await rescheduleArticle({
      supabase: ctx.client,
      userId: ctx.userId,
      businessId: ctx.businessId,
      articleId: input.articleId,
      targetDate: input.date,
      move,
    });
    if (!result.ok) throw libRefusal(result);
    return { articleId: input.articleId, scheduledDate: input.date };
  },
});

export const unscheduleArticleTool = defineTool({
  name: "unschedule_article",
  title: "Remove from the calendar",
  description:
    "Takes an article off this site's calendar and deletes it; its keyword goes back to the pool as available. What the article had already published elsewhere stays there.",
  input: z.object({ articleId: ArticleId }),
  output: z.object({ articleId: z.string(), keywordId: z.string().nullable().describe("The keyword, available again.") }),
  scope: "write",
  paid: false,
  destructive: true,
  owns: { articleId: "articles" },
  async handler(ctx, input) {
    const result = await unscheduleArticle({
      supabase: ctx.client,
      userId: ctx.userId,
      businessId: ctx.businessId,
      articleId: input.articleId,
    });
    if (!result.ok) throw libRefusal(result);
    return { articleId: input.articleId, keywordId: result.keywordId };
  },
});

export const retryArticleTool = defineTool({
  name: "retry_article",
  title: "Retry a failed article",
  description:
    "Puts a failed article back in the queue with a fresh attempt count; the next generation run writes it. Only a failed article can be retried.",
  input: z.object({ articleId: ArticleId }),
  output: z.object({ articleId: z.string(), status: z.literal("queued") }),
  scope: "write",
  paid: false,
  owns: { articleId: "articles" },
  async handler(ctx, input) {
    const result = await retryArticle({
      supabase: ctx.client,
      userId: ctx.userId,
      businessId: ctx.businessId,
      articleId: input.articleId,
    });
    if (!result.ok) {
      // The runner found the article on this site: a miss here means it is not failed.
      if (result.status === 404) {
        throw new ToolError("invalid_state", "This article is not in a failed state; only a failed article can be retried.", 409);
      }
      throw libRefusal(result);
    }
    return { articleId: input.articleId, status: "queued" as const };
  },
});

export const dismissFailedArticlesTool = defineTool({
  name: "dismiss_failed_articles",
  title: "Ignore failed articles on Today",
  description: `Takes failed articles off Today's "Also today" without retrying or deleting them: they stay failed and stay on the Content board, where retry_article or unschedule_article still work. articleIds names which (up to ${MAX_DISMISS}); left out, every failed article of this site. Retrying an article clears the mark, so a new failure shows again. Articles that are not failed are left alone.`,
  input: z.object({
    articleIds: z
      .array(ArticleId)
      .min(1)
      .max(MAX_DISMISS)
      .optional()
      .describe(`1 to ${MAX_DISMISS} failed articles of this site; left out, all of them.`),
  }),
  output: z.object({
    dismissed: z.number().describe("Failed articles taken off Today by this call."),
    articleIds: z.array(z.string()),
  }),
  scope: "write",
  paid: false,
  owns: { articleIds: "articles" },
  async handler(ctx, input) {
    const result = await dismissFailedArticles({
      supabase: ctx.client,
      userId: ctx.userId,
      businessId: ctx.businessId,
      articleIds: input.articleIds,
    });
    if (!result.ok) throw libRefusal(result);
    return { dismissed: result.dismissed, articleIds: result.articleIds };
  },
});

export const WRITE_CALENDAR_TOOLS = [
  scheduleKeywordsTool,
  rescheduleArticleTool,
  unscheduleArticleTool,
  retryArticleTool,
  dismissFailedArticlesTool,
] as const;
