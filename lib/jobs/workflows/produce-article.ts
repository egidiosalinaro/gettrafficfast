import type { SupabaseClient } from "@supabase/supabase-js";
import { agentBudgetUsd, createBudget, AgentContext } from "@/lib/agents/contract";
import { runAgent, supabaseRecorder } from "@/lib/agents/runner";
import { ArticleEvidence, BusinessFacts } from "@/lib/agents/article-brief";
import { outlineAgent, OutlineOutput, OutlineSerpContext } from "@/lib/agents/outline";
import { guideCanRank, serpAnalysisAgent } from "@/lib/agents/serp-analysis";
import { revisionAgent, writingAgent } from "@/lib/agents/writing";
import { aeoAgent, AeoOutput } from "@/lib/agents/aeo";
import { imageBriefAgent } from "@/lib/agents/image-brief";
import {
  VIDEO_CONFIDENCE_THRESHOLD,
  videoSelectAgent,
} from "@/lib/agents/video-select";
import { knowledgeExtractAgent } from "@/lib/agents/knowledge-extract";
import { MAX_IN_BODY_LINKS, internalLinksAgent } from "@/lib/agents/internal-links";
import { buildQualityReport, runContentPipeline, QualityReport } from "@/lib/content/pipeline";
import type { GateContext } from "@/lib/content/quality/claims";
import {
  BlockingReason,
  DraftStanding,
  blockingReasons,
  chooseDraft,
  clearFirstHandFindings,
} from "@/lib/content/quality/blocking";
import { logPipelineRun } from "@/lib/content/trace";
import { slugify } from "@/lib/content/text";
import {
  CanonicalArticle,
  CanonicalMedia,
  CanonicalVideo,
  PipelineIssue,
  REVISABLE_ISSUES,
} from "@/lib/content/types";
import { alertMediaSkips, imagePausedUntil, pauseImages } from "@/lib/media/degradation";
import { embedInlineImages } from "@/lib/media/embed";
import type { ArticleImage } from "@/lib/media/figures";
import { sectionExcerpts } from "@/lib/media/sections";
import { MediaSkip, MediaSkipNote, mergeSkips, toSkipNotes } from "@/lib/media/skips";
import { composeImagePrompt } from "@/lib/media/prompt";
import {
  IMAGE_ASPECT_RATIO,
  IMAGE_QUALITY,
  inlineImageAllowance,
  parseMediaSettings,
  MediaSettings,
} from "@/lib/media/settings";
import { ensureSerpSnapshot, storeSnapshotAnalysis } from "@/lib/intelligence/serp";
import { intentOf, type TopicIntent } from "@/lib/keywords/intent";
import { applyInternalLinks, linkableBodyText, linkedHrefs } from "@/lib/knowledge/linking";
import { pickReadNext, type ReadNextChoice } from "@/lib/knowledge/read-next";
import { READ_NEXT_COUNT, withReadNext, withoutReadNext } from "@/lib/content/anatomy";
import {
  findRelatedArticles,
  listLiveArticles,
  persistExtraction,
  recordAppliedLinks,
} from "@/lib/knowledge/repository";
import { recordVideoAsset, storeImage } from "@/lib/media/storage";
import { getImageProvider } from "@/lib/providers/images/registry";
import { imageFailureKind } from "@/lib/providers/images/types";
import { chooseArticleArm } from "@/lib/providers/llm/registry";
import { isLlmBillingRefusal, llmFailureKind, LlmArm } from "@/lib/providers/llm/types";
import { getSerpProvider } from "@/lib/providers/serp/registry";
import { getVideoProvider } from "@/lib/providers/video/registry";
import { renderFullHtml } from "@/lib/publishing/types";
import { transitionArticle, ArticleState } from "@/lib/domain/lifecycle";
import {
  articleFailedEmail,
  articleNeedsReviewEmail,
  sendNotificationEmail,
} from "@/lib/notifications/email";
import { parseVoiceSettings } from "@/lib/voice/settings";
import { StepContext, StepIncomplete, TerminalStepError, Workflow, isSubscriptionInactive } from "../types";

/**
 * Article production: arm → research → outline → writing → validation →
 * SEO/AEO audit → one revision when something was found → settle →
 * enrichment → knowledge.
 *
 * `arm` makes no call: it asks the provider registry which provider this
 * job's agents ask first (the article rotation, docs/AGENT_RUNTIME.md) and
 * checkpoints the answer like any step output, so a retry, or a resume after
 * midnight, reads the same arm back instead of choosing again.
 *
 * Each step persists what it produced before the next one starts, so a failure
 * late in the run never costs the work that came before it. After `validate`
 * the draft exists and is stored, but the article stays `generating` until
 * `settle` moves it (`generated` or `needs_review`): a draft with an
 * invented price must not be publishable for the seconds the audit takes.
 * If the job stops in between, `onFailure` and `onPause` settle it from the
 * validation alone.
 */

export const PRODUCE_ARTICLE = "produce-article";

/**
 * Related articles the knowledge step reads: enough for the in-body links
 * (up to MAX_IN_BODY_LINKS) and the Read next block, from one query each.
 */
const RELATED_READ = 10;


interface ProductionContext {
  articleId: string;
  userId: string;
  businessId: string | null;
  keywordId: string;
  keyword: string;
  /**
   * The kind of search the keyword answers (lib/keywords/intent.ts): a
   * comparison gets the comparison brief and is read as one by the gates.
   */
  topicIntent?: TopicIntent;
  scheduledDate: string | null;
  status: ArticleState;
  language: string;
  businessName?: string;
  businessNiche?: string;
  businessDescription?: string;
  websiteUrl?: string;
  /**
   * Settings → Voice → Facts for articles: the only first-hand facts an
   * article may state. Never About you (owner's decision, 2026-11-12).
   */
  firstHandFacts: string;
  /**
   * Settings → Voice → About you. Read by the gates only, never handed to a
   * model: a figure from it in an article is held (PRIVATE_FACT).
   */
  privateFacts: string;
  /** Settings → Voice → notes. */
  ownerNotes: string;
  lastError: string | null;
  mediaSettings: MediaSettings;
}

async function loadContext(
  supabase: SupabaseClient,
  articleId: string
): Promise<ProductionContext> {
  const { data: article } = await supabase
    .from("articles")
    .select(
      `id, user_id, business_id, keyword_id, scheduled_date, status, last_error,
       keywords!articles_keyword_id_fkey ( keyword, intent )`
    )
    .eq("id", articleId)
    .maybeSingle();

  if (!article) throw new Error(`Article ${articleId} no longer exists`);

  const kw = article.keywords as { keyword?: string; intent?: unknown } | { keyword?: string; intent?: unknown }[] | null;
  const keywordRow = Array.isArray(kw) ? kw[0] : kw;
  const keyword = keywordRow?.keyword ?? "";

  // The article's own site. Selecting by user_id would now match several rows
  // on an account with more than one business, and .maybeSingle() would fail
  // the whole production rather than quietly pick the wrong one.
  const businessId = (article.business_id as string | null) ?? null;
  const { data: business } = businessId
    ? await supabase
        .from("businesses")
        .select("name, niche, description, website_url, content_language, media_settings, voice_settings")
        .eq("id", businessId)
        .maybeSingle()
    : { data: null };

  const voice = parseVoiceSettings(business?.voice_settings);

  return {
    articleId,
    userId: article.user_id as string,
    businessId,
    keywordId: article.keyword_id as string,
    keyword,
    topicIntent: keyword ? intentOf(keywordRow?.intent, keyword) : undefined,
    scheduledDate: (article.scheduled_date as string | null) ?? null,
    status: article.status as ArticleState,
    language: (business?.content_language as string) ?? "en",
    businessName: business?.name ?? undefined,
    businessNiche: business?.niche ?? undefined,
    businessDescription: business?.description ?? undefined,
    websiteUrl: business?.website_url ?? undefined,
    firstHandFacts: voice.articleFacts.trim(),
    privateFacts: voice.aboutYou.trim(),
    ownerNotes: voice.instructions.trim(),
    lastError: (article.last_error as string | null) ?? null,
    mediaSettings: parseMediaSettings(business?.media_settings),
  };
}

/**
 * Budget remaining for this job, derived from what its agents already spent.
 * Because it is computed from `agent_runs`, the ceiling survives a run that is
 * resumed in a different invocation.
 */
async function budgetFor(supabase: SupabaseClient, jobId: string) {
  const { data } = await supabase.from("agent_runs").select("cost_usd").eq("job_id", jobId);
  const spent = (data ?? []).reduce((sum, r) => sum + Number(r.cost_usd ?? 0), 0);
  // Ceiling per article, across every agent and every retry of the job.
  return createBudget(Math.max(0, agentBudgetUsd() - spent));
}

async function agentContext(ctx: StepContext, production: ProductionContext): Promise<AgentContext> {
  return {
    userId: production.userId,
    businessId: production.businessId,
    articleId: production.articleId,
    jobId: ctx.job.id,
    language: production.language,
    runId: ctx.job.id,
    budget: await budgetFor(ctx.supabase, ctx.job.id),
    signal: ctx.signal,
    llmArm: armOf(ctx.outputs),
  };
}

/** The arm the job's `arm` step stored; null when there is no rotation, or the job predates the step. */
export function armOf(outputs: Record<string, unknown>): string | null {
  const stored = outputs.arm as Partial<LlmArm> | null | undefined;
  return typeof stored?.arm === "string" && stored.arm ? stored.arm : null;
}

async function emailOwner(
  supabase: SupabaseClient,
  userId: string,
  template: { subject: string; html: string }
): Promise<void> {
  const { data } = await supabase.auth.admin.getUserById(userId);
  const email = data?.user?.email;
  if (email) await sendNotificationEmail({ to: email, ...template });
}

export const produceArticleWorkflow: Workflow = {
  type: PRODUCE_ARTICLE,

  steps: [
    {
      // Chosen once, here, and never again for this job: a completed step is
      // not re-run, and `validate` throwing away the drafting checkpoints
      // leaves this one in place.
      name: "arm",
      async run(ctx): Promise<LlmArm> {
        // A job that was already under way when this step was added keeps
        // the providers it started with: half an article per arm would be a
        // sample of neither.
        if (Object.keys(ctx.outputs).length > 0) return { arm: null };
        return chooseArticleArm();
      },
    },

    {
      name: "research",
      async run(ctx) {
        const production = await loadContext(ctx.supabase, String(ctx.input.articleId));

        // Not having research configured is a setting, and the article is
        // written without it, as before. Research that is configured and
        // FAILS is different: see the catch below.
        const provider = getSerpProvider();
        if (!provider) return { skipped: "no SERP provider configured" };
        if (!production.keywordId || !production.keyword) {
          return { skipped: "no keyword to research" };
        }

        const research = async () => {
          const snapshot = await ensureSerpSnapshot({
            supabase: ctx.supabase,
            userId: production.userId,
            businessId: production.businessId,
            keywordId: production.keywordId,
            keyword: production.keyword,
            language: production.language,
            provider,
            ownWebsiteUrl: production.websiteUrl,
            signal: ctx.signal,
          });

          if (snapshot.data.results.length === 0) {
            return { skipped: "SERP returned no organic results", snapshotId: snapshot.snapshotId };
          }

          const analysis = await runAgent(
            serpAnalysisAgent,
            {
              keyword: production.keyword,
              language: production.language,
              businessName: production.businessName,
              businessNiche: production.businessNiche,
              results: snapshot.data.results.map((r) => ({
                position: r.position,
                title: r.title,
                domain: r.domain,
                snippet: r.snippet,
              })),
              peopleAlsoAsk: snapshot.data.peopleAlsoAsk,
              relatedSearches: snapshot.data.relatedSearches,
            },
            await agentContext(ctx, production),
            supabaseRecorder(ctx.supabase)
          );

          await storeSnapshotAnalysis(ctx.supabase, snapshot.snapshotId, analysis);

          const serp: OutlineSerpContext = {
            intent: analysis.intent,
            angle: analysis.angle,
            questions: analysis.questions,
            competitorTitles: snapshot.data.results.slice(0, 5).map((r) => r.title),
            gaps: analysis.gaps,
          };
          // The results themselves, for the outline, the writer and the
          // numbers gate: a figure the article states must be in here or in
          // the business's own facts.
          const evidence: ArticleEvidence = {
            results: snapshot.data.results.slice(0, 8).map((r) => ({
              title: r.title,
              domain: r.domain,
              snippet: r.snippet.slice(0, 300),
            })),
            questions: snapshot.data.peopleAlsoAsk.slice(0, 8),
            relatedSearches: snapshot.data.relatedSearches.slice(0, 8),
          };
          return {
            serp,
            evidence,
            snapshotId: snapshot.snapshotId,
            reused: snapshot.reused,
            difficulty: analysis.difficulty,
            articleResults: analysis.articleResults,
            resultsRead: analysis.resultsRead,
            canRank: guideCanRank(analysis),
          };
        };

        let found: Awaited<ReturnType<typeof research>>;
        try {
          found = await research().catch(async (first) => {
            // An account that cannot pay is the worker's to hold, and our own
            // clock running out is not a research failure.
            if (isLlmBillingRefusal(first) || ctx.signal?.aborted) throw first;
            // Once more, now: the snapshot, if it was fetched, is reused, so
            // the retry pays for the search at most once.
            return research();
          });
        } catch (err) {
          if (isLlmBillingRefusal(err) || ctx.signal?.aborted) throw err;
          // Still failing. Until 2026-11-10 the article was written anyway,
          // from the model's priors (13 production runs). Now it waits: the
          // job is released and comes back to this step in an hour, with no
          // attempt spent and nothing failed, and the card says why.
          const detail = err instanceof Error ? err.message : String(err);
          const reason = `${RESEARCH_HOLD_PREFIX}the search results for this keyword could not be read, so the article waits rather than being written without them. It is retried automatically.`;
          if (production.status === "queued") {
            await ctx.supabase
              .from("articles")
              .update({ last_error: reason, updated_at: new Date().toISOString() })
              .eq("id", production.articleId);
          }
          console.warn(
            JSON.stringify({
              level: "warn",
              event: "produce_article.research_held",
              job_id: ctx.job.id,
              article_id: production.articleId,
              error: detail.slice(0, 500),
            })
          );
          throw new StepIncomplete(reason, RESEARCH_RETRY_SECONDS);
        }

        // The intent gate. Only for an article still waiting in the queue:
        // one a person starts again after reading the reason, or regenerates
        // from an existing draft, is written.
        if ("canRank" in found && found.canRank === false && production.status === "queued") {
          throw new ArticleSkipped(INTENT_SKIP_REASON);
        }
        return found;
      },
    },

    {
      name: "outline",
      async run(ctx) {
        const production = await loadContext(ctx.supabase, String(ctx.input.articleId));
        await transitionArticle({
          supabase: ctx.supabase,
          articleId: production.articleId,
          userId: production.userId,
          businessId: production.businessId,
          from: production.status === "generating" ? null : production.status,
          to: "generating",
          cause: "production job started",
          actor: "system",
          metadata: { job_id: ctx.job.id },
          // A reason left by an earlier hold or skip no longer describes it.
          patch: production.lastError ? { last_error: null } : undefined,
        });

        const { serp, evidence } = researchOf(ctx.outputs);

        return runAgent(
          outlineAgent,
          {
            keyword: production.keyword,
            language: production.language,
            ...businessFacts(production),
            serp,
            evidence,
          },
          await agentContext(ctx, production),
          supabaseRecorder(ctx.supabase)
        );
      },
    },

    {
      name: "write",
      async run(ctx) {
        const production = await loadContext(ctx.supabase, String(ctx.input.articleId));
        const outline = OutlineOutput.parse(ctx.outputs.outline);

        const written = await runAgent(
          writingAgent,
          {
            keyword: production.keyword,
            language: production.language,
            outline,
            ...businessFacts(production),
            evidence: researchOf(ctx.outputs).evidence,
          },
          await agentContext(ctx, production),
          supabaseRecorder(ctx.supabase)
        );

        // Persist immediately: the raw output is the evidence every later
        // diagnosis depends on, and it must survive a failure downstream.
        await ctx.supabase
          .from("articles")
          .update({ raw_content: written.html, updated_at: new Date().toISOString() })
          .eq("id", production.articleId);

        // `model`, `fallback` and `tierDowngraded` ride along in the step
        // output: which model wrote this article is read here, not guessed.
        return written;
      },
    },

    {
      name: "validate",
      async run(ctx) {
        const production = await loadContext(ctx.supabase, String(ctx.input.articleId));
        const raw = String((ctx.outputs.write as { html?: string })?.html ?? "");

        const result = runContentPipeline({
          raw,
          articleId: production.articleId,
          keyword: production.keyword,
          slug: slugify(production.keyword),
          language: production.language,
          scheduledDate: production.scheduledDate,
          gateContext: gateContextFor(production, researchOf(ctx.outputs).evidence),
        });
        logPipelineRun(
          { articleId: production.articleId, keyword: production.keyword, jobId: ctx.job.id },
          result
        );

        const report = buildQualityReport(result);

        // Unusable output: throw away the drafting checkpoints so the retry
        // genuinely writes a new article instead of re-validating the same one.
        if (result.decision === "regenerate" || !result.article) {
          await ctx.supabase
            .from("job_steps")
            .delete()
            .eq("job_id", ctx.job.id)
            .in("step", ["outline", "write"]);

          await ctx.supabase
            .from("articles")
            .update({
              quality_report: report,
              attempt_count: ctx.job.attempts,
              last_error: report.issues.map((i) => i.message).join(" | ").slice(0, 2000),
              updated_at: new Date().toISOString(),
            })
            .eq("id", production.articleId);

          throw new Error(
            `The generated article failed validation: ${report.issues
              .filter((i) => i.action !== "warn")
              .map((i) => i.code)
              .join(", ")}`
          );
        }

        // The draft is stored, the status is not moved: `settle` does that
        // once the audit has read it and the one revision has had its turn.
        await ctx.supabase
          .from("articles")
          .update({
            content: renderFullHtml(result.article),
            canonical: result.article,
            quality_report: report,
            attempt_count: ctx.job.attempts,
            failed_at: null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", production.articleId);

        const output: ValidateOutput = {
          decision: result.decision,
          canonical: result.article,
          issues: storedIssues(result.issues),
        };
        return output;
      },
    },

    {
      name: "audit",
      async run(ctx) {
        const production = await loadContext(ctx.supabase, String(ctx.input.articleId));
        const validated = ctx.outputs.validate as ValidateOutput | undefined;
        const canonical = validated?.canonical;
        if (!canonical) return { skipped: "no canonical document" };

        // Best-effort from here on: the article is already valid and usable.
        // Losing the audit loses metadata, never the article — a production
        // job must not dead-letter a good article over its own enrichment.
        let audit: AeoOutput;
        try {
          audit = await auditArticle(ctx, production, canonical);
        } catch (err) {
          if (ctx.signal?.aborted) throw err;
          return {
            skipped: `audit failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }

        // The audit never rewrites the body — it writes the metadata, and
        // names what the revision step should act on.
        const enriched = withAuditMetadata(canonical, audit);

        const { data: current } = await ctx.supabase
          .from("articles")
          .select("quality_report")
          .eq("id", production.articleId)
          .maybeSingle();

        const report = (current?.quality_report as Record<string, unknown>) ?? {};

        await ctx.supabase
          .from("articles")
          .update({
            canonical: enriched,
            quality_report: { ...report, aeo: auditReport(audit) },
            updated_at: new Date().toISOString(),
          })
          .eq("id", production.articleId);

        const output: AuditOutput = {
          score: audit.score,
          findings: audit.findings.length,
          actionable: audit.findings.filter((f) => f.severity !== "info"),
          metaTitle: audit.metaTitle,
          metaDescription: audit.metaDescription,
        };
        return output;
      },
    },

    {
      // The one rewrite, and nothing else: the model call is checkpointed on
      // its own, so a tick that runs out of time while the revised draft is
      // being checked does not pay for the rewrite twice.
      name: "revise",
      async run(ctx) {
        const production = await loadContext(ctx.supabase, String(ctx.input.articleId));
        const validated = ctx.outputs.validate as ValidateOutput | undefined;
        if (!validated?.canonical) return { revised: false, skipped: "no canonical document" };
        // Settled already: by a hold or a failure between the steps, or by a
        // job that validated before this step existed.
        if (production.status !== "generating") {
          return { revised: false, skipped: `article already ${production.status}` };
        }

        const audit = (ctx.outputs.audit ?? {}) as Partial<AuditOutput>;
        const problems = problemsToFix({ issues: validated.issues, findings: audit.actionable ?? [] });

        // Nothing found: no call is made. This is the case that costs nothing.
        if (problems.length === 0) return { revised: false, problems };

        const agentCtx = await agentContext(ctx, production);
        // One rewrite and one audit must fit under the article's ceiling
        // (AGENT_BUDGET_USD); when they do not, the draft is settled as it is
        // and says so, rather than the job dying one call short.
        if (agentCtx.budget.remainingUsd() < REVISION_RESERVE_USD) {
          return {
            revised: false,
            problems,
            // No amounts: this reason is in the job's result, which get_job
            // returns to the customer.
            reason: "not revised: what is left of the article's budget for AI work is less than a revision needs",
          };
        }

        const written = (ctx.outputs.write ?? {}) as { html?: string };
        try {
          const revised = await runAgent(
            revisionAgent,
            {
              keyword: production.keyword,
              language: production.language,
              draftHtml: written.html || renderFullHtml(validated.canonical),
              problems,
              ...businessFacts(production),
              evidence: researchOf(ctx.outputs).evidence,
            },
            agentCtx,
            supabaseRecorder(ctx.supabase)
          );
          const output: ReviseOutput = {
            revised: true,
            problems,
            html: revised.html,
            model: revised.model ?? null,
            fallback: revised.fallback ?? null,
          };
          return output;
        } catch (err) {
          if (ctx.signal?.aborted) throw err;
          return {
            revised: false,
            problems,
            reason: `revision failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500),
          };
        }
      },
    },

    {
      // Checks the revised draft (the same gates, the same audit, once) and
      // moves the article out of `generating`.
      name: "settle",
      async run(ctx) {
        const production = await loadContext(ctx.supabase, String(ctx.input.articleId));
        const validated = ctx.outputs.validate as ValidateOutput | undefined;
        if (!validated?.canonical) return { skipped: "no canonical document" };
        if (production.status !== "generating") {
          return { skipped: `article already ${production.status}` };
        }

        const audit = (ctx.outputs.audit ?? {}) as Partial<AuditOutput>;
        const revise = (ctx.outputs.revise ?? { revised: false, problems: [] }) as Partial<ReviseOutput> & {
          reason?: string;
        };
        const problems = revise.problems ?? [];
        const written = (ctx.outputs.write ?? {}) as { model?: string; fallback?: boolean };
        // `gateIssues` is what the deterministic gates raised on the FIRST
        // draft, counted by code: the yardstick the provider comparison can
        // read without asking a model (lib/content/provider-comparison.ts).
        const base = {
          writerModel: written.model ?? null,
          writerFallback: written.fallback ?? null,
          gateIssues: validated.issues.length,
        };

        const first: Draft = {
          canonical: withAuditMetadata(validated.canonical, audit),
          issues: validated.issues,
          findings: audit.actionable ?? [],
        };

        const keepFirst = async (why: string | null, record?: RevisionRecord) => {
          const revision: RevisionRecord | null =
            record ?? (problems.length > 0 ? { ran: false, reason: why ?? undefined, problems } : null);
          const status = await settle(ctx.supabase, ctx.job, production, first, revision);
          return {
            revised: false,
            status,
            ...(why ? { reason: why } : {}),
            problems: problems.length,
            wordCount: first.canonical.wordCount,
            auditScore: audit.score ?? null,
            ...(record ? { before: record.before, after: record.after } : {}),
            ...base,
          };
        };

        if (!revise.revised || !revise.html) return keepFirst(revise.reason ?? null);

        // The same gates, once more, on the revised draft.
        const evidence = researchOf(ctx.outputs).evidence;
        const result = runContentPipeline({
          raw: revise.html,
          articleId: production.articleId,
          keyword: production.keyword,
          slug: slugify(production.keyword),
          language: production.language,
          scheduledDate: production.scheduledDate,
          gateContext: gateContextFor(production, evidence),
        });
        logPipelineRun(
          { articleId: production.articleId, keyword: production.keyword, jobId: ctx.job.id },
          result
        );
        if (result.decision === "regenerate" || !result.article) {
          return keepFirst("the revision was not a usable article; the first draft is kept");
        }

        // And the audit, once more. Best-effort: when it cannot run, what it
        // found the first time is not assumed fixed.
        let secondAudit: AeoOutput | null = null;
        try {
          secondAudit = await auditArticle(ctx, production, result.article);
        } catch (err) {
          if (ctx.signal?.aborted) throw err;
        }

        const second: Draft = {
          canonical: secondAudit ? withAuditMetadata(result.article, secondAudit) : result.article,
          issues: storedIssues(result.issues),
          findings: secondAudit
            ? secondAudit.findings.filter((f) => f.severity !== "info")
            : first.findings
                .filter((f) => f.severity === "critical")
                .map((f) => ({
                  ...f,
                  message: `${f.message} (found before the revision; the revised draft could not be audited again)`,
                })),
        };

        // The revision is kept only when it is better (blocking problems,
        // then critical findings, then gate issues, then the audit score),
        // and a tie keeps the original (lib/content/quality/blocking.ts).
        const before = summaryOf(first, audit.score ?? null);
        const after = summaryOf(second, secondAudit?.score ?? null);
        const choice = chooseDraft(standingOf(before), standingOf(after));
        const revision: RevisionRecord = {
          ran: true,
          model: revise.model ?? null,
          fallback: revise.fallback ?? null,
          problems,
          before,
          after,
          kept: choice.keep,
          reason: choice.reason,
        };
        if (choice.keep === "original") return keepFirst(choice.reason, revision);

        await ctx.supabase
          .from("articles")
          .update({ raw_content: revise.html, updated_at: new Date().toISOString() })
          .eq("id", production.articleId);

        const report: QualityReport & Record<string, unknown> = {
          ...buildQualityReport(result),
          ...(secondAudit ? { aeo: auditReport(secondAudit) } : {}),
        };
        const status = await settle(ctx.supabase, ctx.job, production, second, revision, report);

        return {
          revised: true,
          status,
          model: revise.model ?? null,
          fallback: revise.fallback ?? null,
          problems: problems.length,
          remaining: problemsToFix(second).length,
          wordCount: second.canonical.wordCount,
          auditScore: secondAudit?.score ?? null,
          before: revision.before,
          after: revision.after,
          ...base,
        };
      },
    },

    {
      name: "enrich",
      async run(ctx) {
        const production = await loadContext(ctx.supabase, String(ctx.input.articleId));
        const settings = production.mediaSettings;

        if (!settings.imagesEnabled && !settings.videosEnabled) {
          return { skipped: "media disabled for this business" };
        }

        // Read the CURRENT canonical: the audit step already improved its
        // metadata, and that must not be lost here.
        const { data: row } = await ctx.supabase
          .from("articles")
          .select("canonical")
          .eq("id", production.articleId)
          .maybeSingle();
        const canonical = row?.canonical as CanonicalArticle | null;
        if (!canonical) return { skipped: "no canonical document" };

        const notes: string[] = [];
        // Why this article has less media than its settings asked for. Unlike
        // `notes`, these reach the owner (canonical.media.skipped) and, when
        // the cause is the platform's, the operator. See lib/media/skips.ts.
        const skips: MediaSkip[] = [];
        const skip = (
          media: MediaSkip["media"],
          reason: MediaSkip["reason"],
          detail: string,
          count = 1
        ) => {
          skips.push({ media, reason, detail, count });
          notes.push(`${media} skipped (${reason}): ${detail}`);
        };
        const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

        let hero: ArticleImage | null = null;
        const inline: ArticleImage[] = [];
        const videos: CanonicalVideo[] = [];

        // ── Images — every failure degrades to "fewer images", never to a
        // failed article. Provider spend is bounded: one hero, plus at most
        // the business's own cap of in-article renders (0 unless it set one).
        if (settings.imagesEnabled) {
          // Nothing is paid for, the brief included, when the render cannot
          // happen: a pause left by a billing refusal, or no provider set up.
          let provider: ReturnType<typeof getImageProvider> | null = null;
          const pausedUntil = await imagePausedUntil(ctx.supabase);
          if (pausedUntil) {
            skip("images", "paused", `image generation is paused until ${pausedUntil.toISOString()}`);
          } else {
            try {
              provider = getImageProvider(settings.imageProvider);
            } catch (err) {
              skip(
                "images",
                imageFailureKind(err) === "not_configured" ? "not_configured" : "provider_error",
                messageOf(err)
              );
            }
          }

          if (provider) {
            try {
              const brief = await runAgent(
                imageBriefAgent,
                {
                  keyword: production.keyword,
                  language: production.language,
                  title: canonical.title,
                  excerpt: canonical.excerpt,
                  headings: canonical.headings.map((h) => ({
                    id: h.id,
                    level: h.level,
                    text: h.text,
                  })),
                  sections: sectionExcerpts(canonical.bodyHtml),
                  businessName: production.businessName,
                  businessNiche: production.businessNiche,
                  businessDescription: production.businessDescription,
                  maxInline: inlineImageAllowance(
                    canonical.headings.filter((h) => h.level === 2).length,
                    settings.inlineImagesPerArticle
                  ),
                },
                await agentContext(ctx, production),
                supabaseRecorder(ctx.supabase)
              );

              // Scenes the check refused twice are not rendered at all.
              for (const rejected of brief.rejected) {
                skip(
                  "images",
                  "brief_rejected",
                  `${rejected.slot}: ${rejected.problems.join(", ")}${rejected.scene ? ` — "${rejected.scene}"` : ""}`
                );
              }

              // An off-topic hero replaced by the fixed desk scene: rendered,
              // so not a skip, but the step says so.
              for (const replaced of brief.fallbacks) {
                notes.push(`${replaced.slot}: off-topic scene replaced by the desk scene — "${replaced.scene}"`);
              }

              const planned = [
                ...(brief.hero ? [{ ...brief.hero, kind: "hero" as const, slot: null as string | null }] : []),
                ...brief.inline.map((item) => ({
                  scene: item.scene,
                  alt: item.alt,
                  caption: item.caption,
                  kind: "inline" as const,
                  slot: item.headingId as string | null,
                })),
              ];

              let inlineIndex = 0;
              for (const [position, item] of planned.entries()) {
                const index = item.kind === "hero" ? 0 : inlineIndex++;
                try {
                  // The look follows the subject: a business with nothing
                  // physical does not get a "photograph" of an idea.
                  const prompt = composeImagePrompt(item.scene, settings, brief.subject);
                  const image = await provider.generate({
                    prompt,
                    aspectRatio: IMAGE_ASPECT_RATIO,
                    quality: IMAGE_QUALITY,
                    signal: ctx.signal,
                  });
                  const stored = await storeImage({
                    supabase: ctx.supabase,
                    userId: production.userId,
                    businessId: production.businessId,
                    articleId: production.articleId,
                    kind: item.kind,
                    index,
                    bytes: image.bytes,
                    mimeType: image.mimeType,
                    provider: image.provider,
                    model: image.model,
                    prompt,
                    costUsd: image.costUsd,
                  });
                  const rendered: ArticleImage = {
                    url: stored.url,
                    alt: item.alt,
                    caption: item.caption,
                    slot: item.slot,
                    ...(stored.width && stored.height
                      ? { width: stored.width, height: stored.height }
                      : {}),
                  };
                  if (item.kind === "hero") hero = rendered;
                  else inline.push(rendered);
                } catch (err) {
                  const kind = imageFailureKind(err);
                  const remaining = planned.length - position;
                  if (kind === "billing") {
                    // The account cannot pay: the next render would be
                    // refused too, and so would the next article's. Hold
                    // images for an hour and stop here.
                    await pauseImages(ctx.supabase, { provider: provider.name, detail: messageOf(err) });
                    skip("images", "billing", messageOf(err), remaining);
                    break;
                  }
                  if (kind === "not_configured") {
                    skip("images", "not_configured", messageOf(err), remaining);
                    break;
                  }
                  skip("images", "provider_error", `${item.kind} image: ${messageOf(err)}`);
                }
              }
            } catch (err) {
              skip("images", "provider_error", `image briefing failed: ${messageOf(err)}`);
            }
          }
        }

        // ── Videos — retrieval + judgement; "none" is the expected outcome.
        if (settings.videosEnabled) {
          const videoProvider = getVideoProvider();
          if (!videoProvider) {
            skip("videos", "not_configured", "no video provider configured");
          } else {
            try {
              const candidates = await videoProvider.search({
                query: production.keyword,
                language: production.language,
                signal: ctx.signal,
              });
              if (candidates.length > 0) {
                const selection = await runAgent(
                  videoSelectAgent,
                  {
                    keyword: production.keyword,
                    language: production.language,
                    title: canonical.title,
                    headings: canonical.headings.map((h) => ({
                      id: h.id,
                      level: h.level,
                      text: h.text,
                    })),
                    candidates: candidates.map((c) => ({
                      videoId: c.videoId,
                      title: c.title,
                      channel: c.channel,
                      description: c.description,
                      publishedAt: c.publishedAt,
                    })),
                    maxSelections: 1,
                  },
                  await agentContext(ctx, production),
                  supabaseRecorder(ctx.supabase)
                );

                for (const pick of selection.selections) {
                  if (pick.confidence < VIDEO_CONFIDENCE_THRESHOLD) {
                    notes.push(
                      `video ${pick.videoId} below confidence threshold (${pick.confidence})`
                    );
                    continue;
                  }
                  const candidate = candidates.find((c) => c.videoId === pick.videoId);
                  if (!candidate) continue;
                  videos.push({
                    provider: "youtube",
                    videoId: candidate.videoId,
                    url: candidate.url,
                    embedUrl: candidate.embedUrl,
                    title: candidate.title,
                    thumbnailUrl: candidate.thumbnailUrl,
                    slot: pick.headingId,
                  });
                  await recordVideoAsset({
                    supabase: ctx.supabase,
                    userId: production.userId,
                    businessId: production.businessId,
                    articleId: production.articleId,
                    provider: "youtube",
                    url: candidate.url,
                    meta: {
                      video_id: candidate.videoId,
                      slot: pick.headingId,
                      confidence: pick.confidence,
                      reason: pick.reason,
                    },
                  });
                }
              }
            } catch (err) {
              skip("videos", "provider_error", messageOf(err));
            }
          }
        }

        // One alert a day per reason, to the operator, for the causes that
        // are the platform's (billing, nothing configured, a failing
        // provider). Never throws.
        const merged = mergeSkips(skips);
        await alertMediaSkips(ctx.supabase, merged, {
          articleId: production.articleId,
          jobId: ctx.job.id,
          businessId: production.businessId,
        });
        const skipped = toSkipNotes(skips);
        const produced = Boolean(hero) || inline.length > 0 || videos.length > 0;

        if (!produced && skipped.length === 0) {
          return { skipped: "no media produced", notes };
        }

        // With nothing new, media already on the document is kept and only
        // the reasons are added: a pause must not erase an earlier hero.
        const media: CanonicalMedia & { skipped?: MediaSkipNote[] } = {
          ...(produced
            ? { hero, images: inline, videos }
            : (canonical.media ?? { hero: null, images: [], videos: [] })),
          ...(skipped.length > 0 ? { skipped } : {}),
        };
        const enriched: CanonicalArticle = {
          ...canonical,
          bodyHtml: embedInlineImages(canonical.bodyHtml, inline),
          media,
        };

        await ctx.supabase
          .from("articles")
          .update({
            canonical: enriched,
            content: renderFullHtml(enriched),
            updated_at: new Date().toISOString(),
          })
          .eq("id", production.articleId);

        return {
          hero: Boolean(hero),
          inline: inline.length,
          videos: videos.length,
          notes,
          // Structured, with the provider's own message: for the operator.
          skips: merged,
        };
      },
    },

    {
      name: "knowledge",
      async run(ctx) {
        const production = await loadContext(ctx.supabase, String(ctx.input.articleId));

        // Read the CURRENT canonical — audit metadata and media enrichment
        // already live in it and must not be lost.
        const { data: row } = await ctx.supabase
          .from("articles")
          .select("canonical")
          .eq("id", production.articleId)
          .maybeSingle();
        const canonical = row?.canonical as CanonicalArticle | null;
        if (!canonical) return { skipped: "no canonical document" };

        const notes: string[] = [];
        // Without a Read next block an earlier attempt of this step stored:
        // that is a list of other articles, not this one's text.
        const bodyText = linkableBodyText(withoutReadNext(canonical.bodyHtml));

        // Best-effort throughout: the article is already valid and usable.
        // Losing this step loses graph rows and links, never the article.
        let extraction;
        try {
          extraction = await runAgent(
            knowledgeExtractAgent,
            {
              keyword: production.keyword,
              language: production.language,
              title: canonical.title,
              headings: canonical.headings.map((h) => ({ level: h.level, text: h.text })),
              bodyText,
              businessNiche: production.businessNiche,
            },
            await agentContext(ctx, production),
            supabaseRecorder(ctx.supabase)
          );
        } catch (err) {
          return {
            skipped: `extraction failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }

        let persisted = { entities: 0, topics: 0 };
        try {
          persisted = await persistExtraction({
            supabase: ctx.supabase,
            userId: production.userId,
            businessId: production.businessId,
            articleId: production.articleId,
            extraction,
          });
        } catch (err) {
          notes.push(
            `graph persist failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }

        // ── Internal links: only toward articles a reader can actually reach.
        // In the body: up to MAX_IN_BODY_LINKS, placed by one call of the
        // links agent and verified by code. At the end: the Read next block,
        // chosen by code with no call (docs/KNOWLEDGE.md, "Read next").
        let linksApplied = 0;
        let current: CanonicalArticle = canonical;
        const placed: Array<{ targetArticleId: string; anchor: string }> = [];
        let related: Awaited<ReturnType<typeof findRelatedArticles>> = [];
        try {
          related = await findRelatedArticles({
            supabase: ctx.supabase,
            userId: production.userId,
            businessId: production.businessId,
            articleId: production.articleId,
            limit: RELATED_READ,
          });

          if (related.length > 0) {
            const suggestion = await runAgent(
              internalLinksAgent,
              {
                language: production.language,
                sourceTitle: canonical.title,
                sourceBodyText: bodyText,
                targets: related.map((r) => ({
                  articleId: r.articleId,
                  title: r.title,
                  keyword: r.keyword,
                  excerpt: r.excerpt,
                })),
                maxLinks: Math.min(MAX_IN_BODY_LINKS, related.length),
              },
              await agentContext(ctx, production),
              supabaseRecorder(ctx.supabase)
            );

            const hrefFor = new Map(related.map((r) => [r.articleId, r.publishedUrl]));
            const placements = suggestion.links.flatMap((l) => {
              const href = hrefFor.get(l.targetArticleId);
              return href
                ? [{ targetArticleId: l.targetArticleId, anchor: l.anchor, href }]
                : [];
            });

            const result = applyInternalLinks(current.bodyHtml, placements);
            for (const s of result.skipped) {
              notes.push(`link to ${s.targetArticleId} skipped: ${s.reason}`);
            }
            if (result.applied.length > 0) {
              current = { ...current, bodyHtml: result.bodyHtml };
              placed.push(...result.applied.map((l) => ({ targetArticleId: l.targetArticleId, anchor: l.anchor })));
              linksApplied = result.applied.length;
            }
          }
        } catch (err) {
          notes.push(`linking skipped: ${err instanceof Error ? err.message : String(err)}`);
        }

        let readNext: ReadNextChoice[] = [];
        try {
          // The other live articles are read only when the graph relates too few.
          const others =
            related.length >= READ_NEXT_COUNT
              ? []
              : await listLiveArticles({
                  supabase: ctx.supabase,
                  userId: production.userId,
                  businessId: production.businessId,
                  articleId: production.articleId,
                });
          readNext = pickReadNext({
            source: { articleId: production.articleId, keyword: production.keyword, title: canonical.title },
            related,
            others,
            linkedInBody: linkedHrefs(withoutReadNext(current.bodyHtml)),
          });
          current = withReadNext(current, readNext);
        } catch (err) {
          notes.push(`read next skipped: ${err instanceof Error ? err.message : String(err)}`);
        }

        if (current.bodyHtml !== canonical.bodyHtml) {
          try {
            await ctx.supabase
              .from("articles")
              .update({
                canonical: current,
                content: renderFullHtml(current),
                updated_at: new Date().toISOString(),
              })
              .eq("id", production.articleId);
            await recordAppliedLinks({
              supabase: ctx.supabase,
              userId: production.userId,
              businessId: production.businessId,
              fromArticleId: production.articleId,
              links: [...placed, ...readNext.map((item) => ({ targetArticleId: item.articleId, anchor: item.title }))],
            });
          } catch (err) {
            notes.push(`links not stored: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        return {
          entities: persisted.entities,
          topics: persisted.topics,
          links: linksApplied,
          readNext: readNext.length,
          notes,
        };
      },
    },
  ],

  /**
   * Held by the LLM billing pause, or by the account's daily AI spend limit
   * (`reason`). Before validation the article was only "generating" because
   * the outline step said so; it goes back to queued, with no attempt
   * counted. After validation it is usable as it stands and is left alone.
   */
  async onPause({ job, supabase, outputs, reason }) {
    const articleId = String(job.input?.articleId ?? job.article_id ?? "");
    if (!articleId) return;
    const production = await loadContext(supabase, articleId).catch(() => null);
    if (!production) return;
    if (outputs.validate) {
      // The draft is written and stored. It is settled as validated, without
      // the revision: a held job must not leave a finished article reading
      // "generating" for as long as the hold lasts.
      await settleFromValidation(supabase, job, production, outputs);
      return;
    }
    await requeueArticle(supabase, job.id, production, reason ?? LLM_DELAY_CAUSE);
  },

  async onFailure({ job, supabase, error, outputs }) {
    const articleId = String(job.input?.articleId ?? job.article_id ?? "");
    if (!articleId) return;

    // If validation completed, the article exists and is usable — a failure in
    // a later step (audit, enrich) must not dead-letter it or alarm the owner.
    // If it stopped before `settle` ran, it is settled here as
    // validated.
    if (outputs.validate) {
      const stopped = await loadContext(supabase, articleId).catch(() => null);
      if (stopped) await settleFromValidation(supabase, job, stopped, outputs).catch(() => undefined);
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "produce_article.post_validate_failure",
          job_id: job.id,
          article_id: articleId,
          error: error.slice(0, 500),
        })
      );
      return;
    }

    const production = await loadContext(supabase, articleId).catch(() => null);
    if (!production) return;

    // The research said an article cannot rank for this search. Nothing
    // failed and nothing was written: the article leaves the queue with the
    // reason on its card, no attempt counted, no failure email. Starting it
    // again by hand writes it anyway.
    if (isIntentSkip(error)) {
      if (production.status === "queued" || production.status === "generating") {
        await transitionArticle({
          supabase,
          articleId,
          userId: production.userId,
          businessId: production.businessId,
          from: production.status,
          to: "failed",
          cause: error.slice(0, 2000),
          actor: "system",
          metadata: { job_id: job.id, skipped: "intent" },
          patch: { last_error: error.slice(0, 2000), failed_at: new Date().toISOString() },
        }).catch(() => undefined);
      }
      return;
    }

    // A provider that cannot pay or did not answer: nothing is wrong with
    // this article, it is only late. It goes back to the queue, without an
    // attempt counted against it, and the customer gets no email: there is
    // nothing for them to do, and the vendor's message is not theirs to read.
    if (llmFailureKind(error)) {
      await requeueArticle(supabase, job.id, production, error);
      return;
    }

    // The owner's subscription lapsed (the worker stopped the job before it
    // ran): the article is not broken either. It waits in `queued`, as the
    // generation cron leaves a lapsed account's articles, with the reason on
    // the card and no failure email.
    if (isSubscriptionInactive(error)) {
      await requeueArticle(supabase, job.id, production, error);
      return;
    }

    await transitionArticle({
      supabase,
      articleId,
      userId: production.userId,
      businessId: production.businessId,
      from: production.status,
      to: "failed",
      cause: error.slice(0, 2000),
      actor: "system",
      metadata: { job_id: job.id },
      patch: {
        attempt_count: job.attempts,
        last_error: error.slice(0, 2000),
        failed_at: new Date().toISOString(),
      },
    }).catch(() => undefined);

    await emailOwner(
      supabase,
      production.userId,
      articleFailedEmail(production.keyword, Math.max(1, job.attempts), customerReason(error))
    );
  },
};

const LLM_DELAY_CAUSE = "generation delayed: the AI provider account cannot pay (credits are depleted)";

/**
 * Back to `queued` for an article that is late rather than broken. Only
 * from `generating`: a queued article is already there, and anything else
 * (generated, needs_review) was moved on by a step that finished.
 */
async function requeueArticle(
  supabase: SupabaseClient,
  jobId: string,
  production: ProductionContext,
  cause: string
): Promise<void> {
  if (production.status === "generating") {
    await transitionArticle({
      supabase,
      articleId: production.articleId,
      userId: production.userId,
      businessId: production.businessId,
      from: "generating",
      to: "queued",
      cause: cause.slice(0, 2000),
      actor: "system",
      metadata: { job_id: jobId },
      patch: { last_error: cause.slice(0, 2000) },
    }).catch(() => undefined);
  } else if (production.status === "queued") {
    await supabase
      .from("articles")
      .update({ last_error: cause.slice(0, 2000), updated_at: new Date().toISOString() })
      .eq("id", production.articleId);
  }
}

/**
 * The sentence the failure email gives the customer. Never the error itself:
 * that can carry a vendor's message or the code's own wording, and it stays
 * in `articles.last_error` for diagnosis.
 */
export function customerReason(error: string): string {
  if (isIntentSkip(error)) return error;
  if (/^The generated article failed validation/.test(error)) {
    return "Each draft failed our quality checks, so nothing was published to your site.";
  }
  if (/exceeded its budget/.test(error)) {
    return "It reached the limit on AI work for one article before it was finished.";
  }
  return "Something went wrong while writing it. The article card in your calendar has the details.";
}

// ── Research: the skip and the hold ─────────────────────────────────────────

const SKIP_PREFIX = "Skipped: ";

/** What the article card says when the intent gate stopped it. */
export const INTENT_SKIP_REASON = `${SKIP_PREFIX}Google shows only tools and product pages for this search; an article is unlikely to rank. Generate it again to write it anyway.`;

export function isIntentSkip(message: string | null | undefined): boolean {
  return (message ?? "").startsWith(SKIP_PREFIX);
}

/**
 * Stops the job on this attempt, with nothing retried and nothing reported:
 * the research worked, and its answer is that there is no article to write.
 */
class ArticleSkipped extends TerminalStepError {
  constructor(message: string) {
    super(message);
    this.name = "ArticleSkipped";
  }
}

export const RESEARCH_HOLD_PREFIX = "Waiting for research: ";

/**
 * How long a held article waits before research is tried again. An hour: each
 * try is at most two calls to the search provider, and one that is down is
 * not asked every minute.
 */
export const RESEARCH_RETRY_SECONDS = 60 * 60;

/** The research step's stored output, read back: what `resettle_article` checks figures against too. */
export function researchOf(outputs: Record<string, unknown>): {
  serp?: OutlineSerpContext;
  evidence?: ArticleEvidence;
} {
  const research = outputs.research as { serp?: unknown; evidence?: unknown } | undefined;
  const serp = OutlineSerpContext.safeParse(research?.serp);
  const evidence = ArticleEvidence.safeParse(research?.evidence);
  return {
    serp: research?.serp && serp.success ? serp.data : undefined,
    evidence: research?.evidence && evidence.success ? evidence.data : undefined,
  };
}

function businessFacts(production: ProductionContext): BusinessFacts {
  return {
    businessName: production.businessName,
    businessNiche: production.businessNiche,
    businessDescription: production.businessDescription,
    websiteUrl: production.websiteUrl,
    firstHandFacts: production.firstHandFacts || undefined,
    ownerNotes: production.ownerNotes || undefined,
    topicIntent: production.topicIntent,
  };
}

/**
 * What the gates check the article against: the owner's Facts for articles
 * and the research are what a figure may come from; About you is what it
 * may not (2026-11-12, docs/VOICE.md).
 */
export function gateContextFor(
  production: Pick<ProductionContext, "businessName" | "websiteUrl" | "firstHandFacts" | "privateFacts" | "topicIntent">,
  evidence: ArticleEvidence | undefined
): GateContext {
  return {
    businessName: production.businessName,
    websiteUrl: production.websiteUrl,
    facts: production.firstHandFacts,
    privateFacts: production.privateFacts,
    evidence: evidence
      ? [
          ...evidence.results.map((r) => `${r.title}\n${r.snippet}`),
          ...evidence.questions,
          ...evidence.relatedSearches,
        ].join("\n")
      : "",
    comparison: production.topicIntent === "comparison",
  };
}

// ── Validation, audit and the one revision ──────────────────────────────────

/** Below this, the article's budget cannot carry a rewrite and a second audit. */
export const REVISION_RESERVE_USD = 0.1;

interface StoredIssue {
  code: string;
  action: string;
  message: string;
}

type Finding = AeoOutput["findings"][number];

interface ValidateOutput {
  decision: "publish" | "needs_review";
  canonical: CanonicalArticle;
  issues: StoredIssue[];
}

interface AuditOutput {
  score: number;
  findings: number;
  /** The findings a rewrite is asked to fix: critical and warning. */
  actionable: Finding[];
  metaTitle: string;
  metaDescription: string;
}

/** The `revise` step's checkpoint: the rewritten draft, or why there is none. */
interface ReviseOutput {
  revised: boolean;
  problems: string[];
  html?: string;
  model?: string | null;
  fallback?: boolean | null;
}

/** A draft and everything found in it. */
interface Draft {
  canonical: CanonicalArticle;
  issues: StoredIssue[];
  findings: Finding[];
}

interface DraftSummary {
  wordCount: number;
  /** Reasons it would be held (lib/content/quality/blocking.ts). Absent on records before 2026-11-12. */
  blocking?: number;
  issues: string[];
  critical: number;
  warnings: number;
  aeoScore: number | null;
}

function standingOf(summary: DraftSummary): DraftStanding {
  return {
    blocking: summary.blocking ?? 0,
    critical: summary.critical,
    gateIssues: summary.issues.length,
    aeoScore: summary.aeoScore,
  };
}

/** Stored in `quality_report.revision`: whether the one revision ran, on what, what it changed, and which draft was kept. */
interface RevisionRecord {
  ran: boolean;
  /** Why it did not run, or why the draft that was kept was chosen. */
  reason?: string;
  /** Since 2026-11-12: the draft that was kept when the revision ran. */
  kept?: "original" | "revision";
  model?: string | null;
  fallback?: boolean | null;
  problems: string[];
  before?: DraftSummary;
  after?: DraftSummary;
}

function storedIssues(issues: PipelineIssue[]): StoredIssue[] {
  return issues.map((i) => ({ code: i.code, action: i.action, message: i.message }));
}

/**
 * The audit, told who publishes the article, the owner's Facts for articles
 * (the author's own verified data) and the research it was written from.
 * A finding about figures that are all the author's own is then cleared in
 * code to an info suggestion (`clearFirstHandFindings`), whatever the model
 * said: on 2026-11-12 an article was held for the owner's own figures.
 */
async function auditArticle(
  ctx: StepContext,
  production: ProductionContext,
  canonical: CanonicalArticle
): Promise<AeoOutput> {
  const agentCtx = await agentContext(ctx, production);
  const audit = await runAgent(
    aeoAgent,
    {
      keyword: production.keyword,
      language: production.language,
      title: canonical.title,
      headings: canonical.headings.map((h) => ({ level: h.level, text: h.text })),
      // The whole body. Block boundaries become line breaks so a table row
      // or a list item does not run into the next sentence.
      bodyText: canonical.bodyHtml
        .replace(/<\/(p|h[1-6]|li|tr|blockquote|pre|table|ul|ol)>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
        .replace(/[ \t]+/g, " ")
        .replace(/\s*\n\s*/g, "\n")
        .trim(),
      businessName: production.businessName,
      websiteUrl: production.websiteUrl,
      firstHandFacts: production.firstHandFacts || undefined,
      evidence: researchOf(ctx.outputs).evidence,
    },
    agentCtx,
    supabaseRecorder(ctx.supabase)
  );
  return { ...audit, findings: clearFirstHandFindings(audit.findings, production.firstHandFacts) };
}

/** The audit's title and description become part of the document (`metaTitle`, `metaDescription`). */
function withAuditMetadata(
  canonical: CanonicalArticle,
  audit: { metaTitle?: string; metaDescription?: string }
): CanonicalArticle {
  return {
    ...canonical,
    metaDescription: audit.metaDescription || canonical.metaDescription,
    ...(audit.metaTitle ? { metaTitle: audit.metaTitle } : {}),
  };
}

function auditReport(audit: AeoOutput) {
  return {
    score: audit.score,
    metaTitle: audit.metaTitle,
    findings: audit.findings,
    suggestedFaq: audit.suggestedFaq,
    entities: audit.entities,
  };
}

/** What a rewrite is asked to fix: the editorial gates' issues and the audit's critical and warning findings. */
export function problemsToFix(draft: { issues: StoredIssue[]; findings: Finding[] }): string[] {
  return [
    ...draft.issues.filter((i) => REVISABLE_ISSUES.has(i.code)).map((i) => i.message),
    ...draft.findings
      .filter((f) => f.severity === "critical" || f.severity === "warning")
      .map((f) => `[${f.area}, ${f.severity}] ${f.message}`),
  ];
}

function summaryOf(draft: Draft, aeoScore: number | null): DraftSummary {
  return {
    wordCount: draft.canonical.wordCount,
    blocking: blockingReasons(draft).length,
    issues: draft.issues.map((i) => i.code),
    critical: draft.findings.filter((f) => f.severity === "critical").length,
    warnings: draft.findings.filter((f) => f.severity === "warning").length,
    aeoScore,
  };
}

/**
 * Moves the article out of `generating` with the draft given: `needs_review`
 * when something still blocks it, `generated` otherwise. The owner is told
 * once, here, and only for `needs_review`.
 */
async function settle(
  supabase: SupabaseClient,
  job: { id: string; attempts: number },
  production: ProductionContext,
  draft: Draft,
  revision: RevisionRecord | null,
  report?: Record<string, unknown>
): Promise<ArticleState> {
  const blocking: BlockingReason[] = blockingReasons(draft);
  const reasons = blocking.map((reason) => reason.message);
  const status: ArticleState = reasons.length > 0 ? "needs_review" : "generated";

  let qualityReport = report;
  if (!qualityReport) {
    const { data: current } = await supabase
      .from("articles")
      .select("quality_report")
      .eq("id", production.articleId)
      .maybeSingle();
    qualityReport = (current?.quality_report as Record<string, unknown>) ?? {};
  }

  await transitionArticle({
    supabase,
    articleId: production.articleId,
    userId: production.userId,
    businessId: production.businessId,
    from: "generating",
    to: status,
    cause: `content pipeline decision: ${status === "needs_review" ? "needs_review" : "publish"}${
      revision?.ran ? ", after one revision" : ""
    }`,
    actor: "system",
    metadata: { job_id: job.id, issues: draft.issues.map((i) => i.code), revised: revision?.ran ?? false },
    patch: {
      content: renderFullHtml(draft.canonical),
      canonical: draft.canonical,
      quality_report: {
        ...qualityReport,
        decision: status === "needs_review" ? "needs_review" : "publish",
        // Why it is held, as the calendar and publish_article show it.
        blocking,
        ...(revision ? { revision } : {}),
      },
      attempt_count: job.attempts,
      last_error: status === "needs_review" ? reasons.join(" | ").slice(0, 2000) : null,
      failed_at: null,
    },
  });

  if (status === "needs_review") {
    await emailOwner(supabase, production.userId, articleNeedsReviewEmail(production.keyword, reasons));
  }
  return status;
}

/**
 * Settles an article whose job stopped (held or failed) after validation and
 * before `settle`: as validated, with whatever the audit had already found.
 * Nothing to do when it is already settled or was never validated here.
 */
async function settleFromValidation(
  supabase: SupabaseClient,
  job: { id: string; attempts: number },
  production: ProductionContext,
  outputs: Record<string, unknown>
): Promise<void> {
  const validated = outputs.validate as Partial<ValidateOutput> | undefined;
  if (production.status !== "generating" || !validated?.canonical) return;
  const audit = (outputs.audit ?? {}) as Partial<AuditOutput>;
  await settle(
    supabase,
    job,
    production,
    {
      canonical: withAuditMetadata(validated.canonical, audit),
      issues: validated.issues ?? [],
      findings: audit.actionable ?? [],
    },
    null
  );
}
