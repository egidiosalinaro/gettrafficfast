import type { SupabaseClient } from "@supabase/supabase-js";
import { createBudget, type AgentContext } from "@/lib/agents/contract";
import { pushPageAgent, type PushPageOutput } from "@/lib/agents/push-page";
import { runAgent, supabaseRecorder } from "@/lib/agents/runner";
import { parseAutomationSettings } from "@/lib/automation/settings";
import { publishArticle } from "@/lib/content/service";
import type { CanonicalArticle } from "@/lib/content/types";
import type { IntegrationRow } from "@/lib/integrations/types";
import { linkableBodyText, linkedHrefs } from "@/lib/knowledge/linking";
import { linkableParagraphs, placePushLink, type PushLinkSuggestion } from "@/lib/knowledge/push-links";
import { findRelatedArticles, recordAppliedLinks } from "@/lib/knowledge/repository";
import { anchorFitsQuery, baselineWindow, checkMetaDescription, checkMetaTitle, chooseSourcePages, windowStats } from "@/lib/lifecycle/push";
import { loadSiteMetrics, PUSH_ARTICLE, type PushLink } from "@/lib/lifecycle/push-store";
import { canonicalMetaDescription, canonicalMetaTitle, withDateModified } from "@/lib/publishing/seo";
import { renderFullHtml } from "@/lib/publishing/types";
import { hasActiveJob } from "../queue";
import type { StepContext, Workflow } from "../types";
import { REFRESH_ARTICLE } from "./refresh-article";

/**
 * Push page 3, as a job (docs/LIFECYCLE.md, "Push page 3"):
 *
 * ```
 * prepare  the push row (selected), the article, its main query
 *          → the site's best close pages (chooseSourcePages), at most 3
 * write    ONE push-page agent call (fast tier): a meta title, a meta
 *          description, and where a link fits in each page
 * apply    links verified on each page's tree (placePushLink), the title
 *          and description checked (length, the query, no invented figure)
 *          → where the site takes updates: archive, store, deliver (the
 *            destination's update), article_links "applied"
 *          → where it does not: nothing changed, stored as a proposal for
 *            the customer (Today, the article modal)
 * ```
 *
 * The headline (H1) and the slug never change: the meta title is a field
 * of its own (`metaTitle`), and the URL is the article's identity.
 *
 * What it costs: one fast-tier call per pushed article, about 6,000 input
 * and 800 output tokens: roughly $0.01 on the dearest fast model in the
 * price tables, a fraction of a cent on the cheapest; at most three per site
 * per weekly sweep. `PUSH_BUDGET_USD` caps one job, retries included (the
 * budget is rebuilt from `agent_runs`). Paid and LLM-bound in the registry:
 * the worker runs it only for an owner who pays, under the spend ceiling.
 */

export { PUSH_ARTICLE };

/** Ceiling for one push, across its one call and every retry. */
export const PUSH_BUDGET_USD = 0.05;

const ARTICLE_COLUMNS = "id, user_id, business_id, keyword_id, status, published_url, external_post_id, canonical";
const INTEGRATION_COLUMNS = "id, user_id, business_id, type, config, status, last_error, last_sync_at, created_at, updated_at";
const RELATED_READ = 15;
const LIVE_READ = 60;

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

interface PushRow {
  id: string;
  user_id: string;
  business_id: string;
  article_id: string;
  origin: string;
  status: string;
  main_query: string | null;
}

async function loadPush(supabase: SupabaseClient, pushId: string): Promise<PushRow | null> {
  const { data } = await supabase
    .from("article_pushes")
    .select("id, user_id, business_id, article_id, origin, status, main_query")
    .eq("id", pushId)
    .maybeSingle();
  return (data as PushRow | null) ?? null;
}

async function finish(supabase: SupabaseClient, push: PushRow, update: Record<string, unknown>): Promise<void> {
  await supabase
    .from("article_pushes")
    .update({ ...update, updated_at: new Date().toISOString() })
    .eq("id", push.id)
    .eq("business_id", push.business_id);
}

async function remainingBudget(supabase: SupabaseClient, jobId: string) {
  const { data } = await supabase.from("agent_runs").select("cost_usd").eq("job_id", jobId);
  const spent = (data ?? []).reduce((sum, row) => sum + Number(row.cost_usd ?? 0), 0);
  return createBudget(Math.max(0, PUSH_BUDGET_USD - spent));
}

/** Whether the destination can update this article in place: a webhook always (it upserts on article_id), WordPress only with the post id. */
export function canUpdate(integration: IntegrationRow | null, externalPostId: string | null): boolean {
  if (!integration) return false;
  if (integration.type === "webhook") return true;
  if (integration.type === "wordpress") return Boolean(externalPostId);
  return false;
}

/**
 * Whether the destination shows a new meta title and description. Only the
 * webhook carries them (`seo.meta_title`, `seo.meta_description`); WordPress
 * builds its `<title>` from the post title, which is the headline we never
 * change, so there the new title is proposed for the person's SEO plugin.
 */
export function canUpdateMeta(integration: IntegrationRow | null): boolean {
  return integration?.type === "webhook";
}

interface Prepared {
  skipped?: string;
  pushId?: string;
  mainQuery?: string;
  targetUrl?: string;
  sourceIds?: string[];
  language?: string;
}

export const pushArticleWorkflow: Workflow = {
  type: PUSH_ARTICLE,

  steps: [
    {
      name: "prepare",
      async run(ctx: StepContext): Promise<Prepared> {
        const push = await loadPush(ctx.supabase, String(ctx.input.pushId));
        if (!push) return { skipped: "the push no longer exists" };
        if (push.status !== "selected") return { skipped: `the push is ${push.status}` };
        const skip = async (reason: string): Promise<Prepared> => {
          await finish(ctx.supabase, push, { status: "skipped", skip_reason: reason });
          return { skipped: reason };
        };
        if (!push.main_query) return skip("No main query.");

        const { data: business } = await ctx.supabase
          .from("businesses")
          .select("automation_settings, content_language")
          .eq("id", push.business_id)
          .maybeSingle();
        // The weekly sweep runs only behind the site's opt-in; read it again
        // here, so switching it off stops a push that was already queued.
        if (push.origin === "sweep" && !parseAutomationSettings(business?.automation_settings).pushPage3) {
          return skip("Push page 3 is off for this site.");
        }

        const { data } = await ctx.supabase
          .from("articles")
          .select(ARTICLE_COLUMNS)
          .eq("id", push.article_id)
          .eq("business_id", push.business_id)
          .maybeSingle();
        const article = data as ArticleRow | null;
        if (!article?.canonical || article.status !== "published" || !article.published_url) return skip("The article is no longer live.");
        if (await hasActiveJob(ctx.supabase, article.id, REFRESH_ARTICLE)) return skip("The article is being refreshed.");

        // The site's pages over the same 28 days, related by graph or by words.
        const { data: conn } = await ctx.supabase
          .from("analytics_connections")
          .select("last_synced_on")
          .eq("business_id", push.business_id)
          .eq("provider", "search_console")
          .maybeSingle();
        const watermark = (conn?.last_synced_on as string | null) ?? null;
        const window = watermark ? baselineWindow(watermark) : null;
        const [metrics, related, live] = await Promise.all([
          window ? loadSiteMetrics(ctx.supabase, push.business_id, window.start) : Promise.resolve(new Map()),
          findRelatedArticles({ supabase: ctx.supabase, userId: push.user_id, businessId: push.business_id, articleId: article.id, limit: RELATED_READ }),
          ctx.supabase
            .from("articles")
            .select(ARTICLE_COLUMNS)
            .eq("business_id", push.business_id)
            .eq("status", "published")
            .neq("id", article.id)
            .not("published_url", "is", null)
            .limit(LIVE_READ),
        ]);
        const graph = new Map(related.map((r) => [r.articleId, r.score]));
        const target = article.published_url;
        const pages = ((live.data ?? []) as ArticleRow[])
          .filter((row) => row.canonical && row.published_url)
          .map((row) => {
            const stats = window ? windowStats(metrics.get(row.id) ?? [], window.start, window.end) : null;
            return {
              articleId: row.id,
              title: row.canonical!.title,
              keyword: row.canonical!.keyword,
              publishedUrl: row.published_url!,
              clicks: stats?.clicks ?? 0,
              impressions: stats?.impressions ?? 0,
              graphScore: graph.get(row.id) ?? 0,
              linksToTarget: linkedHrefs(row.canonical!.bodyHtml).has(target),
            };
          });
        const chosen = chooseSourcePages({
          target: { articleId: article.id, title: article.canonical.title, keyword: article.canonical.keyword, mainQuery: push.main_query },
          pages,
        });
        return {
          pushId: push.id,
          mainQuery: push.main_query,
          targetUrl: target,
          sourceIds: chosen.map((c) => c.articleId),
          language: (business?.content_language as string | null) || article.canonical.language || "en",
        };
      },
    },

    {
      name: "write",
      async run(ctx: StepContext) {
        const prepared = ctx.outputs.prepare as Prepared;
        if (prepared?.skipped || !prepared?.pushId || !prepared.mainQuery) return { skipped: prepared?.skipped ?? "nothing prepared" };
        const push = await loadPush(ctx.supabase, prepared.pushId);
        if (!push) return { skipped: "the push no longer exists" };
        const [{ data: target }, { data: sources }] = await Promise.all([
          ctx.supabase.from("articles").select(ARTICLE_COLUMNS).eq("id", push.article_id).eq("business_id", push.business_id).maybeSingle(),
          (prepared.sourceIds ?? []).length > 0
            ? ctx.supabase.from("articles").select(ARTICLE_COLUMNS).eq("business_id", push.business_id).in("id", prepared.sourceIds ?? [])
            : Promise.resolve({ data: [] as ArticleRow[] }),
        ]);
        const canonical = (target as ArticleRow | null)?.canonical;
        if (!canonical) return { skipped: "no canonical document" };
        const byId = new Map(((sources ?? []) as ArticleRow[]).map((row) => [row.id, row]));
        const agentCtx: AgentContext = {
          userId: push.user_id,
          businessId: push.business_id,
          articleId: push.article_id,
          jobId: ctx.job.id,
          language: prepared.language ?? "en",
          runId: ctx.job.id,
          budget: await remainingBudget(ctx.supabase, ctx.job.id),
          signal: ctx.signal,
        };
        const suggestion = await runAgent(
          pushPageAgent,
          {
            language: prepared.language ?? "en",
            mainQuery: prepared.mainQuery,
            target: {
              title: canonical.title,
              metaTitle: canonicalMetaTitle(canonical),
              metaDescription: canonicalMetaDescription(canonical),
              bodyText: linkableBodyText(canonical.bodyHtml),
            },
            sources: (prepared.sourceIds ?? []).flatMap((id) => {
              const row = byId.get(id);
              return row?.canonical ? [{ articleId: id, title: row.canonical.title, paragraphs: linkableParagraphs(row.canonical.bodyHtml) }] : [];
            }),
          },
          agentCtx,
          supabaseRecorder(ctx.supabase)
        );
        return { suggestion };
      },
    },

    {
      name: "apply",
      async run(ctx: StepContext) {
        const prepared = ctx.outputs.prepare as Prepared;
        const written = ctx.outputs.write as { skipped?: string; suggestion?: PushPageOutput };
        if (prepared?.skipped || !prepared?.pushId) return { skipped: prepared?.skipped ?? "nothing prepared" };
        const push = await loadPush(ctx.supabase, prepared.pushId);
        if (!push || push.status !== "selected") return { skipped: "the push is not waiting" };
        if (written?.skipped || !written?.suggestion) {
          await finish(ctx.supabase, push, { status: "skipped", skip_reason: written?.skipped ?? "Nothing was written." });
          return { skipped: written?.skipped ?? "nothing written" };
        }
        return applyPush(ctx, push, prepared, written.suggestion);
      },
    },
  ],

  onFailure: async ({ supabase, job, error }) => {
    const pushId = typeof job.input.pushId === "string" ? job.input.pushId : null;
    if (!pushId) return;
    await supabase
      .from("article_pushes")
      .update({ status: "failed", skip_reason: error.slice(0, 500), updated_at: new Date().toISOString() })
      .eq("id", pushId)
      .eq("status", "selected");
  },
};

async function siteIntegration(supabase: SupabaseClient, businessId: string, userId: string): Promise<IntegrationRow | null> {
  const { data } = await supabase
    .from("integrations")
    .select(INTEGRATION_COLUMNS)
    .eq("business_id", businessId)
    .eq("user_id", userId)
    .in("status", ["connected", "error"])
    .order("created_at", { ascending: true })
    .limit(1);
  return ((data?.[0] ?? null) as IntegrationRow | null) ?? null;
}

/** Archives the live document, stores the new one, delivers it as an update. True when the site took it. */
async function storeAndDeliver(
  ctx: StepContext,
  params: { row: ArticleRow; next: CanonicalArticle; integration: IntegrationRow; reason: string }
): Promise<{ delivered: boolean; error?: string }> {
  const { row, next, integration } = params;
  const { data: latest } = await ctx.supabase
    .from("article_versions")
    .select("version")
    .eq("article_id", row.id)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  const { error: versionError } = await ctx.supabase.from("article_versions").insert({
    article_id: row.id,
    user_id: row.user_id,
    business_id: row.business_id,
    version: Number(latest?.version ?? 0) + 1,
    canonical: row.canonical,
    reason: params.reason,
  });
  if (versionError) return { delivered: false, error: `could not archive the previous version: ${versionError.message}` };
  await ctx.supabase
    .from("articles")
    .update({ canonical: next, content: renderFullHtml(next), updated_at: new Date().toISOString() })
    .eq("id", row.id);
  const outcome = await publishArticle({
    supabase: ctx.supabase,
    articleId: row.id,
    userId: row.user_id,
    businessId: row.business_id,
    keywordId: row.keyword_id ?? "",
    canonical: next,
    integration,
    jobId: ctx.job.id,
    externalPostId: row.external_post_id,
  });
  return outcome.ok ? { delivered: true } : { delivered: false, error: outcome.error };
}

async function applyPush(ctx: StepContext, push: PushRow, prepared: Prepared, suggestion: PushPageOutput) {
  const mainQuery = prepared.mainQuery ?? "";
  const [{ data: targetData }, { data: sourceData }] = await Promise.all([
    ctx.supabase.from("articles").select(ARTICLE_COLUMNS).eq("id", push.article_id).eq("business_id", push.business_id).maybeSingle(),
    (prepared.sourceIds ?? []).length > 0
      ? ctx.supabase.from("articles").select(ARTICLE_COLUMNS).eq("business_id", push.business_id).eq("user_id", push.user_id).in("id", prepared.sourceIds ?? [])
      : Promise.resolve({ data: [] as ArticleRow[] }),
  ]);
  const target = targetData as ArticleRow | null;
  if (!target?.canonical || target.status !== "published" || !target.published_url) {
    await finish(ctx.supabase, push, { status: "skipped", skip_reason: "The article is no longer live." });
    return { skipped: "not live" };
  }
  const integration = await siteIntegration(ctx.supabase, push.business_id, push.user_id);
  const byId = new Map(((sourceData ?? []) as ArticleRow[]).map((row) => [row.id, row]));
  const now = new Date();

  // ── Links ────────────────────────────────────────────────────────────────
  const links: PushLink[] = [];
  for (const sourceId of prepared.sourceIds ?? []) {
    const row = byId.get(sourceId);
    if (!row?.canonical || row.status !== "published" || !row.published_url) continue;
    const base = { fromArticleId: row.id, fromUrl: row.published_url, fromTitle: row.canonical.title };
    const raw = suggestion.links.find((l) => l.sourceArticleId === row.id) ?? null;
    const asked: PushLinkSuggestion | null = raw
      ? raw.mode === "sentence"
        ? { mode: "sentence", paragraph: raw.paragraph ?? 0, sentence: raw.sentence ?? "", anchor: raw.anchor }
        : { mode: "existing", anchor: raw.anchor }
      : null;
    if (await hasActiveJob(ctx.supabase, row.id, REFRESH_ARTICLE)) {
      links.push({ ...base, anchor: null, mode: null, sentence: null, status: "skipped", reason: "the page is being refreshed" });
      continue;
    }
    const placed = placePushLink({
      source: row.canonical,
      target: { articleId: target.id, url: target.published_url, mainQuery },
      suggestion: asked,
      anchorOk: (anchor) => anchorFitsQuery(anchor, mainQuery),
      now,
    });
    if (!placed.linked) {
      links.push({ ...base, anchor: null, mode: null, sentence: null, status: "skipped", reason: placed.reason });
      continue;
    }
    const record = { ...base, anchor: placed.anchor, mode: placed.mode, sentence: placed.sentence };
    if (!canUpdate(integration, row.external_post_id)) {
      // Nothing is changed on our side: the customer adds it on the site.
      links.push({ ...record, status: "proposed", reason: null });
      continue;
    }
    const delivered = await storeAndDeliver(ctx, { row, next: placed.canonical, integration: integration!, reason: `push: link to ${target.id}` });
    await recordAppliedLinks({
      supabase: ctx.supabase,
      userId: push.user_id,
      businessId: push.business_id,
      fromArticleId: row.id,
      links: [{ targetArticleId: target.id, anchor: placed.anchor }],
      status: delivered.delivered ? "applied" : "suggested",
    }).catch(() => undefined);
    links.push({ ...record, status: delivered.delivered ? "applied" : "not_delivered", reason: delivered.error ?? null });
  }

  // ── Title and description ────────────────────────────────────────────────
  const canonical = target.canonical;
  const articleText = linkableBodyText(canonical.bodyHtml);
  const oldTitle = canonicalMetaTitle(canonical) ?? canonical.title;
  const oldDescription = canonicalMetaDescription(canonical);
  const title = checkMetaTitle(suggestion.metaTitle, { mainQuery, articleText: `${canonical.title} ${articleText}`, current: oldTitle });
  const description = checkMetaDescription(suggestion.metaDescription, { mainQuery, articleText: `${canonical.title} ${articleText}`, current: oldDescription });
  const newTitle = title.ok ? title.text : null;
  const newDescription = description.ok ? description.text : null;
  let metaStatus: "applied" | "proposed" | "not_delivered" | "none" = "none";
  if (newTitle || newDescription) {
    if (canUpdateMeta(integration) && canUpdate(integration, target.external_post_id)) {
      const next = withDateModified(
        { ...canonical, ...(newTitle ? { metaTitle: newTitle } : {}), ...(newDescription ? { metaDescription: newDescription } : {}) },
        now
      );
      const delivered = await storeAndDeliver(ctx, { row: target, next, integration: integration!, reason: `push: title for "${mainQuery}"` });
      metaStatus = delivered.delivered ? "applied" : "not_delivered";
    } else {
      metaStatus = "proposed";
    }
  }

  const statuses = [...links.map((l) => l.status), metaStatus];
  const changed = statuses.filter((s) => s === "applied" || s === "proposed" || s === "not_delivered");
  const detail = {
    title: title.ok ? null : title.reason,
    metaDescription: description.ok ? null : description.reason,
    meta: metaStatus,
    destination: integration ? integration.type : null,
  };
  const common = {
    links,
    old_title: oldTitle,
    new_title: newTitle,
    old_meta_description: oldDescription,
    new_meta_description: newDescription,
    detail,
  };
  if (changed.length === 0) {
    await finish(ctx.supabase, push, { ...common, status: "skipped", skip_reason: "No link fitted the site's pages and no acceptable title was proposed." });
    return { status: "skipped" };
  }
  if (statuses.includes("proposed")) {
    await finish(ctx.supabase, push, { ...common, status: "proposed" });
    return { status: "proposed" };
  }
  if (statuses.includes("applied")) {
    await finish(ctx.supabase, push, { ...common, status: "applied", applied_by: "platform", applied_at: now.toISOString() });
    return { status: "applied" };
  }
  await finish(ctx.supabase, push, { ...common, status: "failed", skip_reason: "The site refused every update." });
  return { status: "failed" };
}
