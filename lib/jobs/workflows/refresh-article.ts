import type { SupabaseClient } from "@supabase/supabase-js";
import { agentBudgetUsd, createBudget, AgentContext } from "@/lib/agents/contract";
import { runAgent, supabaseRecorder } from "@/lib/agents/runner";
import { refreshPlanAgent } from "@/lib/agents/refresh-plan";
import { refreshWriteAgent } from "@/lib/agents/refresh-write";
import { buildQualityReport, runContentPipeline } from "@/lib/content/pipeline";
import { publishArticle } from "@/lib/content/service";
import { withDateModified } from "@/lib/publishing/seo";
import { logPipelineRun } from "@/lib/content/trace";
import { CanonicalArticle } from "@/lib/content/types";
import { transitionArticle } from "@/lib/domain/lifecycle";
import { ensureSerpSnapshot } from "@/lib/intelligence/serp";
import { IntegrationRow } from "@/lib/integrations/types";
import { detectDecay } from "@/lib/lifecycle/decay";
import { assessRefresh } from "@/lib/lifecycle/guard";
import { loadRankHistory } from "@/lib/lifecycle/rank";
import { getSerpProvider } from "@/lib/providers/serp/registry";
import { renderFullHtml } from "@/lib/publishing/types";
import { StepContext, Workflow } from "../types";

/**
 * Article refresh: assess → plan → rewrite → apply → republish.
 *
 * This is the loop that separates "generates content" from "keeps content
 * competitive". Every step can decide there is nothing worth doing and stop —
 * a published article that still works is left alone, because the cost of a
 * pointless rewrite is paid twice: in tokens, and in the risk of replacing
 * something that ranks with something that does not.
 *
 * The live article is only ever replaced by a document that passed the same
 * pipeline and gates as a new one AND kept the substance of what it replaces.
 */

export const REFRESH_ARTICLE = "refresh-article";

interface RefreshContext {
  articleId: string;
  userId: string;
  businessId: string | null;
  keywordId: string | null;
  keyword: string;
  language: string;
  status: string;
  canonical: CanonicalArticle | null;
  publishedUrl: string | null;
  externalPostId: string | null;
  lastRefreshedAt: string | null;
  publishedAt: string | null;
  businessName?: string;
  businessNiche?: string;
  websiteUrl?: string;
}

async function loadContext(
  supabase: SupabaseClient,
  articleId: string
): Promise<RefreshContext> {
  const { data: article } = await supabase
    .from("articles")
    .select(
      `id, user_id, business_id, keyword_id, status, canonical, published_url, external_post_id,
       last_refreshed_at, created_at,
       keywords!articles_keyword_id_fkey ( keyword )`
    )
    .eq("id", articleId)
    .maybeSingle();

  if (!article) throw new Error(`Article ${articleId} no longer exists`);

  const kw = article.keywords as { keyword?: string } | { keyword?: string }[] | null;
  const keyword = (Array.isArray(kw) ? kw[0]?.keyword : kw?.keyword) ?? "";

  // The article's own site: on an account with two businesses, selecting by
  // user_id would match both and the rewrite would be planned for the wrong
  // company's niche.
  const businessId = (article.business_id as string | null) ?? null;
  const { data: business } = businessId
    ? await supabase
        .from("businesses")
        .select("name, niche, website_url, content_language")
        .eq("id", businessId)
        .maybeSingle()
    : { data: null };

  // When it actually went live, not when the row was created — the staleness
  // clock should measure the article's life on the customer's site.
  const { data: firstPublish } = await supabase
    .from("article_events")
    .select("created_at")
    .eq("article_id", articleId)
    .eq("to_state", "published")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  return {
    articleId,
    userId: article.user_id as string,
    businessId,
    keywordId: (article.keyword_id as string | null) ?? null,
    keyword,
    language: (business?.content_language as string) ?? "en",
    status: article.status as string,
    canonical: (article.canonical as CanonicalArticle | null) ?? null,
    publishedUrl: (article.published_url as string | null) ?? null,
    externalPostId: (article.external_post_id as string | null) ?? null,
    lastRefreshedAt: (article.last_refreshed_at as string | null) ?? null,
    publishedAt:
      (firstPublish?.created_at as string | undefined) ??
      (article.created_at as string | null) ??
      null,
    businessName: business?.name ?? undefined,
    businessNiche: business?.niche ?? undefined,
    websiteUrl: business?.website_url ?? undefined,
  };
}

async function budgetFor(supabase: SupabaseClient, jobId: string) {
  const { data } = await supabase.from("agent_runs").select("cost_usd").eq("job_id", jobId);
  const spent = (data ?? []).reduce((sum, r) => sum + Number(r.cost_usd ?? 0), 0);
  return createBudget(Math.max(0, agentBudgetUsd() - spent));
}

async function agentContext(ctx: StepContext, refresh: RefreshContext): Promise<AgentContext> {
  return {
    userId: refresh.userId,
    businessId: refresh.businessId,
    articleId: refresh.articleId,
    jobId: ctx.job.id,
    language: refresh.language,
    runId: ctx.job.id,
    budget: await budgetFor(ctx.supabase, ctx.job.id),
    signal: ctx.signal,
  };
}

/** Records what the refresh decided, whether or not it changed anything. */
async function recordDecision(
  ctx: StepContext,
  refresh: RefreshContext,
  cause: string,
  metadata: Record<string, unknown>
): Promise<void> {
  await transitionArticle({
    supabase: ctx.supabase,
    articleId: refresh.articleId,
    userId: refresh.userId,
    businessId: refresh.businessId,
    from: "published",
    to: "published",
    cause,
    actor: "system",
    metadata: { job_id: ctx.job.id, ...metadata },
  }).catch(() => undefined);
}

interface PlanOutput {
  skipped?: string;
  revisions?: Array<{ headingId: string; instruction: string }>;
  additions?: Array<{ afterHeadingId: string | null; heading: string; angle: string }>;
  metaDescription?: string | null;
  reason?: string;
}

export const refreshArticleWorkflow: Workflow = {
  type: REFRESH_ARTICLE,

  steps: [
    {
      name: "assess",
      async run(ctx) {
        const refresh = await loadContext(ctx.supabase, String(ctx.input.articleId));

        if (refresh.status !== "published") {
          return { skipped: `article is ${refresh.status}, not published` };
        }
        if (!refresh.canonical) return { skipped: "no canonical document to refresh" };

        const points = await loadRankHistory({
          supabase: ctx.supabase,
          articleId: refresh.articleId,
        });
        const verdict = detectDecay({
          points,
          publishedAt: refresh.publishedAt,
          lastRefreshedAt: refresh.lastRefreshedAt,
          now: new Date(),
        });

        if (!verdict.decaying) return { skipped: verdict.detail };
        return { reason: verdict.reason, detail: verdict.detail };
      },
    },

    {
      name: "plan",
      async run(ctx): Promise<PlanOutput> {
        const assessed = ctx.outputs.assess as { skipped?: string; detail?: string };
        if (assessed?.skipped) return { skipped: "nothing to refresh" };

        const refresh = await loadContext(ctx.supabase, String(ctx.input.articleId));
        const canonical = refresh.canonical;
        if (!canonical) return { skipped: "no canonical document" };

        // What beats it today, when a SERP provider is configured. Best-effort:
        // without it the plan reasons from the article alone.
        let competitors: Array<{
          position: number;
          title: string;
          domain: string;
          snippet: string;
        }> = [];
        let questions: string[] = [];
        const provider = getSerpProvider();
        if (provider && refresh.keywordId) {
          try {
            const snapshot = await ensureSerpSnapshot({
              supabase: ctx.supabase,
              userId: refresh.userId,
              businessId: refresh.businessId,
              keywordId: refresh.keywordId,
              keyword: refresh.keyword,
              language: refresh.language,
              provider,
              ownWebsiteUrl: refresh.websiteUrl,
              signal: ctx.signal,
            });
            competitors = snapshot.data.results.slice(0, 8).map((r) => ({
              position: r.position,
              title: r.title,
              domain: r.domain,
              snippet: r.snippet,
            }));
            questions = snapshot.data.peopleAlsoAsk;
          } catch {
            // A refresh does not need the SERP to be worth doing.
          }
        }

        const bodyText = canonical.bodyHtml
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();

        const plan = await runAgent(
          refreshPlanAgent,
          {
            keyword: refresh.keyword,
            language: refresh.language,
            title: canonical.title,
            headings: canonical.headings.map((h) => ({
              id: h.id,
              level: h.level,
              text: h.text,
            })),
            bodyText,
            decayDetail: assessed?.detail ?? "the article is losing ground",
            competitors,
            questions,
          },
          await agentContext(ctx, refresh),
          supabaseRecorder(ctx.supabase)
        );

        if (plan.verdict === "leave") {
          await recordDecision(ctx, refresh, `refresh declined: ${plan.reason}`, {
            decision: "leave",
          });
          return { skipped: `plan says leave: ${plan.reason}` };
        }

        return {
          revisions: plan.revisions,
          additions: plan.additions,
          metaDescription: plan.metaDescription,
          reason: plan.reason,
        };
      },
    },

    {
      name: "rewrite",
      async run(ctx) {
        const plan = ctx.outputs.plan as PlanOutput;
        if (plan?.skipped) return { skipped: plan.skipped };

        const refresh = await loadContext(ctx.supabase, String(ctx.input.articleId));
        const canonical = refresh.canonical;
        if (!canonical) return { skipped: "no canonical document" };

        // The agent works in headings, not ids: ids are our anchor contract,
        // and asking a writer to preserve them invites it to invent them.
        const textFor = new Map(canonical.headings.map((h) => [h.id, h.text]));

        const written = await runAgent(
          refreshWriteAgent,
          {
            keyword: refresh.keyword,
            language: refresh.language,
            title: canonical.title,
            currentHtml: renderFullHtml(canonical),
            revisions: (plan.revisions ?? []).map((r) => ({
              heading: textFor.get(r.headingId) ?? "",
              instruction: r.instruction,
            })),
            additions: (plan.additions ?? []).map((a) => ({
              afterHeading: a.afterHeadingId ? textFor.get(a.afterHeadingId) ?? null : null,
              heading: a.heading,
              angle: a.angle,
            })),
          },
          await agentContext(ctx, refresh),
          supabaseRecorder(ctx.supabase)
        );

        await ctx.supabase
          .from("articles")
          .update({ raw_content: written.html, updated_at: new Date().toISOString() })
          .eq("id", refresh.articleId);

        return { html: written.html };
      },
    },

    {
      name: "apply",
      async run(ctx) {
        const rewritten = ctx.outputs.rewrite as { skipped?: string; html?: string };
        if (rewritten?.skipped || !rewritten?.html) {
          return { skipped: rewritten?.skipped ?? "nothing was rewritten" };
        }

        const refresh = await loadContext(ctx.supabase, String(ctx.input.articleId));
        const previous = refresh.canonical;
        if (!previous) return { skipped: "no canonical document" };

        const result = runContentPipeline({
          raw: rewritten.html,
          articleId: refresh.articleId,
          keyword: refresh.keyword,
          // The slug is the live URL on the customer's site: a refresh updates
          // an article, it does not move it.
          slug: previous.slug,
          language: refresh.language,
          scheduledDate: previous.scheduledDate,
        });
        logPipelineRun(
          { articleId: refresh.articleId, keyword: refresh.keyword, jobId: ctx.job.id },
          result
        );

        if (result.decision === "regenerate" || !result.article) {
          // Throw away the rewrite checkpoint so the retry writes again
          // instead of re-validating the same broken document.
          await ctx.supabase
            .from("job_steps")
            .delete()
            .eq("job_id", ctx.job.id)
            .eq("step", "rewrite");
          throw new Error(
            `The refreshed article failed validation: ${result.issues
              .filter((i) => i.action !== "warn")
              .map((i) => i.code)
              .join(", ")}`
          );
        }

        if (result.decision === "needs_review") {
          const reason = result.issues
            .filter((i) => i.action !== "warn")
            .map((i) => i.message)
            .join(" | ");
          await recordDecision(ctx, refresh, `refresh discarded: ${reason}`.slice(0, 2000), {
            decision: "discarded",
            issues: result.issues.map((i) => i.code),
          });
          return { skipped: `refresh needed review, live version kept: ${reason}` };
        }

        // Media travels with the article, not with the prose: the rewrite only
        // ever saw the body, so the hero and videos come from what we already
        // had rather than being silently dropped.
        // A refresh is a modification of a published document: the stamp
        // travels with it to the destination (`date_modified`, payload v5).
        const next: CanonicalArticle = withDateModified({
          ...result.article,
          metaDescription:
            (ctx.outputs.plan as PlanOutput)?.metaDescription || result.article.metaDescription,
          media: previous.media,
        });

        const guard = assessRefresh(previous, next);
        if (!guard.safe) {
          await recordDecision(ctx, refresh, `refresh rejected: ${guard.reason}`, {
            decision: "rejected",
          });
          return { skipped: `refresh rejected by the guard: ${guard.reason}` };
        }

        // Archive what is being replaced, then swap. The live document always
        // has a predecessor on record to compare against.
        const { data: latest } = await ctx.supabase
          .from("article_versions")
          .select("version")
          .eq("article_id", refresh.articleId)
          .order("version", { ascending: false })
          .limit(1)
          .maybeSingle();

        const version = Number(latest?.version ?? 0) + 1;
        const { error: versionError } = await ctx.supabase.from("article_versions").insert({
          article_id: refresh.articleId,
          user_id: refresh.userId,
          business_id: refresh.businessId,
          version,
          canonical: previous,
          reason: (ctx.outputs.assess as { detail?: string })?.detail ?? "refresh",
        });
        if (versionError) {
          throw new Error(`could not archive the previous version: ${versionError.message}`);
        }

        await ctx.supabase
          .from("articles")
          .update({
            canonical: next,
            content: renderFullHtml(next),
            quality_report: buildQualityReport(result),
            last_refreshed_at: new Date().toISOString(),
            last_error: null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", refresh.articleId);

        await recordDecision(
          ctx,
          refresh,
          `refresh applied (v${version} archived): ${guard.reason}`,
          { decision: "applied", version }
        );

        return { version, canonical: next, guard: guard.reason };
      },
    },

    {
      name: "republish",
      async run(ctx) {
        const applied = ctx.outputs.apply as {
          skipped?: string;
          canonical?: CanonicalArticle;
        };
        if (applied?.skipped || !applied?.canonical) {
          return { skipped: applied?.skipped ?? "nothing to republish" };
        }

        const refresh = await loadContext(ctx.supabase, String(ctx.input.articleId));
        if (!refresh.publishedUrl) return { skipped: "article was never delivered" };
        // An article with no site has no destination to republish to, and an
        // empty string here would not be a uuid Postgres could compare.
        if (!refresh.businessId) return { skipped: "article is not attached to a site" };

        const { data: rows } = await ctx.supabase
          .from("integrations")
          .select(
            "id, user_id, business_id, type, config, status, last_error, last_sync_at, created_at, updated_at"
          )
          .eq("business_id", refresh.businessId)
          // Owner as well as site: the service-role client has no RLS.
          .eq("user_id", refresh.userId)
          .in("status", ["connected", "error"])
          .order("created_at", { ascending: true })
          .limit(1);

        const integration = (rows?.[0] ?? null) as IntegrationRow | null;
        if (!integration) return { skipped: "no integration connected" };

        const outcome = await publishArticle({
          supabase: ctx.supabase,
          articleId: refresh.articleId,
          userId: refresh.userId,
          businessId: refresh.businessId,
          keywordId: refresh.keywordId ?? "",
          canonical: applied.canonical,
          integration,
          jobId: ctx.job.id,
          // Update the existing post rather than publishing a second one.
          externalPostId: refresh.externalPostId,
        });

        if (!outcome.ok) throw new Error(`republish failed: ${outcome.error}`);
        return { url: outcome.url };
      },
    },
  ],
};
