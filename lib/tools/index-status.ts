import { z } from "zod";
import { DAILY_INSPECTION_CAP, inspectUrlNow, listIndexStatus } from "@/lib/analytics/index-status";
import { defineTool, ToolError } from "./tool";

/**
 * Indexing status as tools: what Google's URL Inspection said about the
 * site's URLs (`list_index_status`), and asking it again for one URL
 * (`inspect_url`, the article modal's "Check now"). Each handler calls the
 * function the routes call (lib/analytics/index-status.ts).
 *
 * Free: Google does not charge for the Search Console API. `inspect_url` is
 * a write all the same, because it asks Google on the site's grant, uses
 * the property's daily quota and stores the answer.
 */

const IndexState = z.enum(["indexed", "not_indexed", "unknown"]);

const IndexRow = z.object({
  url: z.string(),
  articleId: z.string().nullable(),
  checkedAt: z.string().describe("When Google was asked."),
  verdict: z.string().describe("Google's verdict: PASS, FAIL, NEUTRAL, PARTIAL or VERDICT_UNSPECIFIED."),
  state: IndexState.describe("indexed (PASS), not_indexed (FAIL or NEUTRAL), unknown (no verdict)."),
  coverageState: z.string().nullable().describe("Google's own sentence: 'Submitted and indexed', 'Page with redirect', 'Crawled - currently not indexed'."),
  indexingState: z.string().nullable(),
  robotsState: z.string().nullable(),
  fetchState: z.string().nullable(),
  googleCanonical: z.string().nullable(),
  userCanonical: z.string().nullable(),
  lastCrawlAt: z.string().nullable(),
  inspectionResultLink: z.string().nullable().describe("Google's report for this URL, for a person to open."),
});

export const listIndexStatusTool = defineTool({
  name: "list_index_status",
  title: "List indexing status",
  description:
    "Whether Google has this site's URLs in its index, from Google's URL Inspection: the latest answer per URL, with Google's reason in its own words (coverageState) when a page is not indexed, and a summary (counts per state, from checked URLs only, 'N of M checked'). A URL never inspected has no row: it is not checked, not 'not indexed'. Filter by `state` or an exact `coverageState`. Reads stored rows; asks Google nothing.",
  input: z.object({
    state: IndexState.optional(),
    coverageState: z.string().trim().min(1).max(200).optional(),
    articleId: z.string().uuid().optional(),
    limit: z.number().int().min(1).max(500).default(200),
  }),
  output: z.object({
    connected: z.boolean().describe("False when Search Console is not connected: nothing can be inspected."),
    siteUrl: z.string().nullable(),
    summary: z.object({
      total: z.number().describe("The site's published URLs inside the property."),
      checked: z.number(),
      indexed: z.number(),
      notIndexed: z.number(),
      unknown: z.number(),
      byCoverageState: z.array(z.object({ coverageState: z.string(), state: IndexState, count: z.number() })),
      caption: z.string().nullable(),
    }),
    rows: z.array(IndexRow),
  }),
  scope: "read",
  paid: false,
  owns: { articleId: "articles" },
  async handler(ctx, input) {
    const listing = await listIndexStatus(ctx.client, ctx.businessId, input);
    const { total, checked, indexed, notIndexed, unknown, byCoverageState, caption } = listing.summary;
    return {
      connected: listing.connected,
      siteUrl: listing.siteUrl,
      summary: { total, checked, indexed, notIndexed, unknown, byCoverageState, caption },
      rows: listing.rows,
    };
  },
});

export const inspectUrlTool = defineTool({
  name: "inspect_url",
  title: "Inspect a URL on Google",
  description: `Asks Google's URL Inspection about one URL of this site now ("Check now"), stores the answer and returns it: indexed or not, and Google's reason in its own words. No model is asked, but it uses the property's Google quota: at most ${DAILY_INSPECTION_CAP} inspections per site per day, and a URL checked in the last 10 minutes answers the stored result (fresh: false). The URL must be inside the site's Search Console property; give it as \`url\`, or give a published article's \`articleId\`.`,
  input: z.object({
    url: z.string().trim().min(1).max(2000).optional(),
    articleId: z.string().uuid().optional(),
  }),
  output: z.object({ row: IndexRow, fresh: z.boolean().describe("False when the stored answer from the last 10 minutes was returned.") }),
  scope: "write",
  paid: false,
  owns: { articleId: "articles" },
  async handler(ctx, input) {
    if (!input.url && !input.articleId) {
      throw new ToolError("invalid_input", "Give the url to inspect, or a published article's articleId.", 400);
    }
    const result = await inspectUrlNow({
      admin: ctx.admin(),
      userId: ctx.userId,
      businessId: ctx.businessId,
      url: input.url,
      articleId: input.articleId,
    });
    if (!result.ok) {
      throw new ToolError(result.code, result.error, result.status);
    }
    return { row: result.row, fresh: result.fresh };
  },
});

export const INDEX_STATUS_TOOLS = [listIndexStatusTool, inspectUrlTool] as const;
