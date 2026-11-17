import { z } from "zod";
import { listCalendarItems, loadArticle } from "@/lib/calendar/read";
import { exportArticle } from "@/lib/content/export";
import { ARTICLE_STATES } from "@/lib/domain/lifecycle";
import { listDeliveries, MAX_DELIVERIES } from "@/lib/integrations/deliveries";
import { defineTool, ToolError } from "./tool";

/**
 * Articles as an agent reads them: the calendar (`list_calendar`), one
 * article in the format it wants (`get_article`), and what happened when
 * articles were sent to the site (`list_deliveries`).
 *
 * Each handler calls the function the screen reads with
 * (lib/calendar/read.ts, lib/content/export.ts,
 * lib/integrations/deliveries.ts). The runner has checked that an
 * `articleId` is a row of this account and this site (`owns`). All free.
 */

const ArticleId = z.string().uuid().describe("An article's id, from list_calendar.");
const Day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "a day as YYYY-MM-DD")
  .describe("A calendar day, YYYY-MM-DD.");

export const CalendarItemView = z.object({
  id: z.string(),
  keywordId: z.string().nullable(),
  keyword: z.string().describe("The keyword the article is written for; empty when it was removed."),
  searchVolume: z.number().nullable().describe("A model's estimate of monthly searches, not measured data; null when unknown."),
  title: z.string().nullable().describe("The written article's title; null before it is written."),
  scheduledDate: z.string().nullable(),
  status: z.string().describe("queued, generating, generated, needs_review (a person must look), published or failed."),
  publishedUrl: z.string().nullable(),
  lastError: z.string().nullable().describe("Why the last generation or publish failed, when one did."),
});

export const listCalendar = defineTool({
  name: "list_calendar",
  title: "List the calendar",
  description:
    "The site's content calendar by day: one article per keyword, with its status, title once written, live link once published and the last error. No bodies: read one with get_article. Filter by a day range (from, to, inclusive) and a status.",
  input: z.object({
    from: Day.optional(),
    to: Day.optional(),
    status: z.enum(ARTICLE_STATES).optional(),
  }),
  output: z.object({ items: z.array(CalendarItemView), total: z.number() }),
  scope: "read",
  paid: false,
  async handler(ctx, input) {
    const items = await listCalendarItems(ctx.client, ctx.businessId, {
      from: input.from,
      to: input.to,
      status: input.status,
    });
    return { items, total: items.length };
  },
});

// Lenient on purpose: documents and reports stored by older pipelines are read back as they are.
const QualityIssue = z.looseObject({
  code: z.string().optional(),
  action: z.string().optional().describe("warn: recorded only; review: a person must look before it goes out; regenerate: rewrite it."),
  stage: z.string().optional(),
  message: z.string().optional(),
  evidence: z.string().optional(),
});

const QualityReportView = z
  .looseObject({
    decision: z.string().optional().describe("publish, needs_review or regenerate."),
    ranAt: z.string().optional(),
    wordCount: z.number().nullable().optional(),
    issues: z.array(QualityIssue).optional(),
  })
  .describe("How the quality gates judged the article when it was written.");

const ARTICLE_FORMATS = ["canonical", "html", "markdown"] as const;

export const getArticle = defineTool({
  name: "get_article",
  title: "Get an article",
  description:
    "One article with its quality report. format canonical (default) answers the structured Canonical Article the publishers receive (title, bodyHtml, headings, excerpt, metaDescription, slug, media); html and markdown answer the article as Copy HTML and Copy Markdown give it (title, hero image, body) in body. canonical is null for an article not written yet, or written before the canonical pipeline (ask for html then).",
  input: z.object({
    articleId: ArticleId,
    format: z.enum(ARTICLE_FORMATS).default("canonical"),
  }),
  output: z.object({
    article: CalendarItemView.extend({ createdAt: z.string().nullable(), updatedAt: z.string().nullable() }),
    format: z.enum(ARTICLE_FORMATS),
    canonical: z
      .record(z.string(), z.unknown())
      .nullable()
      .describe("format canonical: the Canonical Article. Null for the other formats."),
    body: z.string().nullable().describe("format html or markdown: the whole article. Null for canonical, and when nothing is written yet."),
    qualityReport: QualityReportView.nullable(),
  }),
  scope: "read",
  paid: false,
  owns: { articleId: "articles" },
  async handler(ctx, input) {
    const record = await loadArticle(ctx.client, ctx.businessId, input.articleId);
    if (!record) throw new ToolError("not_found", "No article with that articleId on this site.", 404);
    const { canonical, content, qualityReport, ...article } = record;
    const body = input.format === "canonical" ? null : exportArticle({ canonical, content }, input.format) || null;
    return {
      article,
      format: input.format,
      canonical: input.format === "canonical" ? ((canonical as unknown as Record<string, unknown>) ?? null) : null,
      body,
      qualityReport: (qualityReport as unknown as z.input<typeof QualityReportView>) ?? null,
    };
  },
});

const DELIVERY_TYPES = ["wordpress", "webflow", "shopify", "webhook"] as const;

export const listDeliveriesTool = defineTool({
  name: "list_deliveries",
  title: "List deliveries",
  description:
    "The site's latest publish attempts, newest first, as Settings → Connections → Recent deliveries lists them: which article, to which destination type, whether it worked, the live link or the error. Failed attempts are listed too. Filter by destination type.",
  input: z.object({
    type: z.enum(DELIVERY_TYPES).optional().describe("Only this destination type."),
    limit: z.number().int().min(1).max(MAX_DELIVERIES).default(20),
  }),
  output: z.object({
    deliveries: z.array(
      z.object({
        id: z.string(),
        articleId: z.string().nullable(),
        integrationType: z.string(),
        ok: z.boolean(),
        publishedUrl: z.string().nullable(),
        error: z.string().nullable(),
        createdAt: z.string(),
      })
    ),
  }),
  scope: "read",
  paid: false,
  async handler(ctx, input) {
    const deliveries = await listDeliveries(ctx.client, {
      userId: ctx.userId,
      businessId: ctx.businessId,
      integrationType: input.type ?? null,
      limit: input.limit,
    });
    return { deliveries };
  },
});

export const ARTICLE_READ_TOOLS = [listCalendar, getArticle, listDeliveriesTool] as const;
