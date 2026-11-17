import { z } from "zod";
import { listArticlePushes, requestArticlePush, resolveArticlePush } from "@/lib/lifecycle/push-store";
import { defineTool, ToolError } from "./tool";

/**
 * Push page 3 as tools (docs/LIFECYCLE.md, "Push page 3"; docs/API.md): the
 * pushes of the site (`list_article_pushes`), one article pushed now
 * (`push_article`, the modal's "Push this article"), and the answer to a
 * proposal (`resolve_article_push`, Today's "I added it" / "Dismiss"). Each
 * handler calls the function the routes call (lib/lifecycle/push-store.ts).
 */

const After = z
  .object({
    start: z.string(),
    end: z.string(),
    days: z.number(),
    position: z.number().nullable().describe("Impression-weighted average position in the window; null when the article had no impression."),
    impressions: z.number(),
    clicks: z.number(),
    measuredAt: z.string(),
  })
  .nullable()
  .describe("Null until Search Console's data covers the window: not measured yet, never 0.");

const PushView = z.object({
  id: z.string(),
  articleId: z.string(),
  origin: z.enum(["sweep", "on_demand"]),
  status: z
    .enum(["selected", "proposed", "applied", "skipped", "failed", "dismissed"])
    .describe("selected: running. proposed: for the person to apply on their site. applied: live (by the platform, or marked by the person). skipped: not pushed, see skipReason."),
  skipReason: z.string().nullable(),
  mainQuery: z.string().nullable().describe("The Search Console query with the most impressions for the page over 28 days."),
  query: z.object({ impressions: z.number().nullable(), clicks: z.number().nullable(), position: z.number().nullable() }),
  before: z
    .object({
      start: z.string().nullable(),
      end: z.string().nullable(),
      position: z.number().nullable(),
      impressions: z.number().nullable(),
      clicks: z.number().nullable(),
    })
    .describe("The 28 days before the push, from Search Console."),
  links: z.array(
    z.object({
      fromArticleId: z.string(),
      fromUrl: z.string(),
      fromTitle: z.string(),
      anchor: z.string().nullable(),
      mode: z.enum(["existing", "sentence"]).nullable().describe("existing: the page's own words became the link; sentence: one short sentence added."),
      sentence: z.string().nullable(),
      status: z.enum(["applied", "proposed", "not_delivered", "skipped"]),
      reason: z.string().nullable(),
    })
  ),
  title: z.object({ old: z.string().nullable(), new: z.string().nullable() }).describe("The meta title (search results); the headline and the URL never change."),
  metaDescription: z.object({ old: z.string().nullable(), new: z.string().nullable() }),
  appliedBy: z.enum(["platform", "customer"]).nullable(),
  appliedAt: z.string().nullable(),
  after14: After,
  after28: After,
  line: z.string().nullable().describe("What Growth prints: 'Pushed Nov 16: 37 → 29', 'no change yet', 'not measured yet'."),
  createdAt: z.string(),
});

export const listArticlePushesTool = defineTool({
  name: "list_article_pushes",
  title: "List article pushes",
  description:
    "Push page 3: the site's pushes of articles stuck at Google positions 11 to 40, newest first: the main query, the 28-day baseline, the links added from the site's best pages (or proposed, for the person to add), the old and new meta title and description, and the position, impressions and clicks 14 and 28 days after (null until measured, never invented). Reads stored rows only.",
  input: z.object({
    articleId: z.string().uuid().optional(),
    status: z.enum(["selected", "proposed", "applied", "skipped", "failed", "dismissed"]).optional(),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  output: z.object({ pushes: z.array(PushView) }),
  scope: "read",
  paid: false,
  owns: { articleId: "articles" },
  async handler(ctx, input) {
    return { pushes: await listArticlePushes(ctx.client, ctx.businessId, input) };
  },
});

export const pushArticleTool = defineTool({
  name: "push_article",
  title: "Push an article",
  description:
    "Pushes one published article now (Push page 3): its main Search Console query is read, up to 3 of the site's best related pages get one contextual link to it with that query (or a variant) as anchor, and its meta title and description are tightened around the query (the headline and URL stay). Where the site takes updates (webhook, WordPress with the post id) the changes are delivered; otherwise they are stored as a proposal for the person. Needs Search Console; refused for an article pushed in the last 28 days or changed in the last 14. One model call; runs as a job (status 'selected' until it finishes).",
  input: z.object({ articleId: z.string().uuid() }),
  output: z.object({ push: PushView }),
  scope: "write",
  paid: true,
  owns: { articleId: "articles" },
  async handler(ctx, input) {
    const result = await requestArticlePush({ admin: ctx.admin(), userId: ctx.userId, businessId: ctx.businessId, articleId: input.articleId });
    if (!result.ok) throw new ToolError(result.code === "not_found" ? "not_found" : "invalid_state", result.error, result.status);
    return { push: result.push };
  },
});

export const resolveArticlePushTool = defineTool({
  name: "resolve_article_push",
  title: "Answer a push proposal",
  description:
    "Answers a proposed push (one the site could not take as an update): action 'applied' once the person added the links and title on their site (the measurement starts that day), or 'dismissed'. Only a push in status 'proposed'.",
  input: z.object({ pushId: z.string().uuid(), action: z.enum(["applied", "dismissed"]) }),
  output: z.object({ push: PushView }),
  scope: "write",
  paid: false,
  owns: { pushId: "article_pushes" },
  async handler(ctx, input) {
    const result = await resolveArticlePush({ admin: ctx.admin(), userId: ctx.userId, businessId: ctx.businessId, pushId: input.pushId, action: input.action });
    if (!result.ok) throw new ToolError(result.code === "not_found" ? "not_found" : "invalid_state", result.error, result.status);
    return { push: result.push };
  },
});

export const ARTICLE_PUSH_TOOLS = [listArticlePushesTool, pushArticleTool, resolveArticlePushTool] as const;
