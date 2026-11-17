import { z } from "zod";
import { HINTS } from "@/lib/api-errors";
import { requestArticleGeneration } from "@/lib/articles/generate-now";
import { publishArticleNow, type PublishIssue, type PublishNowResult } from "@/lib/articles/publish-now";
import { resettleArticle } from "@/lib/articles/resettle";
import { JobView, WaitSeconds, readJob, runJobWithin } from "./jobs";
import { defineTool, ToolError } from "./tool";
import { reportJobCost } from "./usage";

/**
 * Producing and publishing an article, as tools: the calendar's
 * "Generate now" / "Regenerate" and "Publish".
 *
 * Each handler calls the function the screen's route calls
 * (lib/articles/generate-now.ts, lib/articles/publish-now.ts) and maps its
 * result; none holds a rule of its own. The runner has already checked the
 * key's scopes, the site, that `articleId` is an article of this account and
 * this site (`owns`), the paywall, and the key's limits.
 *
 * `publish_article` is the one tool that writes to the customer's own site,
 * and so the one that needs the `publish` scope. It also needs
 * `confirm: true`, and, for an article waiting in `needs_review`,
 * `acknowledgeQualityIssues: true`: the override a person makes on the
 * screen by pressing Publish after reading the quality report, said out
 * loud. Nothing here posts on X, Reddit or anywhere but the site's own
 * connected destination.
 */

/** Under the REST and MCP routes' 120 s, as a draft is (lib/tools/replies.ts). */
const GENERATE_BUDGET_MS = 105_000;

const ArticleId = z.string().uuid().describe("An article's id, from the calendar.");

// ── Generating (paid) ───────────────────────────────────────────────────────

export const generateArticle = defineTool({
  name: "generate_article",
  title: "Generate an article",
  description:
    "Writes one article on the calendar now, as Generate now / Regenerate does: research, outline, writing, the quality gates, then images (a durable job, several model calls). If a production job for it is already queued or running, reports that one instead of starting another. Answers with the job after waiting up to waitSeconds; it keeps running after that, and get_job says how it ended. Generating publishes nothing itself: the daily run publishes a generated article on its date (a published article's post is updated in place), and publish_article publishes it now.",
  input: z.object({ articleId: ArticleId, waitSeconds: WaitSeconds }),
  output: z.object({
    jobId: z.string().nullable(),
    status: z.string().describe("The job's status: pending, running, completed or failed."),
    alreadyRunning: z.boolean(),
    job: JobView.nullable(),
    articleStatus: z
      .string()
      .nullable()
      .describe("The article's status now: generating, generated, needs_review (the gates want a look), failed, …"),
  }),
  scope: "write",
  paid: true,
  owns: { articleId: "articles" },
  async handler(ctx, input) {
    const admin = ctx.admin();
    const started = await requestArticleGeneration({
      supabase: ctx.client,
      admin,
      userId: ctx.userId,
      businessId: ctx.businessId,
      articleId: input.articleId,
    });
    if (!started.ok) {
      throw started.code === "not_found"
        ? new ToolError("not_found", "No article with that articleId on this site.", 404)
        : new ToolError(
            "invalid_state",
            started.error,
            409,
            "Only a queued, failed, generated, needs_review or published article can be generated."
          );
    }

    if (!started.alreadyRunning) {
      await runJobWithin(admin, started.jobId, { budgetMs: GENERATE_BUDGET_MS, waitMs: input.waitSeconds * 1000 });
    }
    const job = started.jobId ? await readJob(ctx.client, ctx.businessId, started.jobId) : null;
    if (!started.alreadyRunning) await reportJobCost(ctx.reportCost, admin, job);

    const { data: article } = await ctx.client
      .from("articles")
      .select("status")
      .eq("id", input.articleId)
      .eq("business_id", ctx.businessId)
      .maybeSingle();

    return {
      jobId: started.jobId,
      status: job?.status ?? "running",
      alreadyRunning: started.alreadyRunning,
      job,
      articleStatus: (article?.status as string | undefined) ?? null,
    };
  },
});

// ── Publishing (the one tool that writes to the customer's site) ────────────

function issuesLine(issues: PublishIssue[] | undefined): string {
  const list = (issues ?? []).map((i) => i.message).filter(Boolean);
  return list.length ? ` What the checks found: ${list.join("; ").slice(0, 1000)}` : "";
}

/** The function's refusal as the API's error. */
function publishRefusal(result: Extract<PublishNowResult, { ok: false }>): ToolError {
  switch (result.code) {
    case "not_found":
      return new ToolError("not_found", "No article with that articleId on this site.", 404);
    case "acknowledge_required":
      return new ToolError(
        "invalid_input",
        `${result.error}${issuesLine(result.issues)}`,
        400,
        "Read the issues; to publish it as it is, call publish_article again with acknowledgeQualityIssues: true. generate_article rewrites it instead."
      );
    case "needs_review":
      return new ToolError(
        "invalid_state",
        `${result.error} It was moved to needs_review and nothing was published.${issuesLine(result.issues)}`,
        409,
        "To publish it anyway, call publish_article with acknowledgeQualityIssues: true; generate_article rewrites it instead."
      );
    case "no_content":
      return new ToolError("invalid_state", `${result.error}${issuesLine(result.issues)}`, 409, "Call generate_article.");
    case "still_producing":
      return new ToolError("invalid_state", result.error, 409, "Poll get_job until production completes, then publish.");
    case "no_destination":
      return new ToolError("prerequisite_missing", result.error, 409, HINTS.integrations);
    case "delivery_failed":
      return new ToolError("delivery_failed", result.error, 502, HINTS.integrations);
    case "no_site":
    case "not_publishable":
    default:
      return new ToolError("invalid_state", result.error, 409);
  }
}

export const publishArticle = defineTool({
  name: "publish_article",
  title: "Publish an article",
  description:
    "Publishes one generated article to the site's connected destination (WordPress, the webhook) now, as Publish does on the calendar; a published article is republished, updating its post. The only tool that writes to the customer's live site: it needs the publish scope and confirm: true. An article that fails the quality checks is moved to needs_review instead of being published; publishing one from needs_review overrides the checks and needs acknowledgeQualityIssues: true. Answers with the live URL.",
  input: z.object({
    articleId: ArticleId,
    confirm: z
      .literal(true, { error: "confirm must be true: this publishes the article on the live site." })
      .describe("Must be true: this puts the article on the customer's live site."),
    acknowledgeQualityIssues: z
      .boolean()
      .default(false)
      .describe("True to publish an article waiting in needs_review despite the quality checks it failed, as pressing Publish on it does."),
  }),
  output: z.object({
    articleId: z.string(),
    url: z.string().describe("The live URL of the published post."),
    republished: z.boolean().describe("True when the article was already published and its post was updated."),
  }),
  scope: "publish",
  paid: false,
  requiresSubscription: true,
  owns: { articleId: "articles" },
  async handler(ctx, input) {
    const result = await publishArticleNow({
      admin: ctx.admin(),
      userId: ctx.userId,
      businessId: ctx.businessId,
      articleId: input.articleId,
      acknowledgeQualityIssues: input.acknowledgeQualityIssues,
    });
    if (!result.ok) throw publishRefusal(result);
    return { articleId: input.articleId, url: result.url, republished: result.republished };
  },
});

// ── Re-settling a held article (free) ───────────────────────────────────────

export const resettleArticleTool = defineTool({
  name: "resettle_article",
  title: "Re-check a held article",
  description:
    "Re-checks one article waiting in needs_review under the current rules, from what is stored and without calling a model: the deterministic quality gates run again on the stored document (with Facts for articles, About you and the research the production job stored), the stored audit findings are read again (only an invented fact, a wrong link, a factual error or unsafe content holds an article; the author's own figures never do), and the hold is decided again. Asks no model. Publishes nothing: an article with no reason left becomes generated and the daily run publishes it on its date; one still held stays needs_review with its reasons brought up to date. generate_article rewrites it instead (AI work: the spend scope).",
  input: z.object({ articleId: ArticleId }),
  output: z.object({
    articleId: z.string(),
    status: z.enum(["generated", "needs_review"]).describe("The article's status now."),
    changed: z.boolean().describe("True when the status or the recorded reasons changed."),
    reasons: z.array(z.string()).describe("Why it is still held, as the calendar shows it; empty when it became generated."),
    previousReasons: z.array(z.string()).describe("Why it was held before this call."),
    evidenceFound: z
      .boolean()
      .describe("False when the research it was written from could not be read back: figures are then checked against Facts for articles alone."),
  }),
  scope: "write",
  paid: false,
  owns: { articleId: "articles" },
  async handler(ctx, input) {
    const result = await resettleArticle({
      admin: ctx.admin(),
      userId: ctx.userId,
      businessId: ctx.businessId,
      articleId: input.articleId,
    });
    if (!result.ok) {
      throw result.code === "not_found"
        ? new ToolError("not_found", result.error, 404)
        : new ToolError("invalid_state", result.error, 409, "generate_article rewrites the article instead.");
    }
    const { articleId, status, changed, reasons, previousReasons, evidenceFound } = result;
    return { articleId, status, changed, reasons, previousReasons, evidenceFound };
  },
});

export const ARTICLE_PRODUCE_TOOLS = [generateArticle, publishArticle, resettleArticleTool] as const;
