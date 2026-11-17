import type { SupabaseClient } from "@supabase/supabase-js";
import { createBudget, type AgentContext } from "@/lib/agents/contract";
import { internalLinksAgent } from "@/lib/agents/internal-links";
import { runAgent, supabaseRecorder } from "@/lib/agents/runner";
import { parseAutomationSettings } from "@/lib/automation/settings";
import { publishArticle } from "@/lib/content/service";
import type { CanonicalArticle } from "@/lib/content/types";
import type { IntegrationRow } from "@/lib/integrations/types";
import { MAX_BACKLINKS, placeBacklink, planBacklinks, type BacklinkTarget } from "@/lib/knowledge/backlinks";
import { linkableBodyText } from "@/lib/knowledge/linking";
import { findRelatedArticles, recordAppliedLinks } from "@/lib/knowledge/repository";
import { renderFullHtml } from "@/lib/publishing/types";
import { enqueueJob, hasActiveJob } from "../queue";
import type { StepContext, Workflow } from "../types";
import { REFRESH_ARTICLE } from "./refresh-article";

/**
 * The back-link pass, as a job (docs/KNOWLEDGE.md).
 *
 * When an article is published, up to `MAX_BACKLINKS` older published
 * articles of the same site that share its entities or topics each get ONE
 * link to it, are archived, stored and delivered again through the ordinary
 * publish path (`publishArticle`, the destination's update), and the link is
 * recorded in `article_links`.
 *
 * Best-effort and bounded. The new article is live before this runs and is
 * never touched by it; an older article is changed only when the anchor
 * verifies against its body character for character (lib/knowledge/
 * linking.ts), and is otherwise left exactly as it was.
 *
 * What it costs: nothing when an older article already writes the new one's
 * keyword (the anchor is found by code). Otherwise one internal-links agent
 * call on the fast tier per older article, three at most per published
 * article (about $0.004 each on the dearest fast model, a third of that on
 * the cheapest), under a ceiling of `BACKLINK_BUDGET_USD` for the whole job,
 * retries included. Per site, `automation_settings.backLinks` (on by
 * default) switches it off.
 */

export const BACKLINK_ARTICLE = "backlink-article";

/** Ceiling for one pass, across its (at most three) model calls and every retry. */
export const BACKLINK_BUDGET_USD = 0.05;

/** How many related articles are read to find `MAX_BACKLINKS` that can take a link. */
const RELATED_READ = 10;

const INTEGRATION_COLUMNS = "id, user_id, business_id, type, config, status, last_error, last_sync_at, created_at, updated_at";

/**
 * Queues the pass for a newly published article, once: an article that
 * already has a pass on record (queued, running, done or failed) is not
 * queued again, so a republish or a retried publish never repeats it.
 * Returns the job id, or null when nothing was queued. Never throws: the
 * article is already live, and losing the pass loses links, never content.
 */
export async function enqueueBacklinkPass(params: {
  supabase: SupabaseClient;
  userId: string;
  businessId: string | null;
  articleId: string;
}): Promise<string | null> {
  const { supabase, userId, businessId, articleId } = params;
  if (!businessId) return null;
  try {
    const { count } = await supabase
      .from("jobs")
      .select("id", { count: "exact", head: true })
      .eq("article_id", articleId)
      .eq("type", BACKLINK_ARTICLE);
    if ((count ?? 0) > 0) return null;
    return await enqueueJob({
      supabase,
      userId,
      businessId,
      type: BACKLINK_ARTICLE,
      articleId,
      input: { articleId },
      // One retry is enough for a pass that changes at most three articles.
      maxAttempts: 2,
    });
  } catch (error) {
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "backlinks.enqueue_failed",
        article_id: articleId,
        error: error instanceof Error ? error.message : String(error),
      })
    );
    return null;
  }
}

interface ArticleRow {
  id: string;
  user_id: string;
  business_id: string | null;
  keyword_id: string | null;
  status: string;
  published_url: string | null;
  external_post_id: string | null;
  canonical: CanonicalArticle | null;
}

const ARTICLE_COLUMNS = "id, user_id, business_id, keyword_id, status, published_url, external_post_id, canonical";

/** What the job has spent so far, so a resumed job does not start its budget again. */
async function remainingBudget(supabase: SupabaseClient, jobId: string) {
  const { data } = await supabase.from("agent_runs").select("cost_usd").eq("job_id", jobId);
  const spent = (data ?? []).reduce((sum, row) => sum + Number(row.cost_usd ?? 0), 0);
  return createBudget(Math.max(0, BACKLINK_BUDGET_USD - spent));
}

export interface BacklinkResult {
  articleId: string;
  status: "linked" | "stored_not_delivered" | "skipped";
  anchor?: string;
  via?: "keyword" | "agent";
  reason?: string;
}

export const backlinkArticleWorkflow: Workflow = {
  type: BACKLINK_ARTICLE,

  steps: [
    {
      name: "select",
      async run(ctx: StepContext) {
        const articleId = String(ctx.input.articleId);
        const { data } = await ctx.supabase.from("articles").select(ARTICLE_COLUMNS).eq("id", articleId).maybeSingle();
        const article = data as ArticleRow | null;
        if (!article) return { skipped: "the article no longer exists" };
        if (article.status !== "published" || !article.published_url) return { skipped: "the article is not live" };
        if (!article.canonical) return { skipped: "no canonical document" };
        if (!article.business_id) return { skipped: "the article is not attached to a site" };

        const { data: business } = await ctx.supabase
          .from("businesses")
          .select("automation_settings")
          .eq("id", article.business_id)
          .maybeSingle();
        if (!parseAutomationSettings(business?.automation_settings).backLinks) {
          return { skipped: "back-links are off for this site" };
        }

        // Shared entities or topics, live articles of the same site only.
        const related = await findRelatedArticles({
          supabase: ctx.supabase,
          userId: article.user_id,
          businessId: article.business_id,
          articleId,
          limit: RELATED_READ,
        });
        if (related.length === 0) return { skipped: "no related published article" };

        const [{ data: rows }, { data: links }] = await Promise.all([
          ctx.supabase
            .from("articles")
            .select(ARTICLE_COLUMNS)
            .eq("business_id", article.business_id)
            .in(
              "id",
              related.map((r) => r.articleId)
            ),
          ctx.supabase.from("article_links").select("from_article_id").eq("to_article_id", articleId),
        ]);
        const byId = new Map(((rows ?? []) as ArticleRow[]).map((row) => [row.id, row]));

        const target: BacklinkTarget = {
          articleId,
          title: article.canonical.title,
          keyword: article.canonical.keyword,
          url: article.published_url,
        };
        const chosen = planBacklinks({
          target,
          // In the graph's order: closest first.
          candidates: related.flatMap((r) => {
            const row = byId.get(r.articleId);
            return row?.canonical && row.status === "published" && row.published_url
              ? [{ articleId: row.id, canonical: row.canonical }]
              : [];
          }),
          alreadyLinkedFrom: (links ?? []).map((l) => l.from_article_id as string),
          max: MAX_BACKLINKS,
        });
        if (chosen.length === 0) return { skipped: "every related article already links to it" };
        return { target, olderArticleIds: chosen.map((c) => c.articleId) };
      },
    },

    {
      name: "link",
      async run(ctx: StepContext) {
        const selected = ctx.outputs.select as { skipped?: string; target?: BacklinkTarget; olderArticleIds?: string[] };
        if (selected?.skipped || !selected?.target) return { skipped: selected?.skipped ?? "nothing selected" };
        const target = selected.target;
        // The cap is enforced again here: whatever the checkpoint holds, a
        // pass never changes more than MAX_BACKLINKS articles.
        const olderIds = [...new Set(selected.olderArticleIds ?? [])].filter((id) => id !== target.articleId).slice(0, MAX_BACKLINKS);

        const { data: newRow } = await ctx.supabase
          .from("articles")
          .select("id, user_id, business_id")
          .eq("id", target.articleId)
          .maybeSingle();
        const userId = (newRow?.user_id as string | undefined) ?? ctx.job.user_id;
        const businessId = (newRow?.business_id as string | null | undefined) ?? null;
        if (!businessId) return { skipped: "the article is not attached to a site" };

        const { data: business } = await ctx.supabase
          .from("businesses")
          .select("content_language")
          .eq("id", businessId)
          .maybeSingle();
        const language = (business?.content_language as string | null) || "en";

        // The destination is the site's own, by owner AND site: the
        // service-role client has no RLS to fall back on.
        const { data: integrations } = await ctx.supabase
          .from("integrations")
          .select(INTEGRATION_COLUMNS)
          .eq("business_id", businessId)
          .eq("user_id", userId)
          .in("status", ["connected", "error"])
          .order("created_at", { ascending: true })
          .limit(1);
        const integration = (integrations?.[0] ?? null) as IntegrationRow | null;
        if (!integration) return { skipped: "no integration connected" };

        const results: BacklinkResult[] = [];
        for (const olderId of olderIds) {
          try {
            results.push(await linkOne(ctx, { target, olderId, userId, businessId, language, integration }));
          } catch (error) {
            results.push({ articleId: olderId, status: "skipped", reason: error instanceof Error ? error.message : String(error) });
          }
        }
        return { linked: results.filter((r) => r.status === "linked").length, results };
      },
    },
  ],
};

async function linkOne(
  ctx: StepContext,
  params: {
    target: BacklinkTarget;
    olderId: string;
    userId: string;
    businessId: string;
    language: string;
    integration: IntegrationRow;
  }
): Promise<BacklinkResult> {
  const { target, olderId, userId, businessId, language, integration } = params;
  const skipped = (reason: string): BacklinkResult => ({ articleId: olderId, status: "skipped", reason });

  // Read again, now: the article may have been refreshed or unpublished
  // since it was selected, and the link goes into the document as it is.
  const { data } = await ctx.supabase
    .from("articles")
    .select(ARTICLE_COLUMNS)
    .eq("id", olderId)
    .eq("business_id", businessId)
    .eq("user_id", userId)
    .maybeSingle();
  const older = data as ArticleRow | null;
  if (!older?.canonical || older.status !== "published" || !older.published_url) return skipped("the article is no longer live");
  // A refresh in flight is about to replace this document: leave it to it.
  if (await hasActiveJob(ctx.supabase, olderId, REFRESH_ARTICLE)) return skipped("the article is being refreshed");

  const previous = older.canonical;
  const outcome = await placeBacklink({
    target,
    older: previous,
    // Asked only when the older article does not already write the keyword.
    suggestAnchor: async (document) => {
      const agentCtx: AgentContext = {
        userId,
        businessId,
        articleId: olderId,
        jobId: ctx.job.id,
        language,
        runId: ctx.job.id,
        budget: await remainingBudget(ctx.supabase, ctx.job.id),
        signal: ctx.signal,
      };
      const suggestion = await runAgent(
        internalLinksAgent,
        {
          language,
          sourceTitle: document.title,
          sourceBodyText: linkableBodyText(document.bodyHtml),
          targets: [{ articleId: target.articleId, title: target.title, keyword: target.keyword, excerpt: "" }],
          maxLinks: 1,
        },
        agentCtx,
        supabaseRecorder(ctx.supabase)
      );
      return suggestion.links[0]?.anchor ?? null;
    },
  });
  if (!outcome.linked) return skipped(outcome.reason);

  // Archive what is being replaced, then swap: the live document always has
  // a predecessor on record (the refresh's rule, AGENTS §23).
  const { data: latest } = await ctx.supabase
    .from("article_versions")
    .select("version")
    .eq("article_id", olderId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  const { error: versionError } = await ctx.supabase.from("article_versions").insert({
    article_id: olderId,
    user_id: userId,
    business_id: businessId,
    version: Number(latest?.version ?? 0) + 1,
    canonical: previous,
    reason: `back-link to ${target.articleId}`,
  });
  if (versionError) return skipped(`could not archive the previous version: ${versionError.message}`);

  await ctx.supabase
    .from("articles")
    .update({ canonical: outcome.canonical, content: renderFullHtml(outcome.canonical), updated_at: new Date().toISOString() })
    .eq("id", olderId);

  // The ordinary publish path, updating the existing post rather than
  // publishing a second one.
  const delivery = await publishArticle({
    supabase: ctx.supabase,
    articleId: olderId,
    userId,
    businessId,
    keywordId: older.keyword_id ?? "",
    canonical: outcome.canonical,
    integration,
    jobId: ctx.job.id,
    externalPostId: older.external_post_id,
  });

  // "applied" means a reader can follow it. A link stored but not delivered
  // is recorded as suggested; the next delivery of that article carries it.
  await recordAppliedLinks({
    supabase: ctx.supabase,
    userId,
    businessId,
    fromArticleId: olderId,
    links: [{ targetArticleId: target.articleId, anchor: outcome.anchor }],
    status: delivery.ok ? "applied" : "suggested",
  });

  return delivery.ok
    ? { articleId: olderId, status: "linked", anchor: outcome.anchor, via: outcome.via }
    : { articleId: olderId, status: "stored_not_delivered", anchor: outcome.anchor, via: outcome.via, reason: delivery.error };
}
