import { z } from "zod";
import { LINK_SEARCH_OUTCOMES } from "@/lib/placements/reply-link";
import { loadTodayScreen } from "@/lib/today/read";
import { defineTool } from "./tool";

/**
 * Today (`/today`, 2026-11-14) as a tool: the first screen of the day, read
 * by the function its route reads (lib/today/read.ts), so an agent sees the
 * list the person sees.
 */

const Tools = z.array(z.string()).describe("The tools that resolve it, the free one first.");
const Href = z.string().describe("Where the screen resolves it.");

const AlsoTodayItem = z.discriminatedUnion("kind", [
  z.object({
    kind: z.enum(["article_held", "article_failed"]).describe("article_held: a quality gate held it (needs_review); article_failed: its production failed."),
    id: z.string(),
    articleId: z.string().describe("For get_article, resettle_article, publish_article, generate_article, retry_article."),
    title: z.string().describe("The keyword it was written for."),
    scheduledDate: z.string(),
    isToday: z.boolean(),
    reason: z.string().nullable().describe("Held: the first reason, as the calendar says it. Failed: null."),
    moreReasons: z.number(),
    href: Href,
    tools: Tools,
  }),
  z.object({
    kind: z
      .literal("fact_stale")
      .describe("A dated sentence of About you more than 30 days old, or last confirmed as still true more than 30 days ago: still true?"),
    id: z.string(),
    sentence: z.string().describe("Exactly as stored: what confirm_about_you_fact takes."),
    quote: z.string(),
    dateLabel: z.string().describe("The sentence's own date."),
    confirmedOn: z.string().nullable().describe("The day (YYYY-MM-DD) it was last confirmed as still true; null when never."),
    age: z.string().describe("Since the later of its date and confirmedOn."),
    href: Href,
    tools: Tools,
  }),
  z.object({
    kind: z.literal("reply_link").describe("A reply posted on X in the last 7 days whose link GTF looked for and stopped: paste it (set_reply_link)."),
    id: z.string(),
    targetId: z.string(),
    surface: z.string(),
    url: z.string().describe("The post that was answered."),
    author: z.string().nullable(),
    community: z.string().nullable(),
    text: z.string().nullable().describe("The first line of the reply, when one is on record."),
    publishedAt: z.string(),
    outcome: z.enum(LINK_SEARCH_OUTCOMES).nullable(),
    line: z.string().describe("Why GTF stopped, in a sentence."),
    href: Href,
    tools: Tools,
  }),
  z.object({
    kind: z.literal("article_push").describe("Push page 3: links and a title proposed for an article the site could not update; list_article_pushes spells them out, resolve_article_push answers."),
    id: z.string(),
    pushId: z.string(),
    articleId: z.string(),
    title: z.string(),
    mainQuery: z.string(),
    links: z.number().describe("Links proposed for the person to add."),
    newTitle: z.boolean().describe("A new meta title or description is proposed."),
    href: Href,
    tools: Tools,
  }),
]);

export const getToday = defineTool({
  name: "get_today",
  title: "Get Today",
  description:
    "The Today screen, the first of the day: progress (replies marked as posted today in timeZone, the daily goal, and where their links stand: how many saved, found on X by GTF, still looked for on X, to paste), counts (rows in each tab: todo = open to reply now, posted = posted and still up, archive = skipped, filtered out, expired, removed; list them with list_reply_inbox status open, published_manually or archive), and alsoToday: what else needs a gesture today, each with the tools that resolve it and where the screen does. Kinds: article_held / article_failed (an article a gate held or that failed), fact_stale (a dated About you sentence over 30 days old: confirm_about_you_fact or update_voice_settings), reply_link (a reply on X whose link GTF stopped looking for: set_reply_link), article_push (a Push page 3 proposal to apply on the site: resolve_article_push). Empty when there is nothing. Reads only; no model, no paid API.",
  input: z.object({
    timeZone: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .optional()
      .describe("The IANA time zone \"today\" is read in, e.g. Europe/Berlin. Absent or unknown: UTC, and progress.timeZone says so."),
  }),
  output: z.object({
    progress: z.object({
      posted: z.number().describe("Replies marked as posted today, removed ones left out: what was recorded, never what is on the other site."),
      goal: z.number().nullable().describe("The daily goal; null when none is set (update_voice_settings, dailyReplyGoal)."),
      timeZone: z.string(),
      links: z
        .object({
          total: z.number(),
          linked: z.number(),
          foundOnX: z.number().describe("Of the linked, the links GTF found on X by itself."),
          looking: z.number().describe("Without a link, GTF still looking for it on X."),
          toPaste: z.number().describe("Without a link, for the person to paste."),
          line: z.string().describe("As the screen says it."),
          tone: z.enum(["done", "waiting", "todo"]),
        })
        .nullable()
        .describe("Null with no reply today, or when today's list could not be read."),
    }),
    counts: z
      .object({ todo: z.number(), posted: z.number(), archive: z.number() })
      .nullable()
      .describe("Rows in each tab; null when they could not be counted (unknown, not zero)."),
    alsoToday: z.array(AlsoTodayItem),
  }),
  scope: "read",
  paid: false,
  async handler(ctx, input) {
    return loadTodayScreen(ctx.client, ctx.businessId, { admin: ctx.admin, timeZone: input.timeZone ?? null });
  },
});

export const TODAY_TOOLS = [getToday] as const;
