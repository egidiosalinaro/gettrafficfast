import type { SupabaseClient } from "@supabase/supabase-js";
import * as Sentry from "@sentry/nextjs";
import { IntegrationRow } from "@/lib/integrations/types";
import { resolveAdapter } from "@/lib/publishing/registry";
import { buildQualityReport, runContentPipeline } from "./pipeline";
import { logDelivery, logPipelineRun, truncateDeep } from "./trace";
import { slugify } from "./text";
import { CanonicalArticle, PipelineDecision, PipelineIssue } from "./types";

/**
 * Publishing policy for the content platform.
 *
 * Generation now belongs to the `produce-article` workflow (lib/jobs), which is
 * durable and resumable. What remains here is everything about getting a
 * validated document out of the platform: the cron and "Publish now" both go
 * through these functions, so "never deliver an unvalidated document" is
 * enforced in exactly one place.
 */

export interface StoredArticleRow {
  id: string;
  keyword_id: string;
  content: string | null;
  canonical: unknown;
  scheduled_date: string | null;
  status: string;
}

/**
 * Returns the article's Canonical document, deriving and storing it on demand
 * for rows created before the pipeline existed. Legacy content goes through
 * exactly the same stages and gates — there is no "trusted" back door.
 */
export async function ensureCanonical(params: {
  supabase: SupabaseClient;
  article: StoredArticleRow;
  keyword: string;
}): Promise<{ article: CanonicalArticle | null; decision: PipelineDecision; issues: PipelineIssue[] }> {
  const { supabase, article, keyword } = params;

  const stored = article.canonical as CanonicalArticle | null;
  if (stored && typeof stored === "object" && typeof stored.bodyHtml === "string") {
    return { article: stored, decision: "publish", issues: [] };
  }

  const raw = article.content ?? "";
  const result = runContentPipeline({
    raw,
    articleId: article.id,
    keyword,
    slug: slugify(keyword),
    language: "en",
    scheduledDate: article.scheduled_date,
  });
  logPipelineRun({ articleId: article.id, keyword }, result);

  if (result.article) {
    await supabase
      .from("articles")
      .update({
        canonical: result.article,
        quality_report: buildQualityReport(result),
        updated_at: new Date().toISOString(),
      })
      .eq("id", article.id);
  }

  return { article: result.article, decision: result.decision, issues: result.issues };
}

export type PublishOutcome =
  | { ok: true; url: string; externalId: string }
  | { ok: false; error: string };

/**
 * Delivers a Canonical Article to a destination and records the attempt.
 * Callers must pass an article that already passed the quality gates — this is
 * the only way content leaves the platform.
 */
export async function publishArticle(params: {
  supabase: SupabaseClient;
  articleId: string;
  userId: string;
  /** The site this article belongs to; recorded on the delivery attempt. */
  businessId?: string | null;
  keywordId: string;
  canonical: CanonicalArticle;
  integration: IntegrationRow;
  jobId?: string;
  /** Destination id from a previous delivery — set on a refresh. */
  externalPostId?: string | null;
}): Promise<PublishOutcome> {
  const {
    supabase,
    articleId,
    userId,
    businessId = null,
    keywordId,
    canonical,
    integration,
    jobId,
  } = params;
  const now = new Date().toISOString();

  try {
    const adapter = resolveAdapter(integration);
    const delivery = await adapter.deliver(canonical, {
      externalId: params.externalPostId ?? null,
    });

    logDelivery(
      { articleId, jobId },
      {
        adapter: adapter.type,
        ok: true,
        url: delivery.url,
        payload: delivery.payload,
        response: delivery.response,
      }
    );

    await supabase
      .from("articles")
      .update({
        status: "published",
        published_url: delivery.url,
        external_post_id: delivery.externalId,
        last_error: null,
        updated_at: now,
      })
      .eq("id", articleId);

    await supabase
      .from("integrations")
      .update({ status: "connected", last_error: null, last_sync_at: now })
      .eq("id", integration.id);

    if (keywordId) {
      await supabase.from("keywords").update({ status: "published" }).eq("id", keywordId);
    }

    await supabase.from("publish_attempts").insert({
      article_id: articleId,
      user_id: userId,
      business_id: businessId,
      integration_id: integration.id,
      integration_type: integration.type,
      ok: true,
      published_url: delivery.url,
      payload: truncateDeep(delivery.payload, 2000),
      response: truncateDeep(delivery.response, 2000),
    });

    return { ok: true, url: delivery.url, externalId: delivery.externalId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    logDelivery({ articleId, jobId }, { adapter: integration.type, ok: false, error: message });
    Sentry.captureException(err, {
      tags: { stage: "publish", integration_type: integration.type },
      extra: { article_id: articleId, job_id: jobId },
    });

    await supabase
      .from("articles")
      .update({ last_error: `publish: ${message}`.slice(0, 2000), updated_at: now })
      .eq("id", articleId);

    await supabase
      .from("integrations")
      .update({ status: "error", last_error: message.slice(0, 2000) })
      .eq("id", integration.id);

    await supabase.from("publish_attempts").insert({
      article_id: articleId,
      user_id: userId,
      business_id: businessId,
      integration_id: integration.id,
      integration_type: integration.type,
      ok: false,
      error: message.slice(0, 2000),
    });

    return { ok: false, error: message };
  }
}
